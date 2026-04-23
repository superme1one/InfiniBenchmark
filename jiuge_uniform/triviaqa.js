const fs = require("fs");
const path = require("path");

/*
 * TriviaQA unified benchmark script.
 *
 * This file keeps evaluation logic stable across different Jiuge server
 * deployments. The prompt, answer extraction, max token default, temperature,
 * and scoring rules are shared. Only the transport layer changes by server
 * profile or command-line arguments.
 */

// Server profiles only describe how to reach each backend and what request
// payload shape it expects. They must not change benchmark semantics.
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

// ----------------------------- CLI Parsing -----------------------------
// Minimal argument parser supporting both "--key value" and "--key=value".
// This keeps the script dependency-free and easy to copy to other servers.
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

// Convert numeric command-line/env values while keeping safe defaults.
function toNumber(value, fallback) {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

// Convert flags such as "--stream", "TRIVIAQA_STREAM=true", or "1".
function toBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === "") return fallback;
    if (typeof value === "boolean") return value;
    return /^(1|true|yes|y|on)$/i.test(String(value));
}

// Infer the payload type when the user provides only an API URL.
function inferApiType(apiUrl) {
    const lowerUrl = String(apiUrl || "").toLowerCase();
    if (lowerUrl.includes("/chat/completions")) return "chat";
    if (lowerUrl.includes("/completion")) return "completion";
    return "prompt";
}

// Printed when the user runs "node triviaqa.js --help".
function printUsage() {
    console.log(`
Usage:
  node triviaqa.js --server tianshu
  node triviaqa.js --server muxi --limit 100
  node triviaqa.js --server moer --api-url http://127.0.0.1:9501/chat/completions
  node triviaqa.js --api-url http://127.0.0.1:1145/completion --api-type completion

Options:
  --server <name>        Server profile: tianshu, muxi, moer, nvda. Default: tianshu
  --api-url <url>        Override profile API URL.
  --api-type <type>      Request format: prompt, chat, completion. Usually inferred from profile or URL.
  --model <name>         Model name for chat-compatible APIs.
  --limit <n>            Number of samples. Default: 100
  --max-tokens <n>       Max output tokens. Default: 1024
  --temperature <n>      Sampling temperature. Default: 0.1
  --cooldown-ms <n>      Delay between samples. Default: 500
  --timeout-ms <n>       Per-request timeout. Default: 120000
  --data-file <path>     TriviaQA JSON file. Default: ../data_sets/TriviaQA/verified-web-dev.json
  --result-file <path>   Output JSONL file. Default: result/triviaqa_<server>.jsonl
  --stream               Enable SSE streaming for chat APIs.
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
// These values are resolved once at startup. Command-line arguments have the
// highest priority, then environment variables, then server-profile defaults.
const CONFIG = {
    server: profileName,
    apiUrl,
    apiType,
    modelName: ARGS.model || process.env.JIUGE_MODEL_NAME || profile.modelName || "9g_8b_thinking",
    maxTokens: toNumber(ARGS["max-tokens"] || process.env.TRIVIAQA_MAX_TOKENS, 1024),
    temperature: toNumber(ARGS.temperature || process.env.TRIVIAQA_TEMPERATURE, 0.1),
    topP: toNumber(ARGS["top-p"] || process.env.TRIVIAQA_TOP_P, 1.0),
    topK: toNumber(ARGS["top-k"] || process.env.TRIVIAQA_TOP_K, 1),
    cooldownMs: toNumber(ARGS["cooldown-ms"] || process.env.TRIVIAQA_COOLDOWN_MS, 500),
    timeoutMs: toNumber(ARGS["timeout-ms"] || process.env.TRIVIAQA_TIMEOUT_MS, 120000),
    limit: toNumber(ARGS.limit || process.env.TRIVIAQA_LIMIT, 100),
    dataFile: ARGS["data-file"] || process.env.TRIVIAQA_DATA_FILE || "../data_sets/TriviaQA/verified-web-dev.json",
    resultFile: ARGS["result-file"] || process.env.TRIVIAQA_RESULT_FILE || path.join(__dirname, "result", `triviaqa_${safeServerName}.jsonl`),
    stream: toBoolean(ARGS.stream ?? process.env.TRIVIAQA_STREAM, profile.stream || false),
};

// Runtime counters used for progress logs and the final summary record.
const STATS = {
    total: 0,
    correct: 0,
    errors: 0,
    totalTimeMs: 0,
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

// Resolve the TriviaQA dataset path from --data-file first, then fall back to
// the repository's shared data_sets directory.
function resolveDataPath() {
    const primary = path.resolve(__dirname, CONFIG.dataFile);
    if (fs.existsSync(primary)) return primary;

    const fallback = path.resolve(__dirname, "..", "data_sets", "TriviaQA", "verified-web-dev.json");
    if (fs.existsSync(fallback)) return fallback;

    throw new Error(`Cannot find TriviaQA dataset. Checked: ${primary} and ${fallback}`);
}

// ----------------------------- Prompt Module -----------------------------
// The prompt is intentionally independent of server profile. Keeping this text
// identical is what makes cross-server accuracy and latency comparisons fair.
function buildPrompt(question) {
    return `
You are a concise trivia expert.

Question:
${question}

Instructions:
1. Think step-by-step to recall the correct fact.
2. Output the final answer concisely: just the entity, name, title, place, date, or short fact.
3. Start your final answer strictly with "Answer: ".
4. Do not output multiple answers.
5. Do not output anything after the final answer.
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

// Build the request body for the selected protocol. The benchmark prompt and
// generation parameters stay the same; only field names differ by backend.
function buildPayload(prompt) {
    if (CONFIG.apiType === "chat") {
        return {
            model: CONFIG.modelName,
            messages: [
                { role: "user", content: prompt },
            ],
            max_tokens: CONFIG.maxTokens,
            temperature: CONFIG.temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
            stream: CONFIG.stream,
        };
    }

    if (CONFIG.apiType === "completion") {
        return {
            prompt,
            n_predict: CONFIG.maxTokens,
            temperature: CONFIG.temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
            stop: ["\nQuestion:", "\n\nQuestion:"],
        };
    }

    return {
        prompt,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        top_p: CONFIG.topP,
        top_k: CONFIG.topK,
    };
}

// Normalize common response shapes into a single model-output string.
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
// Remove transport/control tokens and keep only the answer-bearing tail.
function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    let cleanText = String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .trim();

    const jiugeAnswerMatch = cleanText.match(/\*\*[^\r\n]*回答[^\r\n]*:\*\*/i);
    if (jiugeAnswerMatch) {
        cleanText = cleanText.slice(jiugeAnswerMatch.index + jiugeAnswerMatch[0].length).trim();
    }

    const thinkIndex = cleanText.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        const tail = cleanText.slice(thinkIndex + 8).trim();
        cleanText = tail || cleanText;
    }

    return cleanText;
}

