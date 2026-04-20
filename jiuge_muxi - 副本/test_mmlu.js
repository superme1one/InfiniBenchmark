const fs = require("fs");
const path = require("path");
const { openChatCompletionStream } = require("./api_client");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://172.22.162.17:8000/chat/completions",
    model_name: process.env.INFINILM_MODEL || "9g_8b_thinking",
    max_tokens: Number(process.env.MMLU_MAX_TOKENS || 2048),
    temperature: Number(process.env.MMLU_TEMPERATURE || 0.1),
    top_p: Number(process.env.MMLU_TOP_P || 0.9),
    top_k: Number(process.env.MMLU_TOP_K || 20),
    cooldown_ms: Number(process.env.MMLU_COOLDOWN_MS || 200),
    timeout_ms: Number(process.env.MMLU_TIMEOUT_MS || 120000),
    limit_per_subject: Number(process.env.MMLU_LIMIT_PER_SUBJECT || 100),
    data_dir: process.env.MMLU_DATA_DIR || "../data_sets/MMLU"
};

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
    "sociology", "us_foreign_policy", "virology", "world_religions"
];

const GLOBAL_STATS = {
    total_questions: 0,
    total_correct: 0,
    total_time_ms: 0,
    total_errors: 0
};

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

function normalizeSubjectList() {
    const raw = process.env.MMLU_SUBJECTS;
    if (!raw) return SUBJECTS;

    const wanted = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    const filtered = SUBJECTS.filter((subject) => wanted.includes(subject));
    return filtered.length > 0 ? filtered : SUBJECTS;
}

function resolveDataDir() {
    const primary = path.resolve(__dirname, CONFIG.data_dir);
    if (fs.existsSync(primary)) return primary;

    const fallback = path.resolve(__dirname, "..", "data_sets", "MMLU");
    if (fs.existsSync(fallback)) return fallback;

    throw new Error(`Cannot find MMLU dataset. Checked: ${primary} and ${fallback}`);
}

function parseCSVLine(line) {
    try {
        const parts = [];
        let current = "";
        let inQuote = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            const next = line[i + 1];

            if (char === '"') {
                if (inQuote && next === '"') {
                    current += '"';
                    i += 1;
                } else {
                    inQuote = !inQuote;
                }
                continue;
            }

            if (char === "," && !inQuote) {
                parts.push(current.trim());
                current = "";
                continue;
            }

            current += char;
        }

        parts.push(current.trim());

        if (parts.length < 6) return null;

        const [question, a, b, c, d, answer] = parts;
        return {
            prompt: `${question}\nA) ${a}\nB) ${b}\nC) ${c}\nD) ${d}`,
            answer: String(answer || "").trim().toUpperCase()
        };
    } catch {
        return null;
    }
}

function buildPrompt(questionBlock, subjectName) {
    const subjectLabel = subjectName.replace(/_/g, " ");
    return `
The following is a multiple-choice question about ${subjectLabel}.

Question:
${questionBlock}

Instructions:
1. Think briefly and eliminate wrong choices quickly.
2. Be concise and do not re-check once you reach the best choice.
3. You must end with exactly one final line in this format: Answer: X
4. X must be one of A, B, C, or D.
5. Do not output anything after the final answer.

Example:
<think>
Brief reasoning.
</think>
Answer: A
`.trim();
}

function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, "")
        .replace(/<\|endoftext\|>/gi, "")
        .trim();
}

function extractAnswer(rawOutput) {
    const cleaned = cleanModelOutput(rawOutput);
    if (!cleaned) return "INVALID";

    const tail = cleaned.includes("</think>")
        ? cleaned.slice(cleaned.lastIndexOf("</think>") + 8).trim()
        : cleaned;

    const searchZones = [tail, cleaned];
    const patterns = [
        /Answer\s*:\s*([A-D])\b/i,
        /The answer is\s*([A-D])\b/i,
        /The correct answer is\s*([A-D])\b/i,
        /The correct option is\s*([A-D])\b/i,
        /Option\s*([A-D])\b/i,
        /\\boxed\{\s*([A-D])\s*\}/i
    ];

    for (const zone of searchZones) {
        for (const pattern of patterns) {
            const match = zone.match(pattern);
            if (match) return match[1].toUpperCase();
        }
    }

    const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const exact = line.match(/^([A-D])(?:[.)])?$/i);
        if (exact) return exact[1].toUpperCase();
    }

    const lastWindow = tail.slice(-120);
    const loose = lastWindow.match(/(?:choose|select|pick|option|answer)\s+([A-D])\b/i);
    if (loose) return loose[1].toUpperCase();

    if (cleaned.includes("<think>") && !cleaned.includes("</think>")) {
        return "TRUNCATED";
    }

    return "INVALID";
}

