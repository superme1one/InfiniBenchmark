const fs = require("fs");
const path = require("path");

/*
 * DROP unified benchmark script.
 *
 * This file keeps DROP evaluation semantics stable across different Jiuge
 * server deployments. Prompt text, extraction rules, max token defaults,
 * temperature, retry policy, and scoring are shared. Only the transport layer
 * changes by server profile or command-line arguments.
 */

// Server profiles only describe backend connectivity and payload shape.
// They must not change prompt text, extraction rules, or scoring logic.
const SERVER_PROFILES = {
    tianshu: {
        apiUrl: "http://localhost:9000/chat",
        apiType: "prompt",
        modelName: "9g_8b_thinking",
        stream: false,
    },
    muxi: {
        apiUrl: "http://172.22.162.17:8000/chat/completions",
        apiType: "chat",
        modelName: "9g_8b_thinking",
        stream: false,
    },
    moer: {
        apiUrl: "http://127.0.0.1:9501/chat/completions",
        apiType: "chat",
        modelName: "9G-8B",
        stream: false,
    },
    nvda: {
        apiUrl: "http://127.0.0.1:1145/completion",
        apiType: "completion",
        modelName: "9g_8b_thinking",
        stream: false,
    },
};

// Stop sequences reduce prompt continuation on completion-style backends.
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

const STRICT_STOP = ["\n\n", "\nPassage:", "\nQuestion:"];

// ----------------------------- CLI Parsing -----------------------------
// Minimal dependency-free argument parser supporting "--key value" and
// "--key=value". This keeps the script easy to copy between machines.
function parseArgs(argv) {
    const args = {};

    for (let i = 0; i < argv.length; i++) {
        const item = argv[i];
        if (!item.startsWith("--")) continue;

        const eqIndex = item.indexOf("=");
        if (eqIndex !== -1) {
            args[item.slice(2, eqIndex)] = item.slice(eqIndex + 1);
            continue;
        }

        const key = item.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith("--")) {
            args[key] = "true";
        } else {
            args[key] = next;
            i++;
        }
    }

    return args;
}

// Convert numeric CLI/env values while retaining safe defaults.
function toNumber(value, fallback) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

// Convert flags such as "--stream", "DROP_STREAM=true", or "1".
function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return /^(1|true|yes|y|on)$/i.test(String(value));
}

// Infer request protocol from URL when --api-type is not provided.
function inferApiType(apiUrl) {
    const lowerUrl = String(apiUrl || "").toLowerCase();
    if (lowerUrl.includes("/chat/completions")) return "chat";
    if (lowerUrl.includes("/completion")) return "completion";
    return "prompt";
}

// Printed when running "node drop.js --help".
function printUsage() {
    console.log(`
Usage:
  node drop.js --server tianshu
  node drop.js --server muxi --limit 100
  node drop.js --server moer --api-url http://127.0.0.1:9501/chat/completions
  node drop.js --api-url http://127.0.0.1:1145/completion --api-type completion

Options:
  --server <name>          Server profile: tianshu, muxi, moer, nvda. Default: tianshu
  --api-url <url>          Override profile API URL.
  --api-type <type>        Request format: prompt, chat, completion. Usually inferred from profile or URL.
  --model <name>           Model name for chat-compatible APIs.
  --limit <n>              Number of samples. Default: 100
  --max-tokens <n>         Primary request max output tokens. Default: 128
  --strict-max-tokens <n>  Strict retry max output tokens. Default: 48
  --temperature <n>        Sampling temperature. Default: 0
  --cooldown-ms <n>        Delay between samples. Default: 300
  --timeout-ms <n>         Per-request timeout. Default: 300000
  --data-file <path>       DROP JSONL file. Default: ../data_sets/DROP/train.jsonl
  --result-file <path>     Output JSONL file. Default: result/drop_<server>.jsonl
  --stream                 Enable SSE streaming for chat APIs.
  --no-retry               Disable strict retry.
  --no-stop                Do not send stop sequences.
`.trim());
}

const ARGS = parseArgs(process.argv.slice(2));

if (ARGS.help || ARGS.h) {
    printUsage();
    process.exit(0);
}

const profileName = String(ARGS.server || process.env.JIUGE_SERVER || "tianshu").toLowerCase();
const profile = SERVER_PROFILES[profileName] || {};
const apiUrl = ARGS["api-url"] || process.env.JIUGE_API_URL || profile.apiUrl;
const apiType = ARGS["api-type"] || process.env.JIUGE_API_TYPE || profile.apiType || inferApiType(apiUrl);
const safeServerName = /^[a-z0-9_-]+$/i.test(profileName) ? profileName : "custom";