// Trim punctuation/brackets around a candidate answer without changing content.
function normalizeCandidate(value) {
    return String(value || "")
        .replace(/^[\s"'`([{]+|[\s"'`)\]}.,;:!?]+$/g, "")
        .trim();
}

// Filter out prompt/template lines that should never be counted as answers.
function isMetaLine(line) {
    return /^(question|instructions|example|format|response)\s*:/i.test(line) ||
        /^(let me|i think|i need|first,|the question|your reasoning)/i.test(line) ||
        /^<concise_answer>$/i.test(line);
}

// Extract the final TriviaQA answer. The preferred format is "Answer: ...";
// if the model omits it, short non-meta tail lines are used as a fallback.
function extractAnswer(rawOutput) {
    const cleanText = cleanModelOutput(rawOutput);
    if (!cleanText) return "FORMAT_ERROR";

    const answers = [];
    const answerRegex = /\*{0,2}Answer\s*:\*{0,2}\s*([^\r\n]+)/gi;
    for (const match of cleanText.matchAll(answerRegex)) {
        const candidate = normalizeCandidate(match[1]);
        if (candidate && !isMetaLine(candidate)) {
            answers.push(candidate);
        }
    }

    if (answers.length > 0) {
        return answers[answers.length - 1];
    }

    const lines = cleanText
        .split(/\r?\n/)
        .map(line => normalizeCandidate(line))
        .filter(Boolean)
        .filter(line => !isMetaLine(line));

    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].length <= 120) {
            return lines[i];
        }
    }

    return "FORMAT_ERROR";
}

// ----------------------------- Evaluation Module -----------------------------
// Normalize aliases and predictions for robust TriviaQA alias matching.
function normalizeTriviaText(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\b(the|a|an)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// TriviaQA is alias-based: exact normalized match or containment in either
// direction is counted correct.
function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer || modelAnswer === "FORMAT_ERROR") return false;

    const normalizedAnswer = normalizeTriviaText(modelAnswer);
    if (!normalizedAnswer) return false;

    return expectList.some(alias => {
        const normalizedAlias = normalizeTriviaText(alias);
        return normalizedAlias && (
            normalizedAnswer === normalizedAlias ||
            normalizedAnswer.includes(normalizedAlias) ||
            normalizedAlias.includes(normalizedAnswer)
        );
    });
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

