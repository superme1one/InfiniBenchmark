const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://127.0.0.1:9500/chat/completions",
    model_name: process.env.INFINILM_MODEL || "9G-8B",
    max_tokens: Number(process.env.GSM8K_MAX_TOKENS || 512),
    recovery_max_tokens: Number(process.env.GSM8K_RECOVERY_MAX_TOKENS || 96),
    cooldown_ms: Number(process.env.GSM8K_COOLDOWN_MS || 500),
    timeout_ms: Number(process.env.GSM8K_TIMEOUT_MS || 600000),
    limit: Number(process.env.GSM8K_LIMIT || 100),
    data_file: "../data_sets/GSM8k/test.jsonl"
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

function buildPrompt(question) {
    return `Question:
${question}

Instructions:
1. Solve the math word problem.
2. Keep the reasoning brief.
3. Output the final result strictly as "Answer: <number>".
4. Use digits only for the final number. Do not add units or words.

Example:
Answer: 42`;
}

function buildRecoveryPrompt(question, partialOutput) {
    return `Question:
${question}

The previous response did not end with a clear final number.

Previous response:
${partialOutput || "(empty)"}

Instructions:
1. Do not repeat the reasoning.
2. Output exactly one line.
3. Start strictly with "Answer:".
4. Put only the final number after "Answer:".

Example:
Answer: 42`;
}

async function askQuestion(question) {
    return requestModel([
        { role: "system", content: "You solve math word problems and return one final numeric answer. Do not reveal chain-of-thought." },
        { role: "user", content: buildPrompt(question) }
    ], CONFIG.max_tokens);
}

async function recoverAnswer(question, partialOutput) {
    return requestModel([
        { role: "system", content: "You solve math word problems and return one final numeric answer. Do not reveal chain-of-thought." },
        { role: "user", content: buildRecoveryPrompt(question, partialOutput) },
        { role: "assistant", content: "Answer:" }
    ], CONFIG.recovery_max_tokens);
}

function extractExpect(answerStr) {
    if (!answerStr) return NaN;

    const match = String(answerStr).match(/####\s*(-?[\d,.]+)/);
    if (!match) return NaN;

    return Number.parseFloat(match[1].replace(/,/g, ""));
}

function sanitizeOutput(rawOutput) {
    return String(rawOutput || "")
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|assistant\|>/gi, " ")
        .replace(/<\|user\|>/gi, " ")
        .replace(/<think>/gi, " ")
        .replace(/<\/think>/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function extractAnswer(rawOutput) {
    const cleanText = sanitizeOutput(rawOutput);
    if (!cleanText) return NaN;

    const patterns = [
        /Answer:\s*[^\d-]*(-?[\d,.]+)/i,
        /(?:final answer|the answer is)\s*[: ]\s*(-?[\d,.]+)/i,
        /\\boxed\{(-?[\d,.]+)\}/i
    ];

    for (const pattern of patterns) {
        const match = cleanText.match(pattern);
        if (match) {
            const value = Number.parseFloat(match[1].replace(/,/g, ""));
            if (!Number.isNaN(value)) return value;
        }
    }

    const allNumbers = cleanText.match(/-?[\d,.]+/g);
    if (!allNumbers || allNumbers.length === 0) return NaN;

    const lastNum = allNumbers[allNumbers.length - 1];
    const value = Number.parseFloat(lastNum.replace(/,/g, ""));
    return Number.isNaN(value) ? NaN : value;
}

function safeProgress(message) {
    process.stdout.write(message);
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

async function main() {
    let dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        dataPath = path.join(__dirname, "..", "data_sets", "GSM8k", "test.jsonl");
    }

    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] Cannot find GSM8K dataset at ${dataPath}`);
        return;
    }

    console.log(`[INFO] Loading GSM8K dataset from: ${dataPath}`);
    const rawData = fs.readFileSync(dataPath, "utf-8");
    let dataset = rawData
        .split(/\r?\n/)
        .filter(line => line.trim() !== "")
        .map(line => {
            try {
                return JSON.parse(line);
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean);

    if (dataset.length > CONFIG.limit) {
        console.log(`[INFO] Dataset size (${dataset.length}) exceeds limit. Truncating to ${CONFIG.limit}.`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    console.log(`[INFO] Start GSM8K Eval (${total} items) | API: ${CONFIG.api_url}`);
    console.log("------------------------------------------------------------");

    const resultDir = path.join(__dirname, "result");
    if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir);
    const resFile = path.join(resultDir, "gsm8k_res.jsonl");
    fs.writeFileSync(resFile, "");

    let correctCount = 0;
    let successCount = 0;
    let totalTime = 0;

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.question;
        const expectVal = extractExpect(item.answer);

        safeProgress(`[${i + 1}/${total}] Calculating...`);

        const initial = await askQuestion(question);
        clearProgressLine();

        if (initial.error) {
            console.log(`[${i + 1}/${total}] [ERROR] ${initial.errorMsg}`);
            if (i < total - 1) await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
        }

        let finalOutput = initial.content;
        let totalInferenceTime = initial.inferenceTime;
        let recoveryUsed = false;
        let answerVal = extractAnswer(finalOutput);

        if (Number.isNaN(answerVal)) {
            const recovery = await recoverAnswer(question, finalOutput);
            if (!recovery.error) {
                recoveryUsed = true;
                totalInferenceTime += recovery.inferenceTime;
                finalOutput = recovery.content;
                answerVal = extractAnswer(finalOutput);
            }
        }

        successCount++;
        totalTime += totalInferenceTime;

        const isCorrect = !Number.isNaN(answerVal) && !Number.isNaN(expectVal) && Math.abs(answerVal - expectVal) < 1e-6;
        if (isCorrect) correctCount++;

        const acc = ((correctCount / successCount) * 100).toFixed(1);
        const avgTime = (totalTime / successCount).toFixed(1);
        const suffix = recoveryUsed ? " [recovery]" : "";
        const shownAnswer = Number.isNaN(answerVal) ? "FORMAT_ERROR" : String(answerVal);

        console.log(`[${i + 1}/${total}] ${isCorrect ? "[OK]" : "[FAIL]"} Acc:${acc}% | Time:${totalInferenceTime.toFixed(1)}s (Avg:${avgTime}s)${suffix} | Ans:${shownAnswer} (Exp:${expectVal})`);

        const record = {
            id: i + 1,
            q: question,
            out: initial.content,
            final_out: finalOutput,
            ans_ext: Number.isNaN(answerVal) ? "FORMAT_ERROR" : answerVal,
            exp: expectVal,
            ok: isCorrect,
            recovery: recoveryUsed,
            ms: (totalInferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.cooldown_ms));
        }
    }

    if (successCount === 0) {
        console.log("------------------------------------------------------------");
        console.log(`[SUMMARY] All ${total} requests failed. No model responses were received.`);
        return;
    }

    const finalAcc = ((correctCount / total) * 100).toFixed(2);
    const finalAvgTime = (totalTime / successCount).toFixed(2);

    console.log("------------------------------------------------------------");
    console.log(`[SUMMARY] Total: ${total} | Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s`);
}

main();
