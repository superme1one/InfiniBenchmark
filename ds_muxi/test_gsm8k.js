const fs = require("fs");
const path = require("path");
const { openChatCompletionStream } = require("./api_client");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://172.22.162.17:8000/chat/completions",
    model_name: process.env.INFINILM_MODEL || "deepseek-r1",
    max_tokens: Number(process.env.GSM8K_MAX_TOKENS || 2048),
    temperature: Number(process.env.GSM8K_TEMPERATURE || 0.1),
    top_p: Number(process.env.GSM8K_TOP_P || 1.0),
    top_k: Number(process.env.GSM8K_TOP_K || 1),
    cooldown_ms: Number(process.env.GSM8K_COOLDOWN_MS || 200),
    timeout_ms: Number(process.env.GSM8K_TIMEOUT_MS || 120000),
    data_file: process.env.GSM8K_DATA_FILE || "../data_sets/GSM8k/test.jsonl",
    limit: Number(process.env.GSM8K_LIMIT || 100)
};

const STATS = {
    total: 0,
    correct: 0,
    errors: 0,
    total_time_ms: 0
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

function resolveDataPath() {
    const primary = path.resolve(__dirname, CONFIG.data_file);
    if (fs.existsSync(primary)) return primary;

    const fallback = path.resolve(__dirname, "..", "data_sets", "GSM8k", "test.jsonl");
    if (fs.existsSync(fallback)) return fallback;

    throw new Error(`Cannot find GSM8K dataset. Checked: ${primary} and ${fallback}`);
}

function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, "")
        .replace(/<\|endoftext\|>/gi, "")
        .trim();
}

function extractExpect(answerStr) {
    if (!answerStr) return NaN;

    const match = String(answerStr).match(/####\s*(-?[\d,.]+)/);
    return match ? Number(match[1].replace(/,/g, "")) : NaN;
}

function extractAnswer(rawOutput) {
    const cleaned = cleanModelOutput(rawOutput);
    if (!cleaned) return NaN;

    const tail = cleaned.includes("</think>")
        ? cleaned.slice(cleaned.lastIndexOf("</think>") + 8).trim()
        : cleaned;

    const patterns = [
        /####\s*(-?[\d,.]+)/,
        /Answer\s*:\s*(-?[\d,.]+)/i,
        /The answer is\s*(-?[\d,.]+)/i,
        /\\boxed\{\s*(-?[\d,.]+)\s*\}/
    ];

    for (const pattern of patterns) {
        const match = tail.match(pattern) || cleaned.match(pattern);
        if (match) return Number(match[1].replace(/,/g, ""));
    }

    const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const exact = line.match(/^-?[\d,.]+$/);
        if (exact) return Number(exact[0].replace(/,/g, ""));
    }

    const allNumbers = tail.match(/-?[\d,.]+/g) || cleaned.match(/-?[\d,.]+/g);
    if (allNumbers && allNumbers.length > 0) {
        return Number(allNumbers[allNumbers.length - 1].replace(/,/g, ""));
    }

    return NaN;
}

function buildPrompt(question) {
    return `
Question:
${question}

Instructions:
1. Think step-by-step to solve the problem carefully.
2. Be concise, but include enough calculation to avoid arithmetic mistakes.
3. Double-check the final arithmetic once before giving the answer.
4. You must end with exactly one final line in this format: #### <final_number>
5. Do not output anything after the final answer.

Example:
<think>
Reason through the calculation clearly.
</think>
#### 42
`.trim();
}

async function askStream(question) {
    const payload = {
        model: CONFIG.model_name,
        messages: [
            { role: "system", content: "You are a careful math expert. Solve word problems accurately and keep the final format exact." },
            { role: "user", content: buildPrompt(question) }
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
                    // Ignore malformed chunks and keep reading.
                }
            }
        }

        return {
            content: fullContent,
            inferenceTime: (Date.now() - startedAt) / 1000,
            error: false
        };
    } catch (error) {
        return {
            content: "",
            inferenceTime: 0,
            error: true,
            errorMsg: error.message || String(error)
        };
    }
}