// ----------------------------- Configuration -----------------------------
// Startup configuration. CLI args override env vars, env vars override profile
// defaults, and script defaults are last.
const CONFIG = {
    server: profileName,
    apiUrl,
    apiType,
    modelName: ARGS.model || process.env.JIUGE_MODEL_NAME || profile.modelName || "9g_8b_thinking",
    maxTokens: toNumber(ARGS["max-tokens"] || process.env.DROP_MAX_TOKENS, 128),
    strictMaxTokens: toNumber(ARGS["strict-max-tokens"] || process.env.DROP_STRICT_MAX_TOKENS, 48),
    temperature: toNumber(ARGS.temperature || process.env.DROP_TEMPERATURE, 0),
    topP: toNumber(ARGS["top-p"] || process.env.DROP_TOP_P, 1.0),
    topK: toNumber(ARGS["top-k"] || process.env.DROP_TOP_K, 1),
    cooldownMs: toNumber(ARGS["cooldown-ms"] || process.env.DROP_COOLDOWN_MS, 300),
    timeoutMs: toNumber(ARGS["timeout-ms"] || process.env.DROP_TIMEOUT_MS, 300000),
    limit: toNumber(ARGS.limit || process.env.DROP_LIMIT, 100),
    dataFile: ARGS["data-file"] || process.env.DROP_DATA_FILE || "../data_sets/DROP/train.jsonl",
    resultFile: ARGS["result-file"] || process.env.DROP_RESULT_FILE || path.join(__dirname, "result", `drop_${safeServerName}.jsonl`),
    stream: toBoolean(ARGS.stream ?? process.env.DROP_STREAM, profile.stream || false),
    retry: !toBoolean(ARGS["no-retry"] ?? process.env.DROP_NO_RETRY, false),
    useStop: !toBoolean(ARGS["no-stop"] ?? process.env.DROP_NO_STOP, false),
};

// Runtime counters used for progress logs and final summary.
const STATS = {
    total: 0,
    correct: 0,
    errors: 0,
    totalTimeMs: 0,
    retries: 0,
    numberTotal: 0,
    numberCorrect: 0,
    spanTotal: 0,
    spanCorrect: 0,
};

// ----------------------------- Utilities -----------------------------
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}

function clearCurrentLine() {
    if (process.stdout.isTTY && typeof process.stdout.clearLine === "function" && typeof process.stdout.cursorTo === "function") {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
    }
}

function printProgress(message) {
    clearCurrentLine();
    process.stdout.write(message);
}

// Resolve the DROP dataset path from --data-file first, then fall back to the
// repository's shared data_sets directory.
function resolveDataPath() {
    const primary = path.resolve(__dirname, CONFIG.dataFile);
    if (fs.existsSync(primary)) return primary;

    const fallback = path.resolve(__dirname, "..", "data_sets", "DROP", "train.jsonl");
    if (fs.existsSync(fallback)) return fallback;

    throw new Error(`Cannot find DROP dataset. Checked: ${primary} and ${fallback}`);
}