async function askStream(questionBlock, subjectName) {
    const payload = {
        model: CONFIG.model_name,
        messages: [
            {
                role: "system",
                content: `You are an expert in ${subjectName.replace(/_/g, " ")} and a careful multiple-choice solver.`
            },
            {
                role: "user",
                content: buildPrompt(questionBlock, subjectName)
            }
        ],
        max_tokens: CONFIG.max_tokens,
        temperature: CONFIG.temperature,
        top_p: CONFIG.top_p,
        top_k: CONFIG.top_k,
        stream: true
    };

    const startedAt = Date.now();
    let fullContent = "";

    try {
        const { response } = await openChatCompletionStream({
            preferredUrl: CONFIG.api_url,
            payload,
            timeoutMs: CONFIG.timeout_ms
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data:")) continue;

                const data = trimmed.slice(5).trim();
                if (!data || data === "[DONE]") continue;

                try {
                    const json = JSON.parse(data);
                    const choice = json.choices?.[0] || {};
                    const token = choice.delta?.content ?? choice.text ?? "";
                    if (token) fullContent += token;
                } catch {
                    // Ignore malformed SSE chunks and continue collecting.
                }
            }
        }

        const inferenceTime = (Date.now() - startedAt) / 1000;
        return { content: fullContent, inferenceTime, error: false };
    } catch (error) {
        return {
            content: "",
            inferenceTime: 0,
            error: true,
            errorMsg: error.message || String(error)
        };
    }
}

function updateGlobalStats(isCorrect, inferenceTime, isError) {
    GLOBAL_STATS.total_questions += 1;
    if (isCorrect) GLOBAL_STATS.total_correct += 1;
    if (isError) GLOBAL_STATS.total_errors += 1;
    GLOBAL_STATS.total_time_ms += Math.round(inferenceTime * 1000);
}

function logDashboard(subject, index, total, isCorrect, answer, expected, inferenceTime, errorMsg = "") {
    updateGlobalStats(isCorrect, inferenceTime, Boolean(errorMsg));

    const accuracy = GLOBAL_STATS.total_questions > 0
        ? ((GLOBAL_STATS.total_correct / GLOBAL_STATS.total_questions) * 100).toFixed(2)
        : "0.00";
    const avgTime = GLOBAL_STATS.total_questions > 0
        ? (GLOBAL_STATS.total_time_ms / GLOBAL_STATS.total_questions / 1000).toFixed(2)
        : "0.00";

    const icon = errorMsg ? "ERROR" : (isCorrect ? "OK" : "FAIL");
    const line = errorMsg
        ? `[${subject} ${index}/${total}] [${icon}] ${errorMsg} | Acc:${accuracy}% | Avg:${avgTime}s`
        : `[${subject} ${index}/${total}] [${icon}] | Acc:${accuracy}% | Time:${inferenceTime.toFixed(1)}s | Avg:${avgTime}s | Ans:${answer} (Exp:${expected})`;

    clearCurrentLine();
    console.log(line);
}

function buildRecord({ id, subject, data, output, answer, isCorrect, inferenceTime, errorMsg }) {
    return {
        id,
        subject,
        q: data.prompt,
        out: output,
        ans: answer,
        exp: data.answer,
        ok: isCorrect,
        error: errorMsg || "",
        ms: String(Math.round(inferenceTime * 1000))
    };
}

