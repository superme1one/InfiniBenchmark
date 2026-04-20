const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://127.0.0.1:9501/chat/completions",
    model_name: process.env.INFINILM_MODEL || "9G-8B",
    max_tokens: Number(process.env.GSM8K_MAX_TOKENS || 2048),
    cooldown_ms: Number(process.env.GSM8K_COOLDOWN_MS || 500),
    timeout_ms: Number(process.env.GSM8K_TIMEOUT_MS || 300000),
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

async function ask(question) {
    const systemPrompt = "You are a helpful math expert.";
    const userPrompt = `
Question:
${question}

Instructions:
1. Think step-by-step to solve the problem, but keep the reasoning brief.
2. Calculate the final numerical result.
3. Start your final answer strictly with "Answer:".
4. Use digits only in the final answer.

Example:
... brief reasoning ...
Answer: 42
`.trim();

    const payload = {
        model: CONFIG.model_name,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        max_tokens: CONFIG.max_tokens,
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
        return {
            content: "",
            inferenceTime: 0,
            error: true,
            errorMsg: err.name === "AbortError"
                ? `Request timed out after ${(CONFIG.timeout_ms / 1000).toFixed(0)}s: ${CONFIG.api_url}`
                : err.message
        };
    }
}

function extractExpect(answerStr) {
    if (!answerStr) return NaN;
    const match = String(answerStr).match(/####\s*(-?[\d,.]+)/);
    if (!match) return NaN;
    return Number.parseFloat(match[1].replace(/,/g, ""));
}

function extractAnswer(rawOutput) {
    if (!rawOutput) return NaN;

    let cleanText = String(rawOutput)
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .trim();

    const thinkIndex = cleanText.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = cleanText.slice(thinkIndex + 8).trim();
    }

    let match = cleanText.match(/####\s*(-?[\d,.]+)/);
    if (match) {
        return Number.parseFloat(match[1].replace(/,/g, ""));
    }

    match = cleanText.match(/Answer:\s*(-?[\d,.]+)/i);
    if (match) {
        return Number.parseFloat(match[1].replace(/,/g, ""));
    }

    const boxedMatch = cleanText.match(/\\boxed\{(-?[\d,.]+)\}/);
    if (boxedMatch) {
        return Number.parseFloat(boxedMatch[1].replace(/,/g, ""));
    }

    const allNumbers = cleanText.match(/-?[\d,.]+/g);
    if (allNumbers && allNumbers.length > 0) {
        const lastNum = allNumbers[allNumbers.length - 1];
        if (/^-?[\d,.]+$/.test(lastNum)) {
            return Number.parseFloat(lastNum.replace(/,/g, ""));
        }
    }

    return NaN;
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

    console.log(`[INFO] Loaded Dataset: ${dataPath}`);
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
    console.log(`[INFO] Start GSM8K (${total} items) | API: ${CONFIG.api_url}`);
    console.log("------------------------------------------------------------");

    const resDir = path.join(__dirname, "result");
    if (!fs.existsSync(resDir)) fs.mkdirSync(resDir);
    const resFile = path.join(resDir, "gsm8k_res.jsonl");
    fs.writeFileSync(resFile, "");

    let correctCount = 0;
    let totalInferenceTime = 0;
    let validResponsesCount = 0;

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.question;
        const expectVal = extractExpect(item.answer);

        process.stdout.write(`[${i + 1}/${total}] Calculating...`);
        const { content: output, inferenceTime, error, errorMsg } = await ask(question);
        clearProgressLine();

        if (error) {
            console.log(`[${i + 1}/${total}] [ERROR] ${errorMsg}`);
            if (i < total - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            continue;
        }

        totalInferenceTime += inferenceTime;
        validResponsesCount++;

        const answerVal = extractAnswer(output);
        const isCorrect = !Number.isNaN(answerVal) && !Number.isNaN(expectVal) && Math.abs(answerVal - expectVal) < 1e-6;
        if (isCorrect) correctCount++;

        const acc = ((correctCount / (i + 1)) * 100).toFixed(1);
        const avgTime = (totalInferenceTime / validResponsesCount).toFixed(1);
        const shownAnswer = Number.isNaN(answerVal) ? "FORMAT_ERROR" : String(answerVal);

        console.log(
            `[${i + 1}/${total}] ${isCorrect ? "[OK]" : "[FAIL]"} | Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s (Avg:${avgTime}s) | Ans:${shownAnswer} (Exp:${expectVal})`
        );

        const record = {
            id: i + 1,
            q: question,
            out: output,
            ans_ext: Number.isNaN(answerVal) ? "FORMAT_ERROR" : answerVal,
            exp: expectVal,
            ok: isCorrect,
            ms: (inferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.cooldown_ms));
        }
    }

    const finalAcc = total > 0 ? ((correctCount / total) * 100).toFixed(2) : "0.00";
    const finalAvgTime = validResponsesCount > 0 ? (totalInferenceTime / validResponsesCount).toFixed(2) : "0.00";

    console.log("------------------------------------------------------------");
    console.log(`[SUMMARY] Total: ${total} | Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s`);
}

main();
