const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://127.0.0.1:9501/chat/completions",
    model_name: process.env.INFINILM_MODEL || "9G-8B",
    max_tokens: Number(process.env.TRIVIAQA_MAX_TOKENS || 1024),
    cooldown_ms: Number(process.env.TRIVIAQA_COOLDOWN_MS || 500),
    timeout_ms: Number(process.env.TRIVIAQA_TIMEOUT_MS || 120000),
    data_file: "../data_sets/TriviaQA/verified-web-dev.json",
    limit: Number(process.env.TRIVIAQA_LIMIT || 100)
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
    const systemPrompt = "You are a concise trivia expert.";
    const userPrompt = `Question:
${question}

Instructions:
1. Think step-by-step to recall the correct fact.
2. Output the final answer concisely.
3. Start your final answer strictly with "Answer:".

Example:
... brief reasoning ...
Answer: Paris`;

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

function extractAnswer(rawOutput) {
    if (!rawOutput) return "FORMAT_ERROR";

    let cleanText = String(rawOutput)
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .trim();

    if (cleanText.includes("**🤖 回答:**")) {
        const parts = cleanText.split("**🤖 回答:**");
        cleanText = parts[parts.length - 1].trim();
    } else if (cleanText.includes("</think>")) {
        const parts = cleanText.split("</think>");
        cleanText = parts[parts.length - 1].trim();
    }

    const match = cleanText.match(/\*?Answer:\*?\s*(.*)/i);
    if (match) {
        const result = match[1]
            .split("\n")[0]
            .replace(/^[\s"'[\]()]+|[\s"'[\]()]+$/g, "")
            .trim();
        if (result) return result;
    }

    const lines = cleanText.split("\n").filter(line => line.trim().length > 0);
    if (lines.length > 0 && cleanText.length < 100) {
        return lines[lines.length - 1].replace(/^[\s"'[\]()]+|[\s"'[\]()]+$/g, "").trim();
    }

    return "FORMAT_ERROR";
}

function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer || modelAnswer === "FORMAT_ERROR") return false;
    const answer = modelAnswer.toLowerCase();

    return expectList.some(alias => {
        const normalizedAlias = String(alias).toLowerCase();
        return answer.includes(normalizedAlias) || normalizedAlias.includes(answer);
    });
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
        dataPath = path.join(__dirname, "..", "data_sets", "TriviaQA", "verified-web-dev.json");
    }

    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] Cannot find TriviaQA dataset at ${dataPath}`);
        return;
    }

    console.log(`[INFO] Loading TriviaQA Dataset from: ${dataPath}`);
    const rawData = fs.readFileSync(dataPath, "utf-8");

    let dataset = [];
    try {
        const json = JSON.parse(rawData);
        dataset = json.Data || json;
    } catch (err) {
        console.error(`[ERROR] JSON Parse Failed: ${err.message}`);
        return;
    }

    if (dataset.length > CONFIG.limit) {
        console.log(`[INFO] Dataset size (${dataset.length}) exceeds limit. Truncating to ${CONFIG.limit}.`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    console.log(`[INFO] Start TriviaQA Eval (${total} items) | API: ${CONFIG.api_url}`);
    console.log("------------------------------------------------------------");

    const resDir = path.join(__dirname, "result");
    if (!fs.existsSync(resDir)) fs.mkdirSync(resDir);
    const resFile = path.join(resDir, "triviaqa_res.jsonl");
    fs.writeFileSync(resFile, "");

    let correctCount = 0;
    let totalTime = 0;
    let validResponsesCount = 0;

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.Question;
        const expectList = item.Answer?.NormalizedAliases || [];

        process.stdout.write(`[${i + 1}/${total}] Calculating...`);
        const { content: output, inferenceTime, error, errorMsg } = await ask(question);
        clearProgressLine();

        if (error) {
            console.log(`[${i + 1}/${total}] [ERROR] ${errorMsg}`);
            if (i < total - 1) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
            continue;
        }

        totalTime += inferenceTime;
        validResponsesCount++;

        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) correctCount++;

        const acc = ((correctCount / validResponsesCount) * 100).toFixed(1);
        const avgTime = (totalTime / validResponsesCount).toFixed(1);
        const shortAns = answer.length > 20 ? `${answer.slice(0, 20)}...` : answer;
        const firstExpect = expectList[0] || "N/A";
        const shortExp = firstExpect.length > 20 ? `${firstExpect.slice(0, 20)}...` : firstExpect;

        console.log(`[${i + 1}/${total}] ${correct ? "[OK]" : "[FAIL]"} | Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s (Avg:${avgTime}s) | Ans:${shortAns} (Exp:${shortExp})`);

        const record = {
            id: i + 1,
            q: question,
            out: output,
            ans_ext: answer,
            exp: expectList,
            ok: correct,
            ms: (inferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.cooldown_ms));
        }
    }

    const finalAvgTime = validResponsesCount > 0 ? (totalTime / validResponsesCount).toFixed(2) : "0.00";
    const finalAcc = total > 0 ? ((correctCount / total) * 100).toFixed(2) : "0.00";

    console.log("------------------------------------------------------------");
    console.log(`[SUMMARY] Total: ${total} | Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s`);
}

main();