// Print one-line progress and update in-memory counters.
function logResult(index, total, correct, answer, expected, inferenceTimeMs, errorMsg = "") {
    STATS.total += 1;
    if (correct) STATS.correct += 1;
    if (errorMsg) STATS.errors += 1;
    STATS.totalTimeMs += Number(inferenceTimeMs || 0);

    const acc = STATS.total > 0 ? ((STATS.correct / STATS.total) * 100).toFixed(1) : "0.0";
    const avgMs = STATS.total > 0 ? (STATS.totalTimeMs / STATS.total).toFixed(0) : "0";

    clearCurrentLine();
    if (errorMsg) {
        console.log(`[TriviaQA][${CONFIG.server}] ${index}/${total} ERROR acc=${acc}% avg=${avgMs}ms error=${errorMsg}`);
        return;
    }

    const shortAnswer = String(answer).length > 36 ? `${String(answer).slice(0, 36)}...` : String(answer);
    const shortExpected = String(expected).length > 36 ? `${String(expected).slice(0, 36)}...` : String(expected);
    console.log(
        `[TriviaQA][${CONFIG.server}] ${index}/${total} ${correct ? "OK" : "FAIL"} ` +
        `acc=${acc}% pred=${shortAnswer} gold=${shortExpected} time=${Number(inferenceTimeMs || 0).toFixed(0)}ms avg=${avgMs}ms`
    );
}

// ----------------------------- Main Pipeline -----------------------------
// Load dataset -> request model -> extract answer -> score -> write JSONL.
async function main() {
    const dataPath = resolveDataPath();
    const resultPath = path.resolve(CONFIG.resultFile);
    const datasetSummaryPath = path.join(path.dirname(resultPath), "triviaqa_summary.json");

    ensureDir(path.dirname(resultPath));
    fs.writeFileSync(resultPath, "", "utf-8");

    console.log(`[INFO] TriviaQA uniform eval`);
    console.log(`[INFO] Server=${CONFIG.server} | API=${CONFIG.apiUrl} | Type=${CONFIG.apiType} | Model=${CONFIG.modelName}`);
    console.log(`[INFO] MaxTokens=${CONFIG.maxTokens} | Temperature=${CONFIG.temperature} | Limit=${CONFIG.limit}`);
    console.log(`[INFO] Dataset=${dataPath}`);
    console.log(`[INFO] Result=${resultPath}`);
    console.log("------------------------------------------------------------");

    const parsed = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
    let dataset = parsed.Data || parsed;
    if (!Array.isArray(dataset)) {
        throw new Error("TriviaQA dataset must be an array or an object with Data array.");
    }

    if (CONFIG.limit > 0 && dataset.length > CONFIG.limit) {
        dataset = dataset.slice(0, CONFIG.limit);
    }

    for (let index = 0; index < dataset.length; index++) {
        const item = dataset[index];
        const question = item.Question;
        const expectedAliases = item.Answer?.NormalizedAliases || item.Answer?.Aliases || [];

        printProgress(`[TriviaQA][${CONFIG.server}] ${index + 1}/${dataset.length} Calculating...`);

        let output = "";
        let answer = "FORMAT_ERROR";
        let error = "";
        let inferenceTimeMs = 0;
        let correct = false;

        try {
            const result = await askModel(question);
            output = result.output;
            inferenceTimeMs = result.inferenceTimeMs;
            answer = extractAnswer(output);
            correct = matchExpect(expectedAliases, answer);
        } catch (err) {
            error = err.message || String(err);
        }

        logResult(index + 1, dataset.length, correct, answer, expectedAliases[0] || "N/A", inferenceTimeMs, error);

        appendJsonl(resultPath, {
            id: index + 1,
            server: CONFIG.server,
            api_url: CONFIG.apiUrl,
            api_type: CONFIG.apiType,
            question,
            prediction: answer,
            expected: expectedAliases,
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
    };

    appendJsonl(resultPath, summary);
    updateDatasetSummary(datasetSummaryPath, "TriviaQA", safeServerName, {
        server: CONFIG.server,
        api_url: CONFIG.apiUrl,
        api_type: CONFIG.apiType,
        model: CONFIG.modelName,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        limit: CONFIG.limit,
        result_file: resultPath,
        total: summary.total,
        correct: summary.correct,
        accuracy: summary.accuracy,
        avgLatencyMs: summary.avgLatencyMs,
        errors: summary.errors,
    });

    console.log("------------------------------------------------------------");
    console.log(
        `[SUMMARY] Total=${summary.total} Correct=${summary.correct} ` +
        `Accuracy=${summary.accuracy.toFixed(2)}% AvgLatency=${summary.avgLatencyMs.toFixed(0)}ms Errors=${summary.errors}`
    );
    console.log(`[SUMMARY] DatasetSummary=${datasetSummaryPath}`);
}

main().catch(error => {
    console.error(`[FATAL] ${error.message || String(error)}`);
    process.exitCode = 1;
});
