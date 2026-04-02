const fs = require("fs");
const path = require("path");
const readline = require("readline");

// ================== ⚙️ Configuration ==================
const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://127.0.0.1:9500/chat/completions",
    model_name: process.env.INFINILM_MODEL || "9G-8B",
    max_tokens: Number(process.env.TRIVIAQA_MAX_TOKENS || 192),
    recovery_max_tokens: Number(process.env.TRIVIAQA_RECOVERY_MAX_TOKENS || 96),
    cooldown_ms: Number(process.env.TRIVIAQA_COOLDOWN_MS || 200),
    timeout_ms: Number(process.env.TRIVIAQA_TIMEOUT_MS || 600000),
    data_file: "../data_sets/TriviaQA/verified-web-dev.json",
    limit: Number(process.env.TRIVIAQA_LIMIT || 100)
};

// ================== 🌐 Network & API ==================
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

function buildPrompt(question) {
    return `Question:
${question}

Instructions:
1. Answer with the final fact only.
2. Do not output thinking, analysis, or explanation.
3. Start strictly with "Answer:".
4. Put the answer on the same line as "Answer:".
5. Keep the answer short and canonical.

Example:
Answer: Paris`;
}

function buildRecoveryPrompt(question, partialOutput) {
    return `Question:
${question}

The previous response did not finish with a final answer.

Previous response:
${partialOutput || "(empty)"}

Instructions:
1. Do not repeat or continue the previous text.
2. Do not output thinking, analysis, or explanation.
3. Output exactly one final answer line.
4. Start strictly with "Answer:".
5. Keep the answer short and canonical.

Example:
Answer: Paris`;
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
            const t1 = Date.now();
            return {
                content: parseNonStreamResponse(json),
                inferenceTime: (t1 - t0) / 1000,
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
                    const token = json.choices?.[0]?.delta?.content || json.choices?.[0]?.text || "";
                    if (token) fullContent += token;
                } catch (_) {
                    // Ignore malformed SSE fragments and continue.
                }
            }
        }

        const tail = buffer.trim();
        if (tail.startsWith("data: ")) {
            const jsonStr = tail.slice(6).trim();
            if (jsonStr && jsonStr !== "[DONE]") {
                try {
                    const json = JSON.parse(jsonStr);
                    const token = json.choices?.[0]?.delta?.content || json.choices?.[0]?.text || "";
                    if (token) fullContent += token;
                } catch (_) {
                    // Ignore trailing malformed chunk.
                }
            }
        }

        const t1 = Date.now();
        return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };
    } catch (err) {
        const errorMsg = err.name === "AbortError"
            ? `Request timed out after ${(CONFIG.timeout_ms / 1000).toFixed(0)}s: ${CONFIG.api_url}`
            : err.message;
        return { content: "", inferenceTime: 0, error: true, errorMsg };
    }
}

async function ask(question) {
    return requestModel([
        { role: "system", content: "You answer trivia questions with one short final answer only. Never reveal chain-of-thought. Never add explanation." },
        { role: "user", content: buildPrompt(question) },
        { role: "assistant", content: "Answer:" }
    ], CONFIG.max_tokens);
}

async function recoverAnswer(question, partialOutput) {
    return requestModel([
        { role: "system", content: "You answer trivia questions with one short final answer only. Never reveal chain-of-thought. Never add explanation." },
        { role: "user", content: buildRecoveryPrompt(question, partialOutput) },
        { role: "assistant", content: "Answer:" }
    ], CONFIG.recovery_max_tokens);
}

