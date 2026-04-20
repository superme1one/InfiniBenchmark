const fs = require("fs");
const path = require("path");
const {
    DEFAULT_CONFIG,
    appendJsonl,
    askModel,
    buildSummaryPayload,
    createStatsTracker,
    ensureDir,
    extractTail,
    formatMs,
    getDatasetPath,
    getGpuStats,
    normalizeNumberString,
    parseLastNumber,
    sleep,
    startGpuMonitor,
    updateStatsTracker,
    writeAllTestSummary,
} = require("./common_v1");

const LIMIT = Number(process.env.GSM8K_LIMIT || 0);
const RESULT_DIR = DEFAULT_CONFIG.resultDir;
const GENERATION_STOP = ["Question:", "\nQuestion:", "\n\nQuestion:"];
const QA_STOP = ["Q:", "\nQ:", "\n\nQ:"];

function extractExpected(answerText) {
    const match = String(answerText || "").match(/####\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)/);
    return match ? Number(normalizeNumberString(match[1])) : NaN;
}

function extractPrediction(output) {
    const tail = extractTail(output);
    const patterns = [
        /final_num\s*=\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)/i,
        /####\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)/,
        /(?:the\s+)?answer\s+is\s*[^\d-]*(-?\d+(?:,\d{3})*(?:\.\d+)?)/i,
        /answer\s*[:=]\s*[^\d-]*(-?\d+(?:,\d{3})*(?:\.\d+)?)/i,
        /final answer\s*[:=]\s*[^\d-]*(-?\d+(?:,\d{3})*(?:\.\d+)?)/i,
        /\\boxed\{(-?\d+(?:,\d{3})*(?:\.\d+)?)\}/,
    ];

    for (const pattern of patterns) {
        const match = tail.match(pattern) || String(output || "").match(pattern);
        if (match) {
            return Number(normalizeNumberString(match[1]));
        }
    }

    const unfinishedEquation = tail.match(/([0-9+\-*/().,\s]+)=\s*$/);
    if (unfinishedEquation) {
        const expr = unfinishedEquation[1].replace(/,/g, "").trim();
        if (/^[0-9+\-*/().\s]+$/.test(expr) && /[+\-*/]/.test(expr)) {
            try {
                const value = Function(`"use strict"; return (${expr});`)();
                if (typeof value === "number" && Number.isFinite(value)) {
                    return value;
                }
            } catch (_error) {
                // Ignore malformed arithmetic and continue with fallback extraction.
            }
        }
    }

    const equationMatches = [...tail.matchAll(/=\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)/g)];
    if (equationMatches.length > 0) {
        const lastEquation = equationMatches[equationMatches.length - 1][1];
        return Number(normalizeNumberString(lastEquation));
    }

    const lines = tail
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (/^(step|question|explain|reasoning)\b/i.test(line)) continue;

        const exact = line.match(/^-?\d+(?:,\d{3})*(?:\.\d+)?$/);
        if (exact) {
            return Number(normalizeNumberString(exact[0]));
        }

        const keywordAnswer = line.match(/(?:therefore|thus|so|total|profit|makes?|costs?)\D*(-?\d+(?:,\d{3})*(?:\.\d+)?)/i);
        if (keywordAnswer) {
            return Number(normalizeNumberString(keywordAnswer[1]));
        }
    }

    return parseLastNumber(tail);
}

function buildPrimaryPrompt(question) {
    return [
        "You are a careful math solver.",
        `Question: ${question}`,
        "Answer:",
    ].join("\n");
}

function buildFallbackPrompt(question) {
    return [
        `Q: ${question}`,
        "A:",
    ].join("\n");
}

function buildShortPrompt(question) {
    return [
        `Question: ${question}`,
        "Return only the final number.",
    ].join("\n");
}

function buildVerifyPrompt(question, draftOutput) {
    return [
        `Question: ${question}`,
        "",
        "A previous draft answer was:",
        draftOutput || "(empty)",
        "",
        "Recalculate carefully from the original question.",
        "Give a short corrected solution.",
        "End with: The answer is <number>.",
    ].join("\n");
}

async function askGsm8k(question) {
    try {
        return await askModel(buildPrimaryPrompt(question), {
            maxTokens: 160,
            temperature: 0,
            stop: GENERATION_STOP,
        });
    } catch (primaryError) {
        try {
            return await askModel(buildFallbackPrompt(question), {
                maxTokens: 120,
                temperature: 0,
                stop: QA_STOP,
            });
        } catch (fallbackError1) {
            try {
                return await askModel(buildShortPrompt(question), {
                    maxTokens: 24,
                    temperature: 0,
                    stop: ["\n"],
                });
            } catch (fallbackError2) {
                throw new Error(
                    `${primaryError.message} || fallback1: ${fallbackError1.message} || fallback2: ${fallbackError2.message}`
                );
            }
        }
    }
}

