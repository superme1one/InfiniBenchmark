const fs = require("fs");
const path = require("path");
const { openChatCompletionStream } = require("./api_client");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://172.22.162.17:8000/chat/completions",
    model_name: process.env.INFINILM_MODEL || "deepseek-r1",
    max_tokens: Number(process.env.TRIVIAQA_MAX_TOKENS || 1024),
    temperature: Number(process.env.TRIVIAQA_TEMPERATURE || 0.1),
    top_p: Number(process.env.TRIVIAQA_TOP_P || 0.9),
    top_k: Number(process.env.TRIVIAQA_TOP_K || 20),
    cooldown_ms: Number(process.env.TRIVIAQA_COOLDOWN_MS || 200),
    timeout_ms: Number(process.env.TRIVIAQA_TIMEOUT_MS || 120000),
    data_file: process.env.TRIVIAQA_DATA_FILE || "../data_sets/TriviaQA/verified-web-dev.json",
    limit: Number(process.env.TRIVIAQA_LIMIT || 100)
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

    const fallback = path.resolve(__dirname, "..", "data_sets", "TriviaQA", "verified-web-dev.json");
    if (fs.existsSync(fallback)) return fallback;

    throw new Error(`Cannot find TriviaQA dataset. Checked: ${primary} and ${fallback}`);
}

function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, "")
        .replace(/<\|endoftext\|>/gi, "")
        .trim();
}

function buildPrompt(question) {
    return `
Question:
${question}

Instructions:
1. Think briefly and recall the correct fact as quickly as possible.
2. Keep the final answer concise: just the entity, title, place, date, or short fact.
3. You must end with exactly one final line in this format: Answer: <final answer>
4. Do not output anything after the final answer.

Example:
<think>
Brief reasoning.
</think>
Answer: Paris
`.trim();
}

async function askStream(question) {
    const payload = {
        model: CONFIG.model_name,
        messages: [
            { role: "system", content: "You are a concise trivia expert who answers efficiently." },
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

function extractAnswer(rawOutput) {
    const cleaned = cleanModelOutput(rawOutput);
    if (!cleaned) return "FORMAT_ERROR";

    const tail = cleaned.includes("</think>")
        ? cleaned.slice(cleaned.lastIndexOf("</think>") + 8).trim()
        : cleaned;

    const explicit = tail.match(/Answer\s*:\s*(.+)/i) || cleaned.match(/Answer\s*:\s*(.+)/i);
    if (explicit) {
        return explicit[1]
            .split(/\r?\n/)[0]
            .replace(/^[\s"'`([{]+|[\s"'`)\]}.,;:!?]+$/g, "")
            .trim() || "FORMAT_ERROR";
    }

    const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (/^(question|instructions|example|response)\s*:/i.test(line)) continue;
        if (/^(let me|i think|i need|first,|the question)/i.test(line)) continue;
        if (line.length > 0 && line.length <= 120) return line;
    }

    return "FORMAT_ERROR";
}

function normalizeTriviaText(text) {
    return String(text || "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .replace(/\b(the|a|an)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer || modelAnswer === "FORMAT_ERROR") return false;

    const normalizedAnswer = normalizeTriviaText(modelAnswer);
    if (!normalizedAnswer) return false;

    return expectList.some((alias) => {
        const normalizedAlias = normalizeTriviaText(alias);
        return normalizedAlias && (
            normalizedAnswer === normalizedAlias ||
            normalizedAnswer.includes(normalizedAlias) ||
            normalizedAlias.includes(normalizedAnswer)
        );
    });
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

    const shortAns = String(answer).length > 24 ? `${String(answer).slice(0, 24)}...` : String(answer);
    const shortExp = String(expected).length > 24 ? `${String(expected).slice(0, 24)}...` : String(expected);
    console.log(
        `[${index}/${total}] [${isCorrect ? "OK" : "FAIL"}] | Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s (Avg:${avgTime}s) | Ans:${shortAns} (Exp:${shortExp})`
    );
}

async function main() {
    const dataPath = resolveDataPath();
    const resDir = path.join(__dirname, "result");
    const resFile = path.join(resDir, "triviaqa_res.jsonl");

    ensureDir(resDir);
    fs.writeFileSync(resFile, "");

    console.log(`[INFO] Loading TriviaQA dataset from: ${dataPath}`);

    let dataset;
    try {
        const parsed = JSON.parse(fs.readFileSync(dataPath, "utf-8"));
        dataset = parsed.Data || parsed;
    } catch (error) {
        throw new Error(`Failed to parse TriviaQA dataset: ${error.message || String(error)}`);
    }

    if (dataset.length > CONFIG.limit) {
        console.log(`[INFO] Dataset size (${dataset.length}) exceeds limit. Truncating to ${CONFIG.limit}.`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    console.log(`[INFO] Start TriviaQA Eval (${total} items) | API: ${CONFIG.api_url}`);
    console.log(`[INFO] Model: ${CONFIG.model_name} | Max tokens: ${CONFIG.max_tokens} | Timeout: ${CONFIG.timeout_ms}ms`);
    console.log("------------------------------------------------------------");

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.Question;
        const expectList = item.Answer?.NormalizedAliases || [];

        printProgress(`[${i + 1}/${total}] Calculating...`);
        const { content, inferenceTime, error, errorMsg } = await askStream(question);

        if (error) {
            logResult(i + 1, total, false, "ERR", expectList[0] || "N/A", 0, errorMsg);
            fs.appendFileSync(resFile, JSON.stringify({
                id: i + 1,
                q: question,
                out: "",
                ans_ext: "ERR",
                exp: expectList,
                ok: false,
                error: errorMsg,
                ms: "0"
            }) + "\n");
        } else {
            const answer = extractAnswer(content);
            const isCorrect = matchExpect(expectList, answer);

            logResult(i + 1, total, isCorrect, answer, expectList[0] || "N/A", inferenceTime);

            fs.appendFileSync(resFile, JSON.stringify({
                id: i + 1,
                q: question,
                out: content,
                ans_ext: answer,
                exp: expectList,
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