async function evaluateSubject(subject, dataDir, resultDir, summaryFile) {
    const csvPath = path.join(dataDir, `${subject}_test.csv`);
    if (!fs.existsSync(csvPath)) return;

    const rawLines = fs.readFileSync(csvPath, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0);

    const testLines = rawLines.slice(0, CONFIG.limit_per_subject);
    const subjectTotal = testLines.length;
    let subjectCorrect = 0;

    const resultFile = path.join(resultDir, `mmlu_${subject}_res.jsonl`);
    fs.writeFileSync(resultFile, "");

    for (let i = 0; i < subjectTotal; i++) {
        const parsed = parseCSVLine(testLines[i]);
        if (!parsed) continue;

        printProgress(`[${subject} ${i + 1}/${subjectTotal}] Calculating...`);
        const { content, inferenceTime, error, errorMsg } = await askStream(parsed.prompt, subject);

        if (error) {
            logDashboard(subject, i + 1, subjectTotal, false, "ERR", parsed.answer, 0, errorMsg);
            const record = buildRecord({
                id: i + 1,
                subject,
                data: parsed,
                output: "",
                answer: "ERR",
                isCorrect: false,
                inferenceTime: 0,
                errorMsg
            });
            fs.appendFileSync(resultFile, JSON.stringify(record) + "\n");
        } else {
            const answer = extractAnswer(content);
            const isCorrect = answer === parsed.answer;
            if (isCorrect) subjectCorrect += 1;

            logDashboard(subject, i + 1, subjectTotal, isCorrect, answer, parsed.answer, inferenceTime);

            const record = buildRecord({
                id: i + 1,
                subject,
                data: parsed,
                output: content,
                answer,
                isCorrect,
                inferenceTime,
                errorMsg: ""
            });
            fs.appendFileSync(resultFile, JSON.stringify(record) + "\n");
        }

        if (i < subjectTotal - 1 && CONFIG.cooldown_ms > 0) {
            await sleep(CONFIG.cooldown_ms);
        }
    }

    const subjectAcc = subjectTotal > 0
        ? ((subjectCorrect / subjectTotal) * 100).toFixed(1)
        : "0.0";
    fs.appendFileSync(summaryFile, `${subject}: ${subjectAcc}% (${subjectCorrect}/${subjectTotal})\n`);
}

async function main() {
    const subjects = normalizeSubjectList();
    const dataDir = resolveDataDir();
    const resultDir = path.join(__dirname, "result");
    const summaryFile = path.join(resultDir, "mmlu_summary.txt");

    ensureDir(resultDir);
    fs.writeFileSync(summaryFile, `MMLU Test Summary (${new Date().toISOString()})\n\n`);

    console.log(`[INFO] Start MMLU Eval | Subjects: ${subjects.length} | Limit/subject: ${CONFIG.limit_per_subject} | API: ${CONFIG.api_url}`);
    console.log(`[INFO] Model: ${CONFIG.model_name} | Max tokens: ${CONFIG.max_tokens} | Timeout: ${CONFIG.timeout_ms}ms`);
    console.log("----------------------------------------------------------------");

    for (const subject of subjects) {
        await evaluateSubject(subject, dataDir, resultDir, summaryFile);
    }

    const finalAcc = GLOBAL_STATS.total_questions > 0
        ? ((GLOBAL_STATS.total_correct / GLOBAL_STATS.total_questions) * 100).toFixed(2)
        : "0.00";
    const avgTime = GLOBAL_STATS.total_questions > 0
        ? (GLOBAL_STATS.total_time_ms / GLOBAL_STATS.total_questions / 1000).toFixed(2)
        : "0.00";

    console.log("================================================================");
    console.log(`[DONE] Accuracy: ${finalAcc}% (${GLOBAL_STATS.total_correct}/${GLOBAL_STATS.total_questions})`);
    console.log(`[DONE] Avg latency: ${avgTime}s | Errors: ${GLOBAL_STATS.total_errors}`);
    console.log("================================================================");

    fs.appendFileSync(summaryFile, `\nTOTAL AVERAGE: ${finalAcc}%\n`);
    fs.appendFileSync(summaryFile, `TOTAL AVG LATENCY: ${avgTime}s\n`);
    fs.appendFileSync(summaryFile, `TOTAL ERRORS: ${GLOBAL_STATS.total_errors}\n`);
}

main().catch((error) => {
    console.error(`[FATAL] ${error.message || String(error)}`);
    process.exitCode = 1;
});