function shorten(value, maxLength = 36) {
    const text = String(value || "");
    return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

// ----------------------------- Dataset Module -----------------------------
// DROP rows contain passage, question, and answer metadata. The answer type is
// used to choose numeric-vs-span prompt and scoring behavior.
function hasNumberType(types) {
    return Array.isArray(types) && types.some(type => String(type).toLowerCase() === "number");
}

function loadDataset(dataPath) {
    return fs.readFileSync(dataPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

// ----------------------------- Prompt Module -----------------------------
// Primary prompt asks for one final Answer line and avoids examples, because
// examples caused continuation loops on completion-style backends.
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

// Strict retry is used only when the primary output is structurally bad, such
// as no Answer line or multiple candidate answers.
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

// ----------------------------- Network Module -----------------------------
// Fetch wrapper with AbortController timeout support. All request styles use it.
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = CONFIG.timeoutMs, ...restOptions } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(resource, { ...restOptions, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function attachStop(payload, stop) {
    if (CONFIG.useStop && Array.isArray(stop) && stop.length > 0) {
        return { ...payload, stop };
    }
    return payload;
}

// Build request body for the selected protocol. Prompt and generation settings
// are shared; only field names differ by backend.
function buildPayload(prompt, options = {}) {
    const maxTokens = options.maxTokens ?? CONFIG.maxTokens;
    const temperature = options.temperature ?? CONFIG.temperature;
    const stop = options.stop || [];

    if (CONFIG.apiType === "chat") {
        return attachStop({
            model: CONFIG.modelName,
            messages: [
                { role: "user", content: prompt },
            ],
            max_tokens: maxTokens,
            temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
            stream: CONFIG.stream,
        }, stop);
    }

    if (CONFIG.apiType === "completion") {
        return attachStop({
            prompt,
            n_predict: maxTokens,
            temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
        }, stop);
    }

    return attachStop({
        prompt,
        max_tokens: maxTokens,
        temperature,
        top_p: CONFIG.topP,
        top_k: CONFIG.topK,
    }, stop);
}

// Normalize common response shapes into one model-output string.
function extractModelText(data) {
    if (!data || typeof data !== "object") return "";

    if (typeof data.response === "string") return data.response;
    if (typeof data.content === "string") return data.content;
    if (typeof data.text === "string") return data.text;

    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) {
        if (typeof choice.message?.content === "string") return choice.message.content;
        if (typeof choice.text === "string") return choice.text;
        if (typeof choice.delta?.content === "string") return choice.delta.content;
    }

    return "";
}

// Parse OpenAI-compatible SSE streams when --stream is enabled or the server
// returns text/event-stream.
async function readSseText(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let output = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const payloadText = trimmed.slice(5).trim();
            if (!payloadText || payloadText === "[DONE]") continue;

            try {
                const json = JSON.parse(payloadText);
                output += extractModelText(json);
            } catch (_error) {
                // Ignore malformed stream chunks.
            }
        }
    }

    return output;
}

// Execute one model request and return raw model output plus latency.
async function requestModel(prompt, options = {}) {
    if (!CONFIG.apiUrl) {
        throw new Error("Missing apiUrl. Use --server, --api-url, or JIUGE_API_URL.");
    }

    const startedAt = Date.now();
    const response = await fetchWithTimeout(CONFIG.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(prompt, options)),
        timeout: CONFIG.timeoutMs,
    });

    if (!response.ok) {
        const bodyText = await response.text().catch(() => "");
        throw new Error(`HTTP ${response.status}${bodyText ? ` - ${bodyText.slice(0, 300)}` : ""}`);
    }

    const contentType = response.headers.get("content-type") || "";
    let output = "";
    if (response.body && contentType.toLowerCase().includes("text/event-stream")) {
        output = await readSseText(response);
    } else {
        const data = await response.json();
        output = extractModelText(data);
    }

    if (!String(output || "").trim()) {
        throw new Error("empty response body");
    }

    return {
        output,
        inferenceTimeMs: Date.now() - startedAt,
    };
}

// ----------------------------- Parsing Module -----------------------------
// Remove transport/control tokens and keep text usable for answer extraction.
function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|eot_id\|>/gi, " ")
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

function parseNumericValue(value) {
    const cleaned = String(value || "").replace(/,/g, "");
    const match = cleaned.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
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

// Select final prediction from all candidates. If output has explicit Answer
// markers, later valid answers are preferred; otherwise the first short line is
// treated as the direct answer from strict retry.
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

// Decide whether primary output is structurally suspicious enough to retry.
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

// ----------------------------- Evaluation Module -----------------------------
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

// Numeric questions are scored by exact numeric equality. Span questions use
// normalized containment from model answer to gold span.
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

// ----------------------------- Request Strategy Module -----------------------------
// Run primary request first, then strict retry only when output shape is poor.
async function askDrop(passage, question, expectsNumber) {
    const primaryResult = await requestModel(buildPrimaryPrompt(passage, question, expectsNumber), {
        maxTokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        stop: PRIMARY_STOP,
    });

    const primaryPrediction = selectPrediction(primaryResult.output, expectsNumber, question);
    if (!CONFIG.retry || !needsRetry(primaryResult.output, primaryPrediction, expectsNumber)) {
        return {
            ...primaryResult,
            prediction: primaryPrediction,
            strategy: "primary",
        };
    }

    try {
        const strictResult = await requestModel(buildStrictPrompt(passage, question, expectsNumber), {
            maxTokens: CONFIG.strictMaxTokens,
            temperature: 0,
            stop: STRICT_STOP,
        });
        const strictPrediction = selectPrediction(strictResult.output, expectsNumber, question);

        if (strictPrediction) {
            return {
                ...strictResult,
                prediction: strictPrediction,
                strategy: "strict_retry",
                primaryOutput: primaryResult.output,
                primaryInferenceTimeMs: primaryResult.inferenceTimeMs,
                inferenceTimeMs: primaryResult.inferenceTimeMs + strictResult.inferenceTimeMs,
            };
        }
    } catch (_retryError) {
        // Fall back to primary result when strict retry fails.
    }

    return {
        ...primaryResult,
        prediction: primaryPrediction,
        strategy: "primary_fallback",
    };
}

// ----------------------------- Result Module -----------------------------
// Append one JSON object per line so partial runs are still inspectable.
function appendJsonl(filePath, record) {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
}

// Keep one dataset-level summary JSON so different server runs can be
// compared without opening each per-server JSONL file.
function updateDatasetSummary(summaryPath, datasetName, serverKey, record) {
    ensureDir(path.dirname(summaryPath));

    let payload = {
        dataset: datasetName,
        updatedAt: "",
        servers: {},
    };

    if (fs.existsSync(summaryPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
            if (parsed && typeof parsed === "object") {
                payload = parsed;
            }
        } catch (_error) {
            // If the summary file is malformed, rebuild it from the current run.
        }
    }

    const updatedAt = new Date().toISOString();
    payload.dataset = datasetName;
    payload.updatedAt = updatedAt;
    payload.servers = payload.servers && typeof payload.servers === "object" ? payload.servers : {};
    payload.servers[serverKey] = {
        ...record,
        updatedAt,
    };

    fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2), "utf-8");
}