function needsVerification(output, prediction) {
    const text = String(output || "").trim();
    if (!text) return true;
    if (Number.isNaN(prediction)) return true;
    return false;
}

async function verifyGsm8k(question, draftOutput) {
    return await askModel(buildVerifyPrompt(question, draftOutput), {
        maxTokens: 80,
        temperature: 0,
        stop: GENERATION_STOP,
    });
}

function logProgress(index, total, tracker, prediction, expected, inferenceTimeMs, endpoint, error, gpu) {
    const acc = index <= 0 ? 0 : (tracker.correct / index) * 100;
    const avgMs = index <= 0 ? 0 : tracker.totalInferenceTimeMs / index;
    const status = error ? "ERROR" : Math.abs(Number(prediction) - Number(expected)) < 1e-6 ? "OK" : "FAIL";
    const endpointText = endpoint ? endpoint.replace("http://", "") : "-";
    const gpuText = gpu
        ? ` gpu=${gpu.gpuUtilization}% mem=${gpu.memoryUsedMB}/${gpu.memoryTotalMB}MB`
        : "";
    console.log(
        `[GSM8K_V1] ${index}/${total} ${status} acc=${acc.toFixed(2)}% ` +
        `pred=${String(prediction)} gold=${String(expected)} time=${formatMs(inferenceTimeMs)} avg=${formatMs(avgMs)} ` +
        `endpoint=${endpointText}${gpuText}${error ? ` error=${error}` : ""}`
    );
}

async function main() {
    ensureDir(RESULT_DIR);
    const datasetPath = getDatasetPath("GSM8k", "test.jsonl");
    const resultPath = path.join(RESULT_DIR, "gsm8k_v1.jsonl");
    fs.writeFileSync(resultPath, "", "utf-8");

    let dataset = fs.readFileSync(datasetPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));

    if (LIMIT > 0) {
        dataset = dataset.slice(0, LIMIT);
    }

    const tracker = createStatsTracker("GSM8K_V1", dataset.length);
    const gpuMonitor = startGpuMonitor(tracker);
    let stopping = false;

    const flushSummary = async status => {
        const gpu = await getGpuStats();
        if (gpu) tracker.lastGpu = gpu;
        writeAllTestSummary("GSM8K_V1", buildSummaryPayload(tracker, status));
    };

    process.on("SIGINT", async () => {
        if (stopping) return;
        stopping = true;
        console.log("\n[GSM8K_V1] interrupted, writing summary...");
        await gpuMonitor.stop();
        await flushSummary("interrupted");
        process.exit(130);
    });

    for (let index = 0; index < dataset.length; index++) {
        const item = dataset[index];
        const expected = extractExpected(item.answer);

        process.stdout.write(`\r[GSM8K_V1] ${index + 1}/${dataset.length}`);

        let output = "";
        let error = null;
        let inferenceTimeMs = 0;
        let endpoint = "";

        try {
            const result = await askGsm8k(item.question);
            output = result.output;
            inferenceTimeMs = result.inferenceTimeMs;
            endpoint = result.endpoint;
        } catch (err) {
            error = err.message;
        }

        let prediction = error ? NaN : extractPrediction(output);

        if (!error && needsVerification(output, prediction)) {
            try {
                const verified = await verifyGsm8k(item.question, output);
                output = `${output}\n\n[verified]\n${verified.output}`;
                inferenceTimeMs += verified.inferenceTimeMs;
                endpoint = verified.endpoint;
                prediction = extractPrediction(verified.output);
            } catch (verifyError) {
                error = verifyError.message;
                prediction = NaN;
            }
        }

        const correct = !Number.isNaN(prediction) && !Number.isNaN(expected) && Math.abs(prediction - expected) < 1e-6;
        const gpu = await getGpuStats();

        updateStatsTracker(tracker, {
            correct,
            error,
            inferenceTimeMs,
            gpu,
        });

        appendJsonl(resultPath, {
            id: index + 1,
            question: item.question,
            prediction,
            expected,
            correct,
            inferenceTimeMs,
            endpoint,
            gpu,
            error,
            output,
        });

        await flushSummary("running");
        logProgress(index + 1, dataset.length, tracker, prediction, expected, inferenceTimeMs, endpoint, error, gpu);

        if (DEFAULT_CONFIG.cooldownMs > 0 && index < dataset.length - 1) {
            await sleep(DEFAULT_CONFIG.cooldownMs);
        }
    }

    const accuracy = dataset.length === 0 ? 0 : (tracker.correct / dataset.length) * 100;
    appendJsonl(resultPath, {
        summary: true,
        total: dataset.length,
        correct: tracker.correct,
        accuracy: `${accuracy.toFixed(2)}%`,
    });
    await gpuMonitor.stop();
    await flushSummary("completed");
    console.log(`\r[GSM8K_V1] finished ${accuracy.toFixed(2)}% (${tracker.correct}/${dataset.length})`);
}

main().catch(err => {
    console.error("GSM8k_V1 failed:", err);
    process.exitCode = 1;
});
