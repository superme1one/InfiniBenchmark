const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://127.0.0.1:9500/chat/completions",
    model_name: process.env.INFINILM_MODEL || "9G-8B",
    max_tokens: Number(process.env.MMLU_MAX_TOKENS || 256),
    recovery_max_tokens: Number(process.env.MMLU_RECOVERY_MAX_TOKENS || 48),
    cooldown_ms: Number(process.env.MMLU_COOLDOWN_MS || 200),
    timeout_ms: Number(process.env.MMLU_TIMEOUT_MS || 600000),
    limit_per_subject: Number(process.env.MMLU_LIMIT_PER_SUBJECT || 100),
    data_dir: "../data_sets/MMLU",
    subject_filter: process.env.MMLU_SUBJECTS
        ? process.env.MMLU_SUBJECTS.split(",").map(item => item.trim()).filter(Boolean)
        : null
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
    totalQuestions: 0,
    totalCorrect: 0,
    totalTimeMs: 0
};

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000, ...restOptions } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(resource, { ...restOptions, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function parseNonStreamResponse(json) {
    return json?.choices?.[0]?.message?.content
        || json?.choices?.[0]?.text
        || json?.response
        || json?.content
        || "";
}

async function requestModel(messages, maxTokens) {
    const payload = {
        model: CONFIG.model_name,
        messages,
        max_tokens: maxTokens,
        temperature: 0.1,
        stream: true
    };

    const t0 = Date.now();
    let fullContent = "";

    try {
        const response = await fetchWithTimeout(CONFIG.api_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout: CONFIG.timeout_ms
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`HTTP ${response.status}${errText ? ` - ${errText}` : ""}`);
        }

        const contentType = response.headers.get("content-type") || "";
        if (!response.body || !contentType.toLowerCase().includes("text/event-stream")) {
            const json = await response.json();
            return {
                content: parseNonStreamResponse(json),
                inferenceTime: (Date.now() - t0) / 1000,
                error: false
            };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed.startsWith("data: ")) continue;

                const jsonStr = trimmed.slice(6).trim();
                if (!jsonStr || jsonStr === "[DONE]") continue;

                try {
                    const json = JSON.parse(jsonStr);
                    const token = json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.text || "";
                    if (token) fullContent += token;
                } catch (_) {
                    // Ignore malformed SSE fragments.
                }
            }
        }

        const tail = buffer.trim();
        if (tail.startsWith("data: ")) {
            const jsonStr = tail.slice(6).trim();
            if (jsonStr && jsonStr !== "[DONE]") {
                try {
                    const json = JSON.parse(jsonStr);
                    const token = json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.text || "";
                    if (token) fullContent += token;
                } catch (_) {
                    // Ignore trailing malformed chunk.
                }
            }
        }

        return { content: fullContent, inferenceTime: (Date.now() - t0) / 1000, error: false };
    } catch (err) {
        const errorMsg = err.name === "AbortError"
            ? `Request timed out after ${(CONFIG.timeout_ms / 1000).toFixed(0)}s: ${CONFIG.api_url}`
            : err.message;
        return { content: "", inferenceTime: 0, error: true, errorMsg };
    }
}

function buildPrompt(prompt, subjectName) {
    return `The following is a multiple-choice question about ${subjectName.replace(/_/g, " ")}.

Question:
${prompt}

Instructions:
1. Choose the single best option.
2. Do not output explanation.
3. Output exactly one line in the format "Answer: X".
4. X must be one of A, B, C, or D.

Example:
Answer: A`;
}

function buildRecoveryPrompt(prompt, partialOutput) {
    return `Question:
${prompt}

The previous response did not end with a valid option.

Previous response:
${partialOutput || "(empty)"}

Instructions:
1. Do not repeat the explanation.
2. Output exactly one line.
3. Start strictly with "Answer:".
4. The answer must be one of A, B, C, or D.

Example:
Answer: B`;
}

async function askQuestion(prompt, subjectName) {
    return requestModel([
        { role: "system", content: `You are an expert in ${subjectName.replace(/_/g, " ")}. Reply with one final multiple-choice answer only.` },
        { role: "user", content: buildPrompt(prompt, subjectName) },
        { role: "assistant", content: "Answer:" }
    ], CONFIG.max_tokens);
}

