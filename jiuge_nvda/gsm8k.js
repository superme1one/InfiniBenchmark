const fs = require("fs");
const path = require("path");
const {
    DEFAULT_CONFIG,
    appendJsonl,
    askModel,
    buildSummaryPayload,
    createStatsTracker,
    ensureDir,
    formatMs,
    getDatasetPath,
    getGpuStats,
    sleep,
    startGpuMonitor,
    updateStatsTracker,
    writeAllTestSummary,
} = require("./common_v1");

const LIMIT = Number(process.env.GSM8K_LIMIT || 0);
const RESULT_DIR = DEFAULT_CONFIG.resultDir;
const GSM8K_MAX_TOKENS = Number(process.env.GSM8K_MAX_TOKENS || 2048);
const GSM8K_TEMPERATURE = Number(process.env.GSM8K_TEMPERATURE || 0.1);
const GENERATION_STOP = ["\nQuestion:", "\n\nQuestion:"];

function extractExpected(answerText) {
    const match = String(answerText || "").match(/####\s*(-?[\d,.]+)/);
    return match ? Number(match[1].replace(/,/g, "")) : NaN;
}

function cleanOutput(output) {
    let cleanText = String(output || "")
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .trim();

    const thinkIndex = cleanText.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = cleanText.slice(thinkIndex + 8).trim();
    }

    return cleanText;
}

function extractPrediction(output) {
    const cleanText = cleanOutput(output);
    if (!cleanText) return NaN;

    const patterns = [
        /####\s*(-?[\d,.]+)/,
        /Answer:\s*(-?[\d,.]+)/i,
        /The answer is\s*(-?[\d,.]+)/i,
        /\\boxed\{\s*(-?[\d,.]+)\s*\}/,
    ];

    for (const pattern of patterns) {
        const match = cleanText.match(pattern);
        if (match) {
            return Number(match[1].replace(/,/g, ""));
        }
    }

    const lines = cleanText
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
        const exact = lines[i].match(/^-?[\d,.]+$/);
        if (exact) {
            return Number(exact[0].replace(/,/g, ""));
        }
    }

    const allNumbers = cleanText.match(/-?[\d,.]+/g);
    if (allNumbers && allNumbers.length > 0) {
        return Number(allNumbers[allNumbers.length - 1].replace(/,/g, ""));
    }

    return NaN;
}

function buildPrimaryPrompt(question) {
    return `
You are a math expert.

Question:
${question}

Instructions:
1. Think step-by-step to solve the problem.
2. Be concise but show your calculation clearly.
3. You MUST end your response with: "#### <final_number>"
   Example:
   ... reasoning ...
   #### 42

Response:
`.trim();
}

async function askGsm8k(question) {
    return await askModel(buildPrimaryPrompt(question), {
        maxTokens: GSM8K_MAX_TOKENS,
        temperature: GSM8K_TEMPERATURE,
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

        const prediction = error ? NaN : extractPrediction(output);
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