// Print one-line progress and update global counters.
function logResult(index, total, correct, prediction, expected, expectsNumber, inferenceTimeMs, errorMsg = "", strategy = "") {
    STATS.total += 1;
    if (correct) STATS.correct += 1;
    if (errorMsg) STATS.errors += 1;
    if (strategy === "strict_retry") STATS.retries += 1;
    STATS.totalTimeMs += Number(inferenceTimeMs || 0);

    if (expectsNumber) {
        STATS.numberTotal += 1;
        if (correct) STATS.numberCorrect += 1;
    } else {
        STATS.spanTotal += 1;
        if (correct) STATS.spanCorrect += 1;
    }

    const acc = STATS.total > 0 ? ((STATS.correct / STATS.total) * 100).toFixed(2) : "0.00";
    const avgMs = STATS.total > 0 ? (STATS.totalTimeMs / STATS.total).toFixed(0) : "0";
    const status = errorMsg ? "ERROR" : correct ? "OK" : "FAIL";
    const type = expectsNumber ? "number" : "span";
    const strategyText = strategy ? ` strategy=${strategy}` : "";

    clearCurrentLine();
    if (errorMsg) {
        console.log(`[DROP][${CONFIG.server}] ${index}/${total} ${status} type=${type} acc=${acc}% avg=${avgMs}ms error=${errorMsg}`);
        return;
    }

    console.log(
        `[DROP][${CONFIG.server}] ${index}/${total} ${status} type=${type} ` +
        `acc=${acc}% pred=${shorten(prediction)} gold=${shorten(expected[0] || "")} ` +
        `time=${Number(inferenceTimeMs || 0).toFixed(0)}ms avg=${avgMs}ms${strategyText}`
    );
}

