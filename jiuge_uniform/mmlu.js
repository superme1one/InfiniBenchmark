const fs = require("fs");
const path = require("path");

/*
 * MMLU unified benchmark script.
 *
 * This file keeps MMLU evaluation semantics stable across different Jiuge
 * server deployments. The subject list, prompt, extraction rules, max token
 * default, temperature, and scoring logic are shared. Only the transport layer
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

// Canonical MMLU subject list. Use --subjects to run a subset.
const SUBJECTS = [
    "abstract_algebra", "anatomy", "astronomy", "business_ethics", "clinical_knowledge",
    "college_biology", "college_chemistry", "college_computer_science", "college_mathematics",
    "college_medicine", "college_physics", "computer_security", "conceptual_physics",
    "econometrics", "electrical_engineering", "elementary_mathematics", "formal_logic",
    "global_facts", "high_school_biology", "high_school_chemistry", "high_school_computer_science",
    "high_school_european_history", "high_school_geography", "high_school_government_and_politics",
    "high_school_macroeconomics", "high_school_mathematics", "high_school_microeconomics",
    "high_school_physics", "high_school_psychology", "high_school_statistics", "high_school_us_history",
    "high_school_world_history", "human_aging", "human_sexuality", "international_law",
    "jurisprudence", "logical_fallacies", "machine_learning", "management", "marketing",
    "medical_genetics", "miscellaneous", "moral_disputes", "moral_scenarios", "nutrition",
    "philosophy", "prehistory", "professional_accounting", "professional_law",
    "professional_medicine", "professional_psychology", "public_relations", "security_studies",
    "sociology", "us_foreign_policy", "virology", "world_religions",
];

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

// Convert flags such as "--stream", "MMLU_STREAM=true", or "1".
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

// Printed when running "node mmlu.js --help".
function printUsage() {
    console.log(`
Usage:
  node mmlu.js --server tianshu
  node mmlu.js --server muxi --subjects abstract_algebra,anatomy --limit-per-subject 100
  node mmlu.js --server moer --api-url http://127.0.0.1:9501/chat/completions
  node mmlu.js --api-url http://127.0.0.1:1145/completion --api-type completion

Options:
  --server <name>             Server profile: tianshu, muxi, moer, nvda. Default: tianshu
  --api-url <url>             Override profile API URL.
  --api-type <type>           Request format: prompt, chat, completion. Usually inferred from profile or URL.
  --model <name>              Model name for chat-compatible APIs.
  --subjects <a,b,c>          Comma-separated MMLU subjects. Default: all subjects
  --limit-per-subject <n>     Number of samples per subject. Default: 100
  --max-tokens <n>            Max output tokens. Default: 4096
  --temperature <n>           Sampling temperature. Default: 0.1
  --cooldown-ms <n>           Delay between samples. Default: 200
  --timeout-ms <n>            Per-request timeout. Default: 300000
  --data-dir <path>           MMLU directory. Default: ../data_sets/MMLU
  --result-dir <path>         Output directory. Default: result
  --stream                    Enable SSE streaming for chat APIs.
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
    maxTokens: toNumber(ARGS["max-tokens"] || process.env.MMLU_MAX_TOKENS, 4096),
    temperature: toNumber(ARGS.temperature || process.env.MMLU_TEMPERATURE, 0.1),
    topP: toNumber(ARGS["top-p"] || process.env.MMLU_TOP_P, 1.0),
    topK: toNumber(ARGS["top-k"] || process.env.MMLU_TOP_K, 1),
    cooldownMs: toNumber(ARGS["cooldown-ms"] || process.env.MMLU_COOLDOWN_MS, 200),
    timeoutMs: toNumber(ARGS["timeout-ms"] || process.env.MMLU_TIMEOUT_MS, 300000),
    limitPerSubject: toNumber(ARGS["limit-per-subject"] || process.env.MMLU_LIMIT_PER_SUBJECT, 100),
    subjectFilter: ARGS.subjects || process.env.MMLU_SUBJECTS || "",
    dataDir: ARGS["data-dir"] || process.env.MMLU_DATA_DIR || "../data_sets/MMLU",
    resultDir: ARGS["result-dir"] || process.env.MMLU_RESULT_DIR || path.join(__dirname, "result"),
    stream: toBoolean(ARGS.stream ?? process.env.MMLU_STREAM, profile.stream || false),
};

// Runtime counters used for progress logs and final summary.
const GLOBAL_STATS = {
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

// Resolve the MMLU dataset directory from --data-dir first, then fall back to
// the repository's shared data_sets directory.
function resolveDataDir() {
    const primary = path.resolve(__dirname, CONFIG.dataDir);
    if (fs.existsSync(primary)) return primary;

    const fallback = path.resolve(__dirname, "..", "data_sets", "MMLU");
    if (fs.existsSync(fallback)) return fallback;

    throw new Error(`Cannot find MMLU dataset. Checked: ${primary} and ${fallback}`);
}

// Select all subjects or the comma-separated subset requested by --subjects.
function getSelectedSubjects() {
    const wanted = String(CONFIG.subjectFilter || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean);

    if (wanted.length === 0) return SUBJECTS;

    const wantedSet = new Set(wanted);
    const selected = SUBJECTS.filter(subject => wantedSet.has(subject));
    if (selected.length === 0) {
        throw new Error(`No valid MMLU subjects selected: ${wanted.join(",")}`);
    }

    return selected;
}

// ----------------------------- Dataset Module -----------------------------
// CSV parser that handles quoted commas and escaped quotes in MMLU questions.
function parseCsvRecords(text) {
    const rows = [];
    let row = [];
    let current = "";
    let inQuotes = false;

    const pushField = () => {
        row.push(current);
        current = "";
    };

    const pushRow = () => {
        if (row.length === 0) return;
        if (row.length === 1 && !String(row[0] || "").trim()) {
            row = [];
            return;
        }
        rows.push(row);
        row = [];
    };

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];

        if (char === "\"") {
            if (inQuotes && next === "\"") {
                current += "\"";
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            pushField();
            continue;
        }

        if ((char === "\n" || char === "\r") && !inQuotes) {
            pushField();
            pushRow();
            if (char === "\r" && next === "\n") {
                i++;
            }
            continue;
        }

        current += char;
    }

    if (current.length > 0 || row.length > 0) {
        pushField();
        pushRow();
    }

    return rows
        .map(fields => fields.map(field => String(field || "").trim()))
        .filter(fields => fields.length >= 6)
        .map(fields => ({
            question: fields[0],
            choices: fields.slice(1, 5),
            answer: fields[5].toUpperCase(),
        }))
        .filter(item =>
            item.question &&
            item.choices.length === 4 &&
            item.choices.every(Boolean) &&
            /^[A-D]$/.test(item.answer)
        );
}

// Load one subject CSV and apply the per-subject limit.
function loadSubjectItems(dataDir, subject) {
    const csvPath = path.join(dataDir, `${subject}_test.csv`);
    if (!fs.existsSync(csvPath)) return [];

    let items = parseCsvRecords(fs.readFileSync(csvPath, "utf-8"));
    if (CONFIG.limitPerSubject > 0) {
        items = items.slice(0, CONFIG.limitPerSubject);
    }

    return items;
}

// ----------------------------- Prompt Module -----------------------------
// Shared MMLU prompt. Keeping this stable makes cross-server comparisons fair.
function buildPrompt(item, subject) {
    const subjectLabel = subject.replace(/_/g, " ");
    return `
You are an expert in ${subjectLabel}.

Question:
${item.question}
A) ${item.choices[0]}
B) ${item.choices[1]}
C) ${item.choices[2]}
D) ${item.choices[3]}

Instructions:
1. Think step by step to solve the problem.
2. **Be concise.** Do NOT double-check your work once you derive an answer.
3. You MUST end your response with exactly: "Answer: X" (where X is A, B, C, or D).
4. Do NOT output anything after the final answer.

Format Example:
<think>
... reasoning ...
</think>
Answer: A
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

// Build request body for the selected protocol. Prompt and generation settings
// are shared; only field names differ by backend.
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
            stop: [],
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
async function askModel(item, subject) {
    if (!CONFIG.apiUrl) {
        throw new Error("Missing apiUrl. Use --server, --api-url, or JIUGE_API_URL.");
    }

    const prompt = buildPrompt(item, subject);
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
// Remove transport/control tokens and keep the answer-bearing tail where useful.
function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|assistant\|>/gi, " ")
        .replace(/<\|user\|>/gi, " ")
        .trim();
}

// Extract one of A/B/C/D from model output. This mirrors the tianshu-style
// rule while adding a small completion fallback when </think> appears after
// the answer.
function extractChoice(rawOutput) {
    const cleaned = cleanModelOutput(rawOutput);
    if (!cleaned) return "INVALID";

    let cleanText = cleaned;
    const thinkEndParts = cleaned.split("</think>");
    if (thinkEndParts.length > 1) {
        const tail = thinkEndParts[thinkEndParts.length - 1].trim();
        cleanText = tail || cleaned;
    } else if (cleaned.includes("<think>") && !cleaned.includes("</think>")) {
        cleanText = cleaned;
    }

    const patterns = [
        /Answer\s*:\s*([A-D])\b/i,
        /The answer is\s*([A-D])\b/i,
        /The correct option is\s*([A-D])\b/i,
        /boxed\{([A-D])\}/i,
        /^([A-D])$/m,
        /Option\s*([A-D])\b/i,
    ];

    for (const pattern of patterns) {
        const match = cleanText.match(pattern);
        if (match) {
            return match[1].toUpperCase();
        }
    }

    const lastWindow = cleanText.slice(-100);
    const loose = lastWindow.match(/(?:is|select|option)\s+([A-D])\W*$/i);
    if (loose) return loose[1].toUpperCase();

    if (cleaned.includes("<think>") && !cleaned.includes("</think>")) {
        return "TRUNCATED";
    }

    return "INVALID";
}

// ----------------------------- Evaluation Module -----------------------------
// MMLU scoring is strict: prediction must equal the gold option letter.
function isCorrect(prediction, expected) {
    return prediction === expected;
}

// ----------------------------- Result Module -----------------------------
// Append one JSON object per line so partial runs are still inspectable.
function appendJsonl(filePath, record) {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
}

// Keep one dataset-level summary JSON so different server runs can be
// compared without opening each per-server summary file.
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
function logResult(subject, index, total, correct, prediction, expected, inferenceTimeMs, errorMsg = "") {
    GLOBAL_STATS.total += 1;
    if (correct) GLOBAL_STATS.correct += 1;
    if (errorMsg) GLOBAL_STATS.errors += 1;
    GLOBAL_STATS.totalTimeMs += Number(inferenceTimeMs || 0);

    const acc = GLOBAL_STATS.total > 0 ? ((GLOBAL_STATS.correct / GLOBAL_STATS.total) * 100).toFixed(2) : "0.00";
    const avgMs = GLOBAL_STATS.total > 0 ? (GLOBAL_STATS.totalTimeMs / GLOBAL_STATS.total).toFixed(0) : "0";
    const status = errorMsg ? "ERROR" : correct ? "OK" : "FAIL";

    clearCurrentLine();
    if (errorMsg) {
        console.log(`[MMLU][${CONFIG.server}][${subject}] ${index}/${total} ${status} acc=${acc}% avg=${avgMs}ms error=${errorMsg}`);
        return;
    }

    console.log(
        `[MMLU][${CONFIG.server}][${subject}] ${index}/${total} ${status} ` +
        `acc=${acc}% pred=${prediction} gold=${expected} time=${Number(inferenceTimeMs || 0).toFixed(0)}ms avg=${avgMs}ms`
    );
}

// ----------------------------- Main Pipeline -----------------------------
// Load subjects -> parse CSV -> request model -> extract answer -> score ->
// write per-subject JSONL and a global summary file.
async function main() {
    const dataDir = resolveDataDir();
    const subjects = getSelectedSubjects();
    const resultDir = path.resolve(CONFIG.resultDir);
    const summaryPath = path.join(resultDir, `mmlu_${safeServerName}_summary.txt`);
    const subjectSummaryPath = path.join(resultDir, `mmlu_${safeServerName}_subjects.jsonl`);
    const datasetSummaryPath = path.join(resultDir, "mmlu_summary.json");

    ensureDir(resultDir);
    fs.writeFileSync(summaryPath, `MMLU Unified Summary (${new Date().toISOString()})\n\n`, "utf-8");
    fs.writeFileSync(subjectSummaryPath, "", "utf-8");

    console.log("[INFO] MMLU uniform eval");
    console.log(`[INFO] Server=${CONFIG.server} | API=${CONFIG.apiUrl} | Type=${CONFIG.apiType} | Model=${CONFIG.modelName}`);
    console.log(`[INFO] MaxTokens=${CONFIG.maxTokens} | Temperature=${CONFIG.temperature} | Limit/subject=${CONFIG.limitPerSubject}`);
    console.log(`[INFO] Subjects=${subjects.join(",")}`);
    console.log(`[INFO] Dataset=${dataDir}`);
    console.log(`[INFO] ResultDir=${resultDir}`);
    console.log("------------------------------------------------------------");

    for (const subject of subjects) {
        const items = loadSubjectItems(dataDir, subject);
        if (items.length === 0) {
            console.log(`[WARN] Skip ${subject}: no test items found.`);
            continue;
        }

        const resultPath = path.join(resultDir, `mmlu_${safeServerName}_${subject}.jsonl`);
        fs.writeFileSync(resultPath, "", "utf-8");

        let subjectCorrect = 0;

        for (let index = 0; index < items.length; index++) {
            const item = items[index];
            printProgress(`[MMLU][${CONFIG.server}][${subject}] ${index + 1}/${items.length} Calculating...`);

            let output = "";
            let prediction = "INVALID";
            let error = "";
            let inferenceTimeMs = 0;
            let correct = false;

            try {
                const result = await askModel(item, subject);
                output = result.output;
                inferenceTimeMs = result.inferenceTimeMs;
                prediction = extractChoice(output);
                correct = isCorrect(prediction, item.answer);
            } catch (err) {
                error = err.message || String(err);
                prediction = "ERROR";
            }

            if (correct) subjectCorrect += 1;
            logResult(subject, index + 1, items.length, correct, prediction, item.answer, inferenceTimeMs, error);

            appendJsonl(resultPath, {
                id: index + 1,
                server: CONFIG.server,
                api_url: CONFIG.apiUrl,
                api_type: CONFIG.apiType,
                subject,
                question: item.question,
                choices: item.choices,
                prediction,
                expected: item.answer,
                correct,
                inferenceTimeMs,
                error,
                output,
            });

            if (CONFIG.cooldownMs > 0 && index < items.length - 1) {
                await sleep(CONFIG.cooldownMs);
            }
        }

        const subjectAccuracy = items.length === 0 ? 0 : (subjectCorrect / items.length) * 100;
        appendJsonl(subjectSummaryPath, {
            subject,
            total: items.length,
            correct: subjectCorrect,
            accuracy: Number(subjectAccuracy.toFixed(2)),
        });
        fs.appendFileSync(
            summaryPath,
            `${subject}\t${subjectCorrect}/${items.length}\t${subjectAccuracy.toFixed(2)}%\n`,
            "utf-8"
        );
    }

    const accuracy = GLOBAL_STATS.total === 0 ? 0 : (GLOBAL_STATS.correct / GLOBAL_STATS.total) * 100;
    const avgLatencyMs = GLOBAL_STATS.total === 0 ? 0 : GLOBAL_STATS.totalTimeMs / GLOBAL_STATS.total;
    const summary = {
        summary: true,
        server: CONFIG.server,
        api_url: CONFIG.apiUrl,
        api_type: CONFIG.apiType,
        total: GLOBAL_STATS.total,
        correct: GLOBAL_STATS.correct,
        accuracy: Number(accuracy.toFixed(2)),
        avgLatencyMs: Number(avgLatencyMs.toFixed(2)),
        errors: GLOBAL_STATS.errors,
    };

    appendJsonl(subjectSummaryPath, summary);
    updateDatasetSummary(datasetSummaryPath, "MMLU", safeServerName, {
        server: CONFIG.server,
        api_url: CONFIG.apiUrl,
        api_type: CONFIG.apiType,
        model: CONFIG.modelName,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        limit_per_subject: CONFIG.limitPerSubject,
        subjects: subjects,
        result_dir: resultDir,
        subject_summary_file: subjectSummaryPath,
        text_summary_file: summaryPath,
        total: summary.total,
        correct: summary.correct,
        accuracy: summary.accuracy,
        avgLatencyMs: summary.avgLatencyMs,
        errors: summary.errors,
    });
    fs.appendFileSync(
        summaryPath,
        `TOTAL\t${summary.correct}/${summary.total}\t${summary.accuracy.toFixed(2)}%\tAvgLatency=${summary.avgLatencyMs.toFixed(0)}ms\tErrors=${summary.errors}\n`,
        "utf-8"
    );

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
