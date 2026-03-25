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
    normalizeText,
    parseLastNumber,
    sleep,
    startGpuMonitor,
    updateStatsTracker,
    writeAllTestSummary,
} = require("./common_v1");

const LIMIT = Number(process.env.DROP_LIMIT || 0);
const RESULT_DIR = DEFAULT_CONFIG.resultDir;

function buildPrompt(passage, question, expectsNumber) {
    return [
        "Read the passage and answer the question.",
        "",
        `Passage:\n${passage}`,
        "",
        `Question:\n${question}`,
        "",
        expectsNumber
            ? "Return only the final number."
            : "Return only the short final answer phrase, not a full sentence.",
        "Answer:",
    ].join("\n");
}

function extractPrediction(output) {
    const tail = extractTail(output);
    const match = tail.match(/answer\s*[:：]\s*(.+)$/im);
    if (match) {
        return match[1].trim().split(/\r?\n/)[0].trim();
    }

    const lines = tail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines[0] : "";
}

function matchesExpected(expectedList, prediction, expectsNumber) {
    if (!prediction) return false;

    if (expectsNumber) {
        const predNum = parseLastNumber(prediction);
        return expectedList.some(item => {
            const goldNum = Number(String(item).replace(/,/g, ""));
            return !Number.isNaN(predNum) && !Number.isNaN(goldNum) && Math.abs(predNum - goldNum) < 1e-6;
        });
    }

    const normalizedPrediction = normalizeText(prediction);
    return expectedList.some(item => {
        const normalizedGold = normalizeText(item)
            .replace(/\byards?\b/g, "yard")
            .replace(/-/g, " ")
            .trim();
        const normalizedPred = normalizedPrediction
            .replace(/\byards?\b/g, "yard")
            .replace(/-/g, " ")
            .trim();
        return normalizedPred === normalizedGold ||
            normalizedPred.includes(normalizedGold) ||
            normalizedGold.includes(normalizedPred);
    });
}

function logProgress(index, total, tracker, prediction, expected, inferenceTimeMs, endpoint, error, gpu) {
    const acc = index <= 0 ? 0 : (tracker.correct / index) * 100;
    const avgMs = index <= 0 ? 0 : tracker.totalInferenceTimeMs / index;
    const status = error ? "ERROR" : "DONE";
    const endpointText = endpoint ? endpoint.replace("http://", "") : "-";
    const gpuText = gpu
        ? ` gpu=${gpu.gpuUtilization}% mem=${gpu.memoryUsedMB}/${gpu.memoryTotalMB}MB`
        : "";
    console.log(
        `[DROP_V1] ${index}/${total} ${status} acc=${acc.toFixed(2)}% ` +
        `pred=${String(prediction).slice(0, 40)} gold=${String(expected[0] || "").slice(0, 40)} ` +
        `time=${formatMs(inferenceTimeMs)} avg=${formatMs(avgMs)} endpoint=${endpointText}${gpuText}${error ? ` error=${error}` : ""}`
    );
}

async function askDrop(passage, question, expectsNumber) {
    const primaryPrompt = buildPrompt(passage, question, expectsNumber);
    const primaryStop = expectsNumber
        ? ["\n", "\n\nQuestion:", "\nQuestion:", "\nPassage:", "\n\nPassage:"]
        : ["\n\nQuestion:", "\nQuestion:", "\nPassage:", "\n\nPassage:"];

    try {
        return await askModel(primaryPrompt, {
            maxTokens: expectsNumber ? 24 : 48,
            temperature: 0,
            stop: primaryStop,
        });
    } catch (primaryError) {
        const fallbackPrompt1 = [
            `Passage:\n${passage}`,
            `Question:\n${question}`,
            expectsNumber
                ? "Reply with digits only."
                : "Reply with only the answer phrase. No explanation.",
            "Answer:",
        ].join("\n");

        try {
            return await askModel(fallbackPrompt1, {
                maxTokens: expectsNumber ? 16 : 24,
                temperature: 0,
                stop: expectsNumber ? ["\n"] : [],
            });
        } catch (fallbackError1) {
            const fallbackPrompt2 = expectsNumber
                ? `Question: ${question}\nReturn digits only.\nAnswer:`
                : `Question: ${question}\nReturn only the entity or phrase.\nAnswer:`;

            try {
                return await askModel(fallbackPrompt2, {
                    maxTokens: expectsNumber ? 12 : 20,
                    temperature: 0,
                    stop: expectsNumber ? ["\n"] : [],
                });
            } catch (fallbackError2) {
                throw new Error(
                    `${primaryError.message} || fallback1: ${fallbackError1.message} || fallback2: ${fallbackError2.message}`
                );
            }
        }
    }
}

async function main() {
    ensureDir(RESULT_DIR);
    const datasetPath = getDatasetPath("DROP", "train.jsonl");
    const resultPath = path.join(RESULT_DIR, "drop_v1.jsonl");
    fs.writeFileSync(resultPath, "", "utf-8");

    let dataset = fs.readFileSync(datasetPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));

    if (LIMIT > 0) {
        dataset = dataset.slice(0, LIMIT);
    }

    const tracker = createStatsTracker("DROP_V1", dataset.length);
    const gpuMonitor = startGpuMonitor(tracker);
    let stopping = false;

    const flushSummary = async status => {
        const gpu = await getGpuStats();
        if (gpu) tracker.lastGpu = gpu;
        writeAllTestSummary("DROP_V1", buildSummaryPayload(tracker, status));
    };

    process.on("SIGINT", async () => {
        if (stopping) return;
        stopping = true;
        console.log("\n[DROP_V1] interrupted, writing summary...");
        await gpuMonitor.stop();
        await flushSummary("interrupted");
        process.exit(130);
    });

    for (let index = 0; index < dataset.length; index++) {
        const item = dataset[index];
        const expectedList = item.answers_spans?.spans || [];
        const expectsNumber = (item.answers_spans?.types || []).some(type => String(type).toLowerCase() === "number");

        process.stdout.write(`\r[DROP_V1] ${index + 1}/${dataset.length}`);

        let output = "";
        let error = null;
        let inferenceTimeMs = 0;
        let endpoint = "";

        try {
            const result = await askDrop(item.passage, item.question, expectsNumber);
            output = result.output;
            inferenceTimeMs = result.inferenceTimeMs;
            endpoint = result.endpoint;
        } catch (err) {
            error = err.message;
        }

        const prediction = error ? "" : extractPrediction(output);
        const correct = !error && matchesExpected(expectedList, prediction, expectsNumber);
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
            expected: expectedList,
            prediction,
            correct,
            expectsNumber,
            inferenceTimeMs,
            endpoint,
            gpu,
            error,
            output,
        });

        await flushSummary("running");
        logProgress(index + 1, dataset.length, tracker, prediction, expectedList, inferenceTimeMs, endpoint, error, gpu);

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
    console.log(`\r[DROP_V1] finished ${accuracy.toFixed(2)}% (${tracker.correct}/${dataset.length})`);
}

main().catch(err => {
    console.error("DROP_V1 failed:", err);
    process.exitCode = 1;
});
