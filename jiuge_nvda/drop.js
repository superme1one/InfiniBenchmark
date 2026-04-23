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
 
const LIMIT = Number(process.env.DROP_LIMIT || 0);
const RESULT_DIR = DEFAULT_CONFIG.resultDir;
const DROP_MAX_TOKENS = Number(process.env.DROP_MAX_TOKENS || 128);
const DROP_STRICT_MAX_TOKENS = Number(process.env.DROP_STRICT_MAX_TOKENS || 48);
const DROP_TEMPERATURE = Number(process.env.DROP_TEMPERATURE || 0);
const PRIMARY_STOP = [
    "\nPassage:",
    "\nQuestion:",
    "\nRequirements:",
    "\nInstructions:",
    "\nFormat:",
    "\nExample:",
    "\nYou are",
    "\n\nPassage:",
    "\n\nQuestion:",
    "\n\nRequirements:",
    "\n\nInstructions:",
    "\n\nYou are",
];

function hasNumberType(types) {
    return Array.isArray(types) && types.some(type => String(type).toLowerCase() === "number");
}

function buildPrimaryPrompt(passage, question, expectsNumber) {
    const answerRule = expectsNumber
        ? "The answer must be a number. Use digits only and keep decimals if needed. Do not add units."
        : "The answer must be a short span copied or paraphrased from the passage. Do not answer with a full explanation.";

    return `
You are an expert in reading comprehension and arithmetic.

Use only the passage to answer the question.

Passage:
${passage}

Question:
${question}

Requirements:
1. Answer only this question.
2. Do not output multiple candidate answers.
3. Do not repeat the passage, question, instructions, or any examples.
4. ${answerRule}
5. End with exactly one final line in this format: Answer: <final answer>
6. Do not output anything after the final answer.
`.trim();
}

function buildStrictPrompt(passage, question, expectsNumber) {
    return expectsNumber
        ? [
            `Passage:\n${passage}`,
            `Question:\n${question}`,
            "Return only the final number. No words. No units. No explanation.",
            "Answer:",
        ].join("\n\n")
        : [
            `Passage:\n${passage}`,
            `Question:\n${question}`,
            "Return only the shortest final answer phrase from the passage. No explanation.",
            "Answer:",
        ].join("\n\n");
}

function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .trim();
}

function stripAnswerPrefix(value) {
    let text = String(value || "").trim();
    while (/^Answer\s*:/i.test(text)) {
        text = text.replace(/^Answer\s*:\s*/i, "").trim();
    }
    return text;
}