async function recoverAnswer(prompt, partialOutput) {
    return requestModel([
        { role: "system", content: "Reply with one final multiple-choice answer only. Do not reveal chain-of-thought." },
        { role: "user", content: buildRecoveryPrompt(prompt, partialOutput) },
        { role: "assistant", content: "Answer:" }
    ], CONFIG.recovery_max_tokens);
}

function parseCSVLine(line) {
    try {
        const parts = [];
        let current = "";
        let inQuote = false;

        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuote = !inQuote;
            } else if (char === "," && !inQuote) {
                parts.push(current.trim().replace(/^"|"$/g, ""));
                current = "";
            } else {
                current += char;
            }
        }
        parts.push(current.trim().replace(/^"|"$/g, ""));

        if (parts.length < 6) return null;

        return {
            prompt: `${parts[0]}\nA) ${parts[1]}\nB) ${parts[2]}\nC) ${parts[3]}\nD) ${parts[4]}`,
            answer: String(parts[5]).trim().toUpperCase()
        };
    } catch (_) {
        return null;
    }
}

function sanitizeOutput(rawOutput) {
    return String(rawOutput || "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|assistant\|>/gi, " ")
        .replace(/<\|user\|>/gi, " ")
        .replace(/<think>[\s\S]*?<\/think>/gi, " ")
        .replace(/<\/think>/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractAnswer(rawOutput) {
    const cleanText = sanitizeOutput(rawOutput);
    if (!cleanText) return "INVALID";

    const patterns = [
        /Answer:\s*([A-D])/i,
        /(?:correct answer|best answer|option)\s*[: ]\s*([A-D])/i,
        /\\boxed\{([A-D])\}/i,
        /\b([A-D])\b/
    ];

    for (const pattern of patterns) {
        const match = cleanText.match(pattern);
        if (match) return match[1].toUpperCase();
    }

    return "INVALID";
}

function clearProgressLine() {
    if (typeof process.stdout.clearLine === "function" && typeof process.stdout.cursorTo === "function") {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        return;
    }

    if (process.stdout.isTTY) {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        return;
    }

    process.stdout.write("\n");
}

function logDashboard(subject, currentQ, totalSubjectQ, isCorrect, answer, expected, time, errorMsg = null, recoveryUsed = false) {
    GLOBAL_STATS.totalQuestions++;
    if (isCorrect) GLOBAL_STATS.totalCorrect++;
    GLOBAL_STATS.totalTimeMs += time * 1000;

    const globalAcc = ((GLOBAL_STATS.totalCorrect / GLOBAL_STATS.totalQuestions) * 100).toFixed(2);
    const globalAvgTime = (GLOBAL_STATS.totalTimeMs / GLOBAL_STATS.totalQuestions / 1000).toFixed(2);
    const suffix = recoveryUsed ? " [recovery]" : "";

    if (errorMsg) {
        console.log(`[${subject}] ${currentQ}/${totalSubjectQ} [ERROR] ${errorMsg} | Global Acc:${globalAcc}% | Avg:${globalAvgTime}s`);
        return;
    }

    console.log(
        `[${subject}] ${currentQ}/${totalSubjectQ} ${isCorrect ? "[OK]" : "[FAIL]"}${suffix} | Ans:${answer} (Exp:${expected}) | ${time.toFixed(1)}s | Global Acc:${globalAcc}% | Avg:${globalAvgTime}s`
    );
}

async function main() {
    let dataDir = path.join(__dirname, CONFIG.data_dir);
    if (!fs.existsSync(dataDir)) {
        dataDir = path.join(__dirname, "..", "data_sets", "MMLU");
    }

    if (!fs.existsSync(dataDir)) {
        console.error(`[ERROR] Cannot find MMLU dataset directory at ${dataDir}`);
        return;
    }

    const subjects = CONFIG.subject_filter
        ? SUBJECTS.filter(subject => CONFIG.subject_filter.includes(subject))
        : SUBJECTS;

    const resultDir = path.join(__dirname, "result");
    if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir);

    const summaryFile = path.join(resultDir, "mmlu_summary.txt");
    fs.writeFileSync(summaryFile, `MMLU Test Summary (${new Date().toISOString()})\nAPI: ${CONFIG.api_url}\nModel: ${CONFIG.model_name}\n\n`);

    console.log(`[INFO] Start MMLU Eval | Subjects: ${subjects.length} | Limit/subject: ${CONFIG.limit_per_subject} | API: ${CONFIG.api_url}`);
    console.log("----------------------------------------------------------------");

    for (const subject of subjects) {
        const csvPath = path.join(dataDir, `${subject}_test.csv`);
        if (!fs.existsSync(csvPath)) continue;

        const rawFile = fs.readFileSync(csvPath, "utf-8");
        const lines = rawFile.split(/\r?\n/).filter(line => line.trim().length > 0);
        const testLines = lines.slice(0, CONFIG.limit_per_subject);
        const subTotal = testLines.length;

        let subCorrect = 0;
        let subSeen = 0;
        const resFile = path.join(resultDir, `mmlu_${subject}_res.jsonl`);
        fs.writeFileSync(resFile, "");

        for (let i = 0; i < subTotal; i++) {
            const data = parseCSVLine(testLines[i]);
            if (!data) continue;

            process.stdout.write(`[${subject} ${i + 1}/${subTotal}] Calculating...`);
            const initial = await askQuestion(data.prompt, subject);
            clearProgressLine();

            if (initial.error) {
                logDashboard(subject, i + 1, subTotal, false, "ERR", data.answer, 0, initial.errorMsg);
                if (i < subTotal - 1) await new Promise(resolve => setTimeout(resolve, 1000));
                continue;
            }

            let finalOutput = initial.content;
            let totalInferenceTime = initial.inferenceTime;
            let recoveryUsed = false;
            let answer = extractAnswer(finalOutput);

            if (answer === "INVALID") {
                const recovery = await recoverAnswer(data.prompt, finalOutput);
                if (!recovery.error) {
                    recoveryUsed = true;
                    totalInferenceTime += recovery.inferenceTime;
                    finalOutput = recovery.content;
                    answer = extractAnswer(finalOutput);
                }
            }

            subSeen++;
            const isCorrect = answer === data.answer;
            if (isCorrect) subCorrect++;

            logDashboard(subject, i + 1, subTotal, isCorrect, answer, data.answer, totalInferenceTime, null, recoveryUsed);

            const record = {
                id: i + 1,
                subject,
                q: data.prompt,
                out: initial.content,
                final_out: finalOutput,
                ans: answer,
                exp: data.answer,
                ok: isCorrect,
                recovery: recoveryUsed,
                ms: (totalInferenceTime * 1000).toFixed(0)
            };
            fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

            if (i < subTotal - 1) {
                await new Promise(resolve => setTimeout(resolve, CONFIG.cooldown_ms));
            }
        }

        const subAcc = subSeen > 0 ? ((subCorrect / subSeen) * 100).toFixed(1) : "0.0";
        fs.appendFileSync(summaryFile, `${subject}: ${subAcc}% (${subCorrect}/${subSeen})\n`);
    }

    const finalAcc = GLOBAL_STATS.totalQuestions > 0
        ? ((GLOBAL_STATS.totalCorrect / GLOBAL_STATS.totalQuestions) * 100).toFixed(2)
        : "0.00";
    const finalAvgTime = GLOBAL_STATS.totalQuestions > 0
        ? (GLOBAL_STATS.totalTimeMs / GLOBAL_STATS.totalQuestions / 1000).toFixed(2)
        : "0.00";

    console.log("----------------------------------------------------------------");
    console.log(`[SUMMARY] Accuracy: ${finalAcc}% (${GLOBAL_STATS.totalCorrect}/${GLOBAL_STATS.totalQuestions}) | Avg Latency: ${finalAvgTime}s`);
    fs.appendFileSync(summaryFile, `\nTOTAL AVERAGE: ${finalAcc}% (${GLOBAL_STATS.totalCorrect}/${GLOBAL_STATS.totalQuestions})\n`);
}

main();