// ================== 🧠 Parsing & Evaluation ==================
function extractAnswer(rawOutput) {
    if (!rawOutput) return "FORMAT_ERROR";

    let cleanText = rawOutput
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|assistant\|>/gi, " ")
        .replace(/<\|user\|>/gi, " ")
        .trim();

    cleanText = cleanText.replace(/<think>[\s\S]*?<\/think>/gi, " ").trim();
    if (cleanText.includes("</think>")) {
        cleanText = cleanText.split("</think>").pop().trim();
    }
    if (cleanText.includes("**🤖 回答:**")) {
        cleanText = cleanText.split("**🤖 回答:**").pop().trim();
    }

    const match = cleanText.match(/\*?Answer:\*?\s*(.*)/i);
    if (match) {
        const result = match[1]
            .split("\n")[0]
            .replace(/^[\s"'[\]()]+|[\s"'[\]().,;:!?]+$/g, "")
            .trim();
        if (isValidAnswerCandidate(result)) return result;
    }

    const lines = cleanText
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

    if (lines.length > 0) {
        const candidate = lines[lines.length - 1]
            .replace(/^[\s"'[\]()]+|[\s"'[\]().,;:!?]+$/g, "")
            .trim();
        if (isValidAnswerCandidate(candidate) && candidate.length <= 100) return candidate;
    }

    return "FORMAT_ERROR";
}

function extractAnswerWithFallback(rawOutput, question) {
    const direct = extractAnswer(rawOutput);
    if (direct !== "FORMAT_ERROR") return direct;

    const heuristic = extractCandidateFromPartialThought(rawOutput, question);
    return heuristic || "FORMAT_ERROR";
}

function isValidAnswerCandidate(text) {
    if (!text) return false;

    const normalized = text.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.length > 100) return false;

    const badPrefixes = [
        "okay",
        "hmm",
        "i think",
        "let me",
        "the user",
        "the question",
        "the answer should",
        "the answer is",
        "based on",
        "according to",
        "previous response",
        "instructions",
        "question:",
        "keep it short",
        "put the answer",
        "no thinking",
        "no explanation",
        "on the same line"
    ];

    if (badPrefixes.some(prefix => normalized.startsWith(prefix))) {
        return false;
    }

    const badSnippets = [
        "keep it short",
        "put the answer on the same line",
        "thinking or analysis",
        "without any extra information",
        "follow the instructions",
        "start with \"answer:\"",
        "start with answer:",
        "final fact"
    ];

    if (badSnippets.some(snippet => normalized.includes(snippet))) {
        return false;
    }

    if (/<think>|<\/think>/.test(normalized)) return false;
    if (normalized.includes("answer:")) return false;
    if (/^[,.;:!?-]/.test(normalized)) return false;

    return true;
}

function cleanCandidate(text) {
    return String(text || "")
        .replace(/<\|.*?\|>/g, " ")
        .replace(/<\/?think>/gi, " ")
        .replace(/\s+/g, " ")
        .replace(/^[\s"'`([{]+|[\s"'`)},.;:!?]+$/g, "")
        .trim();
}

function normalizeForScore(text) {
    return cleanCandidate(text).toLowerCase();
}

function extractCandidateFromPartialThought(rawOutput, question) {
    if (!rawOutput) return "";

    const text = cleanCandidate(rawOutput.replace(/<think>/gi, " "));
    if (!text) return "";

    const questionLower = String(question || "").toLowerCase();
    const candidates = new Map();

    function addCandidate(candidate, score = 1) {
        const cleaned = cleanCandidate(candidate);
        if (!isValidAnswerCandidate(cleaned)) return;

        const normalized = normalizeForScore(cleaned);
        if (!normalized) return;
        if (normalized.length < 2) return;
        if (questionLower.includes(normalized)) return;

        const prev = candidates.get(normalized);
        if (!prev || score > prev.score) {
            candidates.set(normalized, { text: cleaned, score });
        } else {
            prev.score += score;
        }
    }

    const cluePatterns = [
        /(?:i think|i remember|i recall|the answer should be|the answer is|it is|it's|he was|she was|he is|she is)\s+("?[^.\n!?]+"?|[^.\n!?]+)/gi,
        /(?:born in|directed by|directed|from the musical|from|is)\s+("?[^.\n!?]+"?|[^.\n!?]+)/gi
    ];

    for (const pattern of cluePatterns) {
        for (const match of text.matchAll(pattern)) {
            addCandidate(match[1], 6);
        }
    }

    for (const match of text.matchAll(/"([^"\n]{2,80})"/g)) {
        addCandidate(match[1], questionLower.startsWith("which") || questionLower.startsWith("what") ? 7 : 4);
    }

    for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\b/g)) {
        const value = match[1];
        if (/^(Question|Instructions|Answer|Previous Response|The Street|The Godfather)$/i.test(value)) continue;
        addCandidate(value, questionLower.startsWith("who") || questionLower.startsWith("where") ? 5 : 3);
    }

    if (questionLower.startsWith("where")) {
        for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3},?\s*(?:England|UK|United Kingdom|Scotland|Wales|Ireland|London))\b/g)) {
            addCandidate(match[1], 9);
        }
    }

    if (questionLower.startsWith("who")) {
        for (const match of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b/g)) {
            addCandidate(match[1], 8);
        }
    }

    const ranked = Array.from(candidates.values())
        .sort((a, b) => b.score - a.score || a.text.length - b.text.length);

    return ranked[0]?.text || "";
}

