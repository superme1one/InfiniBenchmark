const fs = require("fs");
const path = require("path");

/*
 * GSM8K unified benchmark script.
 *
 * This file keeps GSM8K evaluation semantics stable across different Jiuge
 * server deployments. Prompt text, extraction rules, max token default,
 * temperature, and numeric scoring are shared. Only the transport layer
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

const GENERATION_STOP = ["\nQuestion:", "\n\nQuestion:"];

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

// Convert flags such as "--stream", "GSM8K_STREAM=true", or "1".
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

// Printed when running "node gsm8k.js --help".
function printUsage() {
    console.log(`
Usage:
  node gsm8k.js --server tianshu
  node gsm8k.js --server muxi --limit 100
  node gsm8k.js --server moer --api-url http://127.0.0.1:9501/chat/completions
  node gsm8k.js --api-url http://127.0.0.1:1145/completion --api-type completion

Options:
  --server <name>       Server profile: tianshu, muxi, moer, nvda. Default: tianshu
  --api-url <url>       Override profile API URL.
  --api-type <type>     Request format: prompt, chat, completion. Usually inferred from profile or URL.
  --model <name>        Model name for chat-compatible APIs.
  --limit <n>           Number of samples. Default: 100
  --max-tokens <n>      Max output tokens. Default: 2048
  --temperature <n>     Sampling temperature. Default: 0.1
  --cooldown-ms <n>     Delay between samples. Default: 500
  --timeout-ms <n>      Per-request timeout. Default: 300000
  --data-file <path>    GSM8K JSONL file. Default: ../data_sets/GSM8k/test.jsonl
  --result-file <path>  Output JSONL file. Default: result/gsm8k_<server>.jsonl
  --stream              Enable SSE streaming for chat APIs.
  --no-stop             Do not send stop sequences.
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
    maxTokens: toNumber(ARGS["max-tokens"] || process.env.GSM8K_MAX_TOKENS, 2048),
    temperature: toNumber(ARGS.temperature || process.env.GSM8K_TEMPERATURE, 0.1),
    topP: toNumber(ARGS["top-p"] || process.env.GSM8K_TOP_P, 1.0),
    topK: toNumber(ARGS["top-k"] || process.env.GSM8K_TOP_K, 1),
    cooldownMs: toNumber(ARGS["cooldown-ms"] || process.env.GSM8K_COOLDOWN_MS, 500),
    timeoutMs: toNumber(ARGS["timeout-ms"] || process.env.GSM8K_TIMEOUT_MS, 300000),
    limit: toNumber(ARGS.limit || process.env.GSM8K_LIMIT, 100),
    dataFile: ARGS["data-file"] || process.env.GSM8K_DATA_FILE || "../data_sets/GSM8k/test.jsonl",
    resultFile: ARGS["result-file"] || process.env.GSM8K_RESULT_FILE || path.join(__dirname, "result", `gsm8k_${safeServerName}.jsonl`),
    stream: toBoolean(ARGS.stream ?? process.env.GSM8K_STREAM, profile.stream || false),
    useStop: !toBoolean(ARGS["no-stop"] ?? process.env.GSM8K_NO_STOP, false),
};

// Runtime counters used for progress logs and final summary.
const STATS = {
    total: 0,
    correct: 0,
    errors: 0,
    totalTimeMs: 0,
    invalid: 0,
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

// Resolve the GSM8K dataset path from --data-file first, then fall back to the
// repository's shared data_sets directory.
function resolveDataPath() {
    const primary = path.resolve(__dirname, CONFIG.dataFile);
    if (fs.existsSync(primary)) return primary;

    const fallback = path.resolve(__dirname, "..", "data_sets", "GSM8k", "test.jsonl");
    if (fs.existsSync(fallback)) return fallback;

    throw new Error(`Cannot find GSM8K dataset. Checked: ${primary} and ${fallback}`);
}

// ----------------------------- Dataset Module -----------------------------
function loadDataset(dataPath) {
    return fs.readFileSync(dataPath, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

// Gold answers in GSM8K contain "#### <number>".
function extractExpected(answerText) {
    const match = String(answerText || "").match(/####\s*(-?[\d,.]+)/);
    return match ? Number(match[1].replace(/,/g, "")) : NaN;
}

// ----------------------------- Prompt Module -----------------------------
// Shared GSM8K prompt. Keeping this stable makes cross-server comparisons fair.
function buildPrompt(question) {
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

function attachStop(payload) {
    if (CONFIG.useStop) {
        return { ...payload, stop: GENERATION_STOP };
    }
    return payload;
}

// Build request body for the selected protocol. Prompt and generation settings
// are shared; only field names differ by backend.
function buildPayload(prompt) {
    if (CONFIG.apiType === "chat") {
        return attachStop({
            model: CONFIG.modelName,
            messages: [
                { role: "user", content: prompt },
            ],
            max_tokens: CONFIG.maxTokens,
            temperature: CONFIG.temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
            stream: CONFIG.stream,
        });
    }

    if (CONFIG.apiType === "completion") {
        return attachStop({
            prompt,
            n_predict: CONFIG.maxTokens,
            temperature: CONFIG.temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
        });
    }

    return attachStop({
        prompt,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        top_p: CONFIG.topP,
        top_k: CONFIG.topK,
    });
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
async function askModel(question) {
    if (!CONFIG.apiUrl) {
        throw new Error("Missing apiUrl. Use --server, --api-url, or JIUGE_API_URL.");
    }

    const prompt = buildPrompt(question);
    const startedAt = Date.now();
    const response = await fetchWithTimeout(CONFIG.apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload(prompt)),
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
// Remove transport/control tokens and keep the answer-bearing tail.
function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    let cleanText = String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|assistant\|>/gi, " ")
        .replace(/<\|user\|>/gi, " ")
        .trim();

    const thinkIndex = cleanText.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        const tail = cleanText.slice(thinkIndex + 8).trim();
        cleanText = tail || cleanText;
    }

    return cleanText;
}

function parseNumber(value) {
    const cleaned = String(value || "").replace(/,/g, "");
    const match = cleaned.match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : NaN;
}

function collectNumberMatches(text, patterns) {
    const matches = [];
    for (const pattern of patterns) {
        for (const match of String(text || "").matchAll(pattern)) {
            const value = parseNumber(match[1]);
            if (!Number.isNaN(value)) {
                matches.push(value);
            }
        }
    }
    return matches;
}

// Extract the final numeric answer. Explicit final-answer markers are preferred
// and the last valid marker wins, which protects against example leakage.
function extractPrediction(rawOutput) {
    const cleanText = cleanModelOutput(rawOutput);
    if (!cleanText) return NaN;

    const explicitPatterns = [
        /####\s*(-?[\d,.]+(?:\.\d+)?)/g,
        /Answer\s*:\s*(-?[\d,.]+(?:\.\d+)?)/gi,
        /The answer is\s*(-?[\d,.]+(?:\.\d+)?)/gi,
        /\\boxed\{\s*(-?[\d,.]+(?:\.\d+)?)\s*\}/g,
    ];

    const explicitNumbers = collectNumberMatches(cleanText, explicitPatterns);
    if (explicitNumbers.length > 0) {
        return explicitNumbers[explicitNumbers.length - 1];
    }

    const lines = cleanText
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
        if (/^-?[\d,.]+(?:\.\d+)?$/.test(lines[i])) {
            return Number(lines[i].replace(/,/g, ""));
        }
    }

    const allNumbers = cleanText.match(/-?\d[\d,]*(?:\.\d+)?/g);
    if (allNumbers && allNumbers.length > 0) {
        return Number(allNumbers[allNumbers.length - 1].replace(/,/g, ""));
    }

    return NaN;
}

// ----------------------------- Evaluation Module -----------------------------
// GSM8K scoring is exact numeric equality with a small floating tolerance.
function isCorrect(prediction, expected) {
    return !Number.isNaN(prediction) &&
        !Number.isNaN(expected) &&
        Math.abs(Number(prediction) - Number(expected)) < 1e-6;
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
function logResult(index, total, correct, prediction, expected, inferenceTimeMs, errorMsg = "") {
    STATS.total += 1;
    if (correct) STATS.correct += 1;
    if (errorMsg) STATS.errors += 1;
    if (Number.isNaN(prediction) && !errorMsg) STATS.invalid += 1;
    STATS.totalTimeMs += Number(inferenceTimeMs || 0);

    const acc = STATS.total > 0 ? ((STATS.correct / STATS.total) * 100).toFixed(2) : "0.00";
    const avgMs = STATS.total > 0 ? (STATS.totalTimeMs / STATS.total).toFixed(0) : "0";
    const status = errorMsg ? "ERROR" : correct ? "OK" : "FAIL";

    clearCurrentLine();
    if (errorMsg) {
        console.log(`[GSM8K][${CONFIG.server}] ${index}/${total} ${status} acc=${acc}% avg=${avgMs}ms error=${errorMsg}`);
        return;
    }

    console.log(
        `[GSM8K][${CONFIG.server}] ${index}/${total} ${status} ` +
        `acc=${acc}% pred=${Number.isNaN(prediction) ? "NaN" : prediction} gold=${expected} ` +
        `time=${Number(inferenceTimeMs || 0).toFixed(0)}ms avg=${avgMs}ms`
    );
}

// ----------------------------- Main Pipeline -----------------------------
// Load dataset -> request model -> extract numeric answer -> score -> write
// JSONL and final summary.
async function main() {
    const dataPath = resolveDataPath();
    const resultPath = path.resolve(CONFIG.resultFile);
    const datasetSummaryPath = path.join(path.dirname(resultPath), "gsm8k_summary.json");

    ensureDir(path.dirname(resultPath));
    fs.writeFileSync(resultPath, "", "utf-8");

    console.log("[INFO] GSM8K uniform eval");
    console.log(`[INFO] Server=${CONFIG.server} | API=${CONFIG.apiUrl} | Type=${CONFIG.apiType} | Model=${CONFIG.modelName}`);
    console.log(`[INFO] MaxTokens=${CONFIG.maxTokens} | Temperature=${CONFIG.temperature} | Limit=${CONFIG.limit}`);
    console.log(`[INFO] Stop=${CONFIG.useStop} | Dataset=${dataPath}`);
    console.log(`[INFO] Result=${resultPath}`);
    console.log("------------------------------------------------------------");

    let dataset = loadDataset(dataPath);
    if (CONFIG.limit > 0 && dataset.length > CONFIG.limit) {
        dataset = dataset.slice(0, CONFIG.limit);
    }

    for (let index = 0; index < dataset.length; index++) {
        const item = dataset[index];
        const expected = extractExpected(item.answer);

        printProgress(`[GSM8K][${CONFIG.server}] ${index + 1}/${dataset.length} Calculating...`);

        let output = "";
        let prediction = NaN;
        let error = "";
        let inferenceTimeMs = 0;
        let correct = false;

        try {
            const result = await askModel(item.question);
            output = result.output;
            inferenceTimeMs = result.inferenceTimeMs;
            prediction = extractPrediction(output);
            correct = isCorrect(prediction, expected);
        } catch (err) {
            error = err.message || String(err);
        }

        logResult(index + 1, dataset.length, correct, prediction, expected, inferenceTimeMs, error);

        appendJsonl(resultPath, {
            id: index + 1,
            server: CONFIG.server,
            api_url: CONFIG.apiUrl,
            api_type: CONFIG.apiType,
            question: item.question,
            prediction: Number.isNaN(prediction) ? "NaN" : prediction,
            expected,
            correct,
            inferenceTimeMs,
            error,
            output,
        });

        if (CONFIG.cooldownMs > 0 && index < dataset.length - 1) {
            await sleep(CONFIG.cooldownMs);
        }
    }

    const accuracy = STATS.total === 0 ? 0 : (STATS.correct / STATS.total) * 100;
    const avgLatencyMs = STATS.total === 0 ? 0 : STATS.totalTimeMs / STATS.total;
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
        invalid: STATS.invalid,
    };

    appendJsonl(resultPath, summary);
    updateDatasetSummary(datasetSummaryPath, "GSM8K", safeServerName, {
        server: CONFIG.server,
        api_url: CONFIG.apiUrl,
        api_type: CONFIG.apiType,
        model: CONFIG.modelName,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        limit: CONFIG.limit,
        stop: CONFIG.useStop,
        result_file: resultPath,
        total: summary.total,
        correct: summary.correct,
        accuracy: summary.accuracy,
        avgLatencyMs: summary.avgLatencyMs,
        errors: summary.errors,
        invalid: summary.invalid,
    });

    console.log("------------------------------------------------------------");
    console.log(
        `[SUMMARY] Total=${summary.total} Correct=${summary.correct} ` +
        `Accuracy=${summary.accuracy.toFixed(2)}% AvgLatency=${summary.avgLatencyMs.toFixed(0)}ms ` +
        `Errors=${summary.errors} Invalid=${summary.invalid}`
    );
    console.log(`[SUMMARY] DatasetSummary=${datasetSummaryPath}`);
}

main().catch(error => {
    console.error(`[FATAL] ${error.message || String(error)}`);
    process.exitCode = 1;
});