// ----------------------------- Main Pipeline -----------------------------
// Load dataset -> request model -> extract answer -> score -> write JSONL and
// final summary.
async function main() {
    const dataPath = resolveDataPath();
    const resultPath = path.resolve(CONFIG.resultFile);
    const datasetSummaryPath = path.join(path.dirname(resultPath), "drop_summary.json");

    ensureDir(path.dirname(resultPath));
    fs.writeFileSync(resultPath, "", "utf-8");

    console.log("[INFO] DROP uniform eval");
    console.log(`[INFO] Server=${CONFIG.server} | API=${CONFIG.apiUrl} | Type=${CONFIG.apiType} | Model=${CONFIG.modelName}`);
    console.log(`[INFO] MaxTokens=${CONFIG.maxTokens} | StrictMaxTokens=${CONFIG.strictMaxTokens} | Temperature=${CONFIG.temperature} | Limit=${CONFIG.limit}`);
    console.log(`[INFO] Retry=${CONFIG.retry} | Stop=${CONFIG.useStop} | Dataset=${dataPath}`);
    console.log(`[INFO] Result=${resultPath}`);
    console.log("------------------------------------------------------------");

    let dataset = loadDataset(dataPath);
    if (CONFIG.limit > 0 && dataset.length > CONFIG.limit) {
        dataset = dataset.slice(0, CONFIG.limit);
    }

    for (let index = 0; index < dataset.length; index++) {
        const item = dataset[index];
        const expectedList = item.answers_spans?.spans || [];
        const expectsNumber = hasNumberType(item.answers_spans?.types || []);

        printProgress(`[DROP][${CONFIG.server}] ${index + 1}/${dataset.length} Calculating...`);

        let output = "";
        let prediction = "";
        let error = "";
        let inferenceTimeMs = 0;
        let strategy = "";
        let primaryOutput = "";
        let primaryInferenceTimeMs = 0;
        let correct = false;

        try {
            const result = await askDrop(item.passage, item.question, expectsNumber);
            output = result.output;
            prediction = result.prediction || "";
            inferenceTimeMs = result.inferenceTimeMs;
            strategy = result.strategy || "";
            primaryOutput = result.primaryOutput || "";
            primaryInferenceTimeMs = result.primaryInferenceTimeMs || 0;
            correct = matchesExpected(expectedList, prediction, expectsNumber);
        } catch (err) {
            error = err.message || String(err);
        }

        logResult(index + 1, dataset.length, correct, prediction, expectedList, expectsNumber, inferenceTimeMs, error, strategy);

        appendJsonl(resultPath, {
            id: index + 1,
            server: CONFIG.server,
            api_url: CONFIG.apiUrl,
            api_type: CONFIG.apiType,
            question: item.question,
            type: expectsNumber ? "number" : "span",
            expected: expectedList,
            prediction,
            correct,
            inferenceTimeMs,
            primaryInferenceTimeMs,
            error,
            strategy,
            output,
            primaryOutput,
        });

        if (CONFIG.cooldownMs > 0 && index < dataset.length - 1) {
            await sleep(CONFIG.cooldownMs);
        }
    }

    const accuracy = STATS.total === 0 ? 0 : (STATS.correct / STATS.total) * 100;
    const avgLatencyMs = STATS.total === 0 ? 0 : STATS.totalTimeMs / STATS.total;
    const numberAccuracy = STATS.numberTotal === 0 ? 0 : (STATS.numberCorrect / STATS.numberTotal) * 100;
    const spanAccuracy = STATS.spanTotal === 0 ? 0 : (STATS.spanCorrect / STATS.spanTotal) * 100;
    const summary = {
        summary: true,
        server: CONFIG.server,
        api_url: CONFIG.apiUrl,
        api_type: CONFIG.apiType,
        total: STATS.total,
        correct: STATS.correct,
        accuracy: Number(accuracy.toFixed(2)),
        avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
        errors: STATS.errors,
        retries: STATS.retries,
        number: {
            total: STATS.numberTotal,
            correct: STATS.numberCorrect,
            accuracy: Number(numberAccuracy.toFixed(2)),
        },
        span: {
            total: STATS.spanTotal,
            correct: STATS.spanCorrect,
            accuracy: Number(spanAccuracy.toFixed(2)),
        },
    };

    appendJsonl(resultPath, summary);
    updateDatasetSummary(datasetSummaryPath, "DROP", safeServerName, {
        server: CONFIG.server,
        api_url: CONFIG.apiUrl,
        api_type: CONFIG.apiType,
        model: CONFIG.modelName,
        max_tokens: CONFIG.maxTokens,
        strict_max_tokens: CONFIG.strictMaxTokens,
        temperature: CONFIG.temperature,
        limit: CONFIG.limit,
        retry: CONFIG.retry,
        stop: CONFIG.useStop,
        result_file: resultPath,
        total: summary.total,
        correct: summary.correct,
        accuracy: summary.accuracy,
        avgLatencyMs: summary.avgLatencyMs,
        errors: summary.errors,
        retries: summary.retries,
        number: summary.number,
        span: summary.span,
    });

    console.log("------------------------------------------------------------");
    console.log(
        `[SUMMARY] Total=${summary.total} Correct=${summary.correct} ` +
        `Accuracy=${summary.accuracy.toFixed(2)}% AvgLatency=${summary.avgLatencyMs.toFixed(0)}ms ` +
        `Errors=${summary.errors} Retries=${summary.retries}`
    );
    console.log(
        `[SUMMARY] Number=${summary.number.correct}/${summary.number.total} (${summary.number.accuracy.toFixed(2)}%) ` +
        `Span=${summary.span.correct}/${summary.span.total} (${summary.span.accuracy.toFixed(2)}%)`
    );
    console.log(`[SUMMARY] DatasetSummary=${datasetSummaryPath}`);
}

main().catch(error => {
    console.error(`[FATAL] ${error.message || String(error)}`);
    process.exitCode = 1;
});