function normalizeCandidate(value) {
    return stripAnswerPrefix(value)
        .replace(/^[\s"'()[\]<>.,!?;:]+|[\s"'()[\]<>.,!?;:]+$/g, "")
        .trim();
}

function isMetaLine(line) {
    return (
        /^(passage|question|requirements|instructions|format|response)\s*:/i.test(line) ||
        /^you are\b/i.test(line) ||
        /^example\s*:?$/i.test(line) ||
        /^thought process\s*:?$/i.test(line) ||
        /^\.\.\.\s*thinking\s*\.\.\.$/i.test(line)
    );
}

function extractAnswerCandidates(rawOutput) {
    let cleanText = cleanModelOutput(rawOutput);
    const thinkIndex = cleanText.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        const tail = cleanText.slice(thinkIndex + 8).trim();
        cleanText = tail || cleanText;
    }

    const candidates = [];
    const seen = new Set();
    const pushCandidate = value => {
        const normalized = normalizeCandidate(value);
        if (!normalized || isMetaLine(normalized)) return;
        const dedupeKey = normalized.toLowerCase();
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        candidates.push(normalized);
    };

    const answerPatterns = [
        /The final answer is\s*:\s*([^\r\n]*)/gi,
        /The answer is\s*:\s*([^\r\n]*)/gi,
        /Final answer is\s*:\s*([^\r\n]*)/gi,
        /Final answer\s*:\s*([^\r\n]*)/gi,
        /Answer\s*:\s*([^\r\n]*)/gi,
    ];

    for (const pattern of answerPatterns) {
        for (const match of cleanText.matchAll(pattern)) {
            pushCandidate(match[1]);
        }
    }

    if (candidates.length === 0) {
        const lines = cleanText
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .filter(line => !isMetaLine(line));

        for (const line of lines) {
            pushCandidate(line);
        }
    }

    return candidates;
}

function parseNumericValue(value) {
    const cleaned = String(value || "").replace(/,/g, "");
    const match = cleaned.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
}

function refineSpanPrediction(prediction, question) {
    const candidate = normalizeCandidate(prediction);
    if (!candidate) return "";

    if (/^who\b/i.test(String(question || "").trim())) {
        const head = candidate
            .split(/\b(?:caught|scored|threw|kicked|made|had|was|were|is|are|won|led|tied|returned|recorded|completed|ran|rushed|finished|thrown)\b/i)[0]
            .trim();
        if (head && head.length < candidate.length && head.split(/\s+/).length <= 6) {
            return normalizeCandidate(head);
        }
    }

    return candidate;
}

function countAnswerMarkers(rawOutput) {
    const cleanText = cleanModelOutput(rawOutput);
    const patterns = [
        /The final answer is\s*:\s*[^\r\n]*/gi,
        /The answer is\s*:\s*[^\r\n]*/gi,
        /Final answer is\s*:\s*[^\r\n]*/gi,
        /Final answer\s*:\s*[^\r\n]*/gi,
        /Answer\s*:\s*[^\r\n]*/gi,
    ];

    return patterns.reduce((sum, pattern) => sum + [...cleanText.matchAll(pattern)].length, 0);
}

function selectPrediction(rawOutput, expectsNumber, question) {
    const candidates = extractAnswerCandidates(rawOutput);
    if (candidates.length === 0) return "";
    const hasExplicitAnswerMarker = countAnswerMarkers(rawOutput) > 0;

    if (expectsNumber) {
        const orderedCandidates = hasExplicitAnswerMarker ? [...candidates].reverse() : candidates;
        for (const candidate of orderedCandidates) {
            const value = parseNumericValue(candidate);
            if (!Number.isNaN(value)) {
                return String(value);
            }
        }
    } else {
        const orderedCandidates = hasExplicitAnswerMarker ? [...candidates].reverse() : candidates;
        for (const rawCandidate of orderedCandidates) {
            const candidate = refineSpanPrediction(rawCandidate, question);
            if (!candidate) continue;
            if (candidate.length > 120) continue;
            if (/^(cannot be determined|unknown|not provided)$/i.test(candidate)) continue;
            return candidate;
        }
    }

    return candidates[candidates.length - 1];
}

function needsRetry(rawOutput, prediction, expectsNumber) {
    const cleanText = cleanModelOutput(rawOutput);
    const answerCount = countAnswerMarkers(cleanText);

    if (!prediction) return true;
    if (answerCount === 0) return true;
    if (answerCount > 1) return true;
    if (/Example\s*:|^\s*\.\.\.\s*thinking\s*\.\.\.\s*$/im.test(cleanText)) return true;

    if (expectsNumber) {
        return Number.isNaN(parseNumericValue(prediction));
    }

    return (
        prediction.length > 120 ||
        /^answer\s*:/i.test(prediction) ||
        /passage\s*:|question\s*:/i.test(prediction)
    );
}

function normalizeTextAnswer(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, "\"")
        .replace(/[-/]/g, " ")
        .replace(/[.,!?;:%"]/g, " ")
        .replace(/\b(a|an|the)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function matchesExpected(expectedList, prediction, expectsNumber) {
    if (!prediction || !Array.isArray(expectedList) || expectedList.length === 0) {
        return false;
    }

    if (expectsNumber) {
        const predictedNumber = parseNumericValue(prediction);
        return expectedList.some(expected => {
            const expectedNumber = parseNumericValue(expected);
            return !Number.isNaN(predictedNumber) &&
                !Number.isNaN(expectedNumber) &&
                Math.abs(predictedNumber - expectedNumber) < 1e-6;
        });
    }

    const normalizedPrediction = normalizeTextAnswer(prediction);
    return expectedList.some(expected => {
        const normalizedExpected = normalizeTextAnswer(expected);
        if (!normalizedExpected) return false;
        return normalizedPrediction === normalizedExpected ||
            normalizedPrediction.includes(normalizedExpected);
    });
}

async function askDrop(passage, question, expectsNumber) {
    const primaryResult = await askModel(buildPrimaryPrompt(passage, question, expectsNumber), {
        maxTokens: DROP_MAX_TOKENS,
        temperature: DROP_TEMPERATURE,
        stop: PRIMARY_STOP,
    });

    const primaryPrediction = selectPrediction(primaryResult.output, expectsNumber, question);
    if (!needsRetry(primaryResult.output, primaryPrediction, expectsNumber)) {
        return {
            ...primaryResult,
            prediction: primaryPrediction,
            strategy: "primary",
        };
    }

    try {
        const strictResult = await askModel(buildStrictPrompt(passage, question, expectsNumber), {
            maxTokens: DROP_STRICT_MAX_TOKENS,
            temperature: 0,
            stop: ["\n\n", "\nPassage:", "\nQuestion:"],
        });
        const strictPrediction = selectPrediction(strictResult.output, expectsNumber, question);

        if (strictPrediction) {
            return {
                ...strictResult,
                prediction: strictPrediction,
                strategy: "strict_retry",
                primaryOutput: primaryResult.output,
            };
        }
    } catch (_retryError) {
        // Fall back to the primary result when the strict retry fails.
    }

    return {
        ...primaryResult,
        prediction: primaryPrediction,
        strategy: "primary_fallback",
    };
}

function logProgress(index, total, tracker, prediction, expected, correct, inferenceTimeMs, endpoint, error, gpu, strategy) {
    const acc = index <= 0 ? 0 : (tracker.correct / index) * 100;
    const avgMs = index <= 0 ? 0 : tracker.totalInferenceTimeMs / index;
    const status = error ? "ERROR" : correct ? "OK" : "FAIL";
    const endpointText = endpoint ? endpoint.replace("http://", "") : "-";
    const gpuText = gpu
        ? ` gpu=${gpu.gpuUtilization}% mem=${gpu.memoryUsedMB}/${gpu.memoryTotalMB}MB`
        : "";
    const strategyText = strategy ? ` strategy=${strategy}` : "";
    console.log(
        `[DROP_V1] ${index}/${total} ${status} acc=${acc.toFixed(2)}% ` +
        `pred=${String(prediction).slice(0, 40)} gold=${String(expected[0] || "").slice(0, 40)} ` +
        `time=${formatMs(inferenceTimeMs)} avg=${formatMs(avgMs)} endpoint=${endpointText}${gpuText}${strategyText}${error ? ` error=${error}` : ""}`
    );
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
        const expectsNumber = hasNumberType(item.answers_spans?.types || []);

        process.stdout.write(`\r[DROP_V1] ${index + 1}/${dataset.length}`);

        let output = "";
        let error = null;
        let inferenceTimeMs = 0;
        let endpoint = "";
        let prediction = "";
        let strategy = "";
        let primaryOutput = "";

        try {
            const result = await askDrop(item.passage, item.question, expectsNumber);
            output = result.output;
            inferenceTimeMs = result.inferenceTimeMs;
            endpoint = result.endpoint;
            prediction = result.prediction || "";
            strategy = result.strategy || "";
            primaryOutput = result.primaryOutput || "";
        } catch (err) {
            error = err.message;
        }

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
            type: expectsNumber ? "number" : "span",
            expected: expectedList,
            prediction,
            correct,
            inferenceTimeMs,
            endpoint,
            gpu,
            error,
            strategy,
            output,
            primaryOutput,
        });

        await flushSummary("running");
        logProgress(
            index + 1,
            dataset.length,
            tracker,
            prediction,
            expectedList,
            correct,
            inferenceTimeMs,
            endpoint,
            error,
            gpu,
            strategy
        );

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