function logResult(index, total, isCorrect, answer, expected, inferenceTime, errorMsg = "") {
    STATS.total += 1;
    if (isCorrect) STATS.correct += 1;
    if (errorMsg) STATS.errors += 1;
    STATS.total_time_ms += Math.round(inferenceTime * 1000);

    const acc = STATS.total > 0 ? ((STATS.correct / STATS.total) * 100).toFixed(1) : "0.0";
    const avgTime = STATS.total > 0 ? (STATS.total_time_ms / STATS.total / 1000).toFixed(1) : "0.0";

    clearCurrentLine();
    if (errorMsg) {
        console.log(`[${index}/${total}] [ERROR] ${errorMsg} | Acc:${acc}% | Avg:${avgTime}s`);
        return;
    }

    console.log(
        `[${index}/${total}] [${isCorrect ? "OK" : "FAIL"}] | Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s (Avg:${avgTime}s) | Ans:${String(answer)} (Exp:${String(expected)})`
    );
}

async function main() {
    const dataPath = resolveDataPath();
    const resDir = path.join(__dirname, "result");
    const resFile = path.join(resDir, "gsm8k_res.jsonl");

    ensureDir(resDir);
    fs.writeFileSync(resFile, "");

    console.log(`[INFO] Loading GSM8K dataset from: ${dataPath}`);
    let dataset = fs.readFileSync(dataPath, "utf-8")
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);

    if (dataset.length > CONFIG.limit) {
        console.log(`[INFO] Dataset size (${dataset.length}) exceeds limit. Truncating to ${CONFIG.limit}.`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    console.log(`[INFO] Start GSM8K (${total} items) | API: ${CONFIG.api_url}`);
    console.log(`[INFO] Model: ${CONFIG.model_name} | Max tokens: ${CONFIG.max_tokens} | Timeout: ${CONFIG.timeout_ms}ms`);
    console.log("------------------------------------------------------------");

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.question;
        const expected = extractExpect(item.answer);

        printProgress(`[${i + 1}/${total}] Calculating...`);
        const { content, inferenceTime, error, errorMsg } = await askStream(question);

        if (error) {
            logResult(i + 1, total, false, "ERR", expected, 0, errorMsg);
            fs.appendFileSync(resFile, JSON.stringify({
                id: i + 1,
                q: question,
                out: "",
                ans_ext: "ERR",
                exp: expected,
                ok: false,
                error: errorMsg,
                ms: "0"
            }) + "\n");
        } else {
            const answer = extractAnswer(content);
            const isCorrect = !Number.isNaN(answer) && !Number.isNaN(expected) && Math.abs(answer - expected) < 1e-6;

            logResult(i + 1, total, isCorrect, Number.isNaN(answer) ? "NaN" : answer, expected, inferenceTime);

            fs.appendFileSync(resFile, JSON.stringify({
                id: i + 1,
                q: question,
                out: content,
                ans_ext: Number.isNaN(answer) ? "NaN" : answer,
                exp: expected,
                ok: isCorrect,
                error: "",
                ms: String(Math.round(inferenceTime * 1000))
            }) + "\n");
        }

        if (i < total - 1 && CONFIG.cooldown_ms > 0) {
            await sleep(CONFIG.cooldown_ms);
        }
    }

    const finalAcc = STATS.total > 0 ? ((STATS.correct / STATS.total) * 100).toFixed(2) : "0.00";
    const finalAvgTime = STATS.total > 0 ? (STATS.total_time_ms / STATS.total / 1000).toFixed(2) : "0.00";

    console.log("------------------------------------------------------------");
    console.log(`[SUMMARY] Total: ${STATS.total} | Correct: ${STATS.correct} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s | Errors: ${STATS.errors}`);
    fs.appendFileSync(resFile, `\n[SUMMARY] Total: ${STATS.total} | Correct: ${STATS.correct} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s | Errors: ${STATS.errors}\n`);
}

main().catch((error) => {
    console.error(`[FATAL] ${error.message || String(error)}`);
    process.exitCode = 1;
});