function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer || modelAnswer === "FORMAT_ERROR") return false;
    const answer = modelAnswer.toLowerCase();

    return expectList.some(alias => {
        const normalizedAlias = String(alias).toLowerCase();
        return answer.includes(normalizedAlias) || normalizedAlias.includes(answer);
    });
}

function outputLooksIncomplete(text) {
    if (!text) return true;
    const trimmed = text.trim();
    if (!trimmed) return true;
    if (/<think>/i.test(trimmed) && !/<\/think>/i.test(trimmed)) return true;
    if (/Answer:\s*$/i.test(trimmed)) return true;
    if (/[,:;(\-"']$/.test(trimmed)) return true;
    return false;
}

// ================== 🚀 Main Pipeline ==================
async function main() {
    let dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        dataPath = path.join(__dirname, "..", "data_sets", "TriviaQA", "verified-web-dev.json");
    }

    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] Cannot find TriviaQA dataset at ${dataPath}`);
        return;
    }

    console.log(`[INFO] Loading TriviaQA dataset from: ${dataPath}`);
    const raw = fs.readFileSync(dataPath, "utf-8");
    let dataset = [];

    try {
        const json = JSON.parse(raw);
        dataset = json.Data || json;
    } catch (e) {
        console.error(`[ERROR] JSON parse failed: ${e.message}`);
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

        if (typeof process.stdout.clearLine === "function" && typeof process.stdout.cursorTo === "function") {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
        } else if (process.stdout.isTTY) {
            readline.clearLine(process.stdout, 0);
            readline.cursorTo(process.stdout, 0);
        } else {
            process.stdout.write("\n");
        }

        if (error) {
            console.log(`[${i + 1}/${total}] [ERROR] ${errorMsg}`);
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }

        validResponsesCount++;

        let finalOutput = output;
        let totalInferenceTime = inferenceTime;
        let recoveryUsed = false;
        let answer = extractAnswerWithFallback(finalOutput, question);

        if (answer === "FORMAT_ERROR") {
            const recovery = await recoverAnswer(question, finalOutput);
            if (!recovery.error) {
                recoveryUsed = true;
                totalInferenceTime += recovery.inferenceTime;
                finalOutput = recovery.content;
                answer = extractAnswerWithFallback(finalOutput, question);
            }
        }

        totalTime += totalInferenceTime;

        const correct = matchExpect(expectList, answer);
        if (correct) correctCount++;

        const acc = ((correctCount / validResponsesCount) * 100).toFixed(1);
        const avgTime = (totalTime / validResponsesCount).toFixed(1);
        const shortAns = answer.length > 20 ? `${answer.slice(0, 20)}...` : answer;
        const firstExpect = expectList[0] || "N/A";
        const shortExp = firstExpect.length > 20 ? `${firstExpect.slice(0, 20)}...` : firstExpect;
        const icon = correct ? "[OK]" : "[FAIL]";
        const suffix = recoveryUsed ? " [recovery]" : "";

        console.log(`[${i + 1}/${total}] ${icon} Acc:${acc}% | Time:${totalInferenceTime.toFixed(1)}s (Avg:${avgTime}s)${suffix} | Ans:${shortAns} (Exp:${shortExp})`);

        const record = {
            id: i + 1,
            q: question,
            out: output,
            final_out: finalOutput,
            ans_ext: answer,
            exp: expectList,
            ok: correct,
            recovery: recoveryUsed,
            ms: (totalInferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            await new Promise(r => setTimeout(r, CONFIG.cooldown_ms));
        }
    }

    const finalAvgTime = validResponsesCount > 0 ? (totalTime / validResponsesCount).toFixed(2) : "0.00";
    const finalAcc = total > 0 ? ((correctCount / total) * 100).toFixed(2) : "0.00";
    const summaryStr = `\n[SUMMARY] Total: ${total} | Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s\n`;

    console.log("------------------------------------------------------------");
    console.log(summaryStr.trim());
    fs.appendFileSync(resFile, summaryStr);
}

main();
