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
    sleep,
    startGpuMonitor,
    updateStatsTracker,
    writeAllTestSummary,
} = require("./common_v1");

const LIMIT = Number(process.env.TRIVIAQA_LIMIT || 0);
const RESULT_DIR = DEFAULT_CONFIG.resultDir;

function buildPrompt(question) {
    return [
        "Answer the trivia question as concisely as possible.",
        "",
        `Question: ${question}`,
        "",
        "Return only the final short answer.",
        "Answer:",
    ].join("\n");
}

function extractPrediction(output) {
    const tail = extractTail(output);
    const match = tail.match(/answer\s*[:：]\s*(.+)$/im);
    if (match) return match[1].trim().split(/\r?\n/)[0].trim();

    const lines = tail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return lines.length > 0 ? lines[0] : "";
}

function isCorrect(expectedAliases, prediction) {
    if (!prediction) return false;
    const normalizedPrediction = normalizeText(prediction);

    return expectedAliases.some(alias => {
        const normalizedAlias = normalizeText(alias);
        return normalizedPrediction === normalizedAlias ||
            normalizedPrediction.includes(normalizedAlias) ||
            normalizedAlias.includes(normalizedPrediction);
    });
}

function logProgress(index, total, tracker, prediction, expectedAliases, inferenceTimeMs, endpoint, error, gpu) {
    const acc = index <= 0 ? 0 : (tracker.correct / index) * 100;
    const avgMs = index <= 0 ? 0 : tracker.totalInferenceTimeMs / index;
    const endpointText = endpoint ? endpoint.replace("http://", "") : "-";
    const gpuText = gpu
        ? ` gpu=${gpu.gpuUtilization}% mem=${gpu.memoryUsedMB}/${gpu.memoryTotalMB}MB`
        : "";
    console.log(
        `[TriviaQA_V1] ${index}/${total} ${error ? "ERROR" : "DONE"} acc=${acc.toFixed(2)}% ` +
        `pred=${String(prediction).slice(0, 40)} gold=${String(expectedAliases[0] || "").slice(0, 40)} ` +
        `time=${formatMs(inferenceTimeMs)} avg=${formatMs(avgMs)} endpoint=${endpointText}${gpuText}${error ? ` error=${error}` : ""}`
    );
}

async function main() {
    ensureDir(RESULT_DIR);
    const datasetPath = getDatasetPath("TriviaQA", "verified-web-dev.json");
    const resultPath = path.join(RESULT_DIR, "triviaqa_v1.jsonl");
    fs.writeFileSync(resultPath, "", "utf-8");

    const raw = JSON.parse(fs.readFileSync(datasetPath, "utf-8"));
    let dataset = raw.Data || raw;
    if (LIMIT > 0) {
        dataset = dataset.slice(0, LIMIT);
    }

    const tracker = createStatsTracker("TriviaQA_V1", dataset.length);
    const gpuMonitor = startGpuMonitor(tracker);
    let stopping = false;

    const flushSummary = async status => {
        const gpu = await getGpuStats();
        if (gpu) tracker.lastGpu = gpu;
        writeAllTestSummary("TriviaQA_V1", buildSummaryPayload(tracker, status));
    };

    process.on("SIGINT", async () => {
        if (stopping) return;
        stopping = true;
        console.log("\n[TriviaQA_V1] interrupted, writing summary...");
        await gpuMonitor.stop();
        await flushSummary("interrupted");
        process.exit(130);
    });

    for (let index = 0; index < dataset.length; index++) {
        const item = dataset[index];
        const expectedAliases = item.Answer?.NormalizedAliases || item.Answer?.Aliases || [];

        process.stdout.write(`\r[TriviaQA_V1] ${index + 1}/${dataset.length}`);

        let output = "";
        let error = null;
        let inferenceTimeMs = 0;
        let endpoint = "";

        try {
            const result = await askModel(buildPrompt(item.Question), {
                maxTokens: 32,
                temperature: 0,
                stop: ["\n", "\n\nQuestion:", "\nQuestion:", "\nAnswer:"],
            });
            output = result.output;
            inferenceTimeMs = result.inferenceTimeMs;
            endpoint = result.endpoint;
        } catch (err) {
            error = err.message;
        }

        const prediction = error ? "" : extractPrediction(output);
        const correct = !error && isCorrect(expectedAliases, prediction);
        const gpu = await getGpuStats();

        updateStatsTracker(tracker, {
            correct,
            error,
            inferenceTimeMs,
            gpu,
        });

        appendJsonl(resultPath, {
            id: index + 1,
            question: item.Question,
            prediction,
            expected: expectedAliases,
            correct,
            inferenceTimeMs,
            endpoint,
            gpu,
            error,
            output,
        });

        await flushSummary("running");
        logProgress(index + 1, dataset.length, tracker, prediction, expectedAliases, inferenceTimeMs, endpoint, error, gpu);

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
    console.log(`\r[TriviaQA_V1] finished ${accuracy.toFixed(2)}% (${tracker.correct}/${dataset.length})`);
}

main().catch(err => {
    console.error("TriviaQA_V1 failed:", err);
    process.exitCode = 1;
});
