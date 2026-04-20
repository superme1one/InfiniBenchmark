const fs = require("fs");
const path = require("path");
const readline = require("readline");

const CONFIG = {
    api_url: process.env.INFINILM_API_URL || "http://127.0.0.1:9501/chat/completions",
    model_name: process.env.INFINILM_MODEL || "9G-8B",
    max_tokens: Number(process.env.DROP_MAX_TOKENS || 2048),
    cooldown_ms: Number(process.env.DROP_COOLDOWN_MS || 500),
    timeout_ms: Number(process.env.DROP_TIMEOUT_MS || 300000),
    data_file: "../data_sets/DROP/train.jsonl",
    limit: Number(process.env.DROP_LIMIT || 100)
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

function buildBasePrompt(passage, question) {
    return `Passage:
${passage}

Question:
${question}`;
}

function hasNumberType(types) {
    return Array.isArray(types) && types.some(t => String(t).toLowerCase() === "number");
}

function buildInstructions(isNumberType) {
    return isNumberType
        ? `Instructions:
1. Read the passage carefully and answer the question using only the passage.
2. Think briefly before answering.
3. If the answer is a number, use Arabic numerals.
4. Put the final answer on the last line in this format: Answer: <final answer>
5. Do not output anything after the final answer.`
        : `Instructions:
1. Read the passage carefully and answer the question using only the passage.
2. Think briefly before answering.
3. Extract the answer directly from the passage when possible.
4. Put the final answer on the last line in this format: Answer: <final answer>
5. Do not output anything after the final answer.`;
}

async function ask(passage, question, isNumberType) {
    const systemPrompt = "You are a careful reading comprehension assistant. Answer only from the passage.";
    const userPrompt = `${buildBasePrompt(passage, question)}

${buildInstructions(isNumberType)}`;

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
                    // ignore malformed SSE fragments
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
                    // ignore trailing malformed chunk
                }
            }
        }

        return {
            content: fullContent,
            inferenceTime: (Date.now() - t0) / 1000,
            error: false
        };
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

function normalizeAnswer(value) {
    if (!value) return "";
    return String(value)
        .toLowerCase()
        .replace(/\b(a|an|the)\b/g, " ")
        .replace(/[.,!?;:"]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/<\|im_end\|>/gi, " ")
        .replace(/<\|endoftext\|>/gi, " ")
        .replace(/<\|eot_id\|>/gi, " ")
        .replace(/<\/?think>/gi, " ")
        .replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, " "))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function extractExplicitAnswer(cleanText, isNumberType) {
    const matches = [...cleanText.matchAll(/Answer:\s*(.+)/gi)];
    if (matches.length === 0) return "";

    let result = matches[matches.length - 1][1].split("\n")[0].trim();
    result = result.replace(/^[\s"'«»“”‘’>\[\]()]+|[\s"'«»“”‘’>\[\]()]+$/g, "").trim();

    if (!result) return "";

    if (isNumberType) {
        const numMatch = result.match(/-?\d+(?:\.\d+)?/);
        return numMatch ? numMatch[0] : "";
    }

    return result;
}

function extractNumberFallback(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];

        if (line.length > 40) continue;

        if (/^-?\d+(?:\.\d+)?$/.test(line)) {
            return line;
        }

        const m = line.match(/(?:is|was|were|equals?|equal to|needed|scored|total(?:ed)?|for)\s+(-?\d+(?:\.\d+)?)(?:\b|$)/i);
        if (m) return m[1];
    }

    return "";
}

function extractTextFallback(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];

        if (!line || line.length > 80) continue;
        if (/^(reasoning|analysis|explanation|step|steps)/i.test(line)) continue;
        if (/^(therefore|thus|so|hence|from the passage)[,:]?\s*$/i.test(line)) continue;
        if (/[.?!]$/.test(line) && line.length > 40) continue;

        return line.replace(/^[\s"'«»“”‘’>\[\]()]+|[\s"'«»“”‘’>\[\]()]+$/g, "").trim();
    }

    return "";
}

function extractAnswer(rawOutput, isNumberType = false) {
    if (!rawOutput) return "";

    const cleanText = cleanModelOutput(rawOutput);

    const explicit = extractExplicitAnswer(cleanText, isNumberType);
    if (explicit) return explicit;

    const lines = cleanText
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

    if (isNumberType) {
        return extractNumberFallback(lines);
    }

    return extractTextFallback(lines);
}

function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer) return false;
    const normalizedModel = normalizeAnswer(modelAnswer);

    return expectList.some(exp => {
        const normalizedExp = normalizeAnswer(exp);

        if (normalizedModel === normalizedExp) return true;
        if (normalizedModel.includes(normalizedExp)) return true;
        if (normalizedExp.includes(normalizedModel) && normalizedModel.length >= 2) return true;

        const numModel = Number.parseFloat(normalizedModel);
        const numExp = Number.parseFloat(normalizedExp);
        if (!Number.isNaN(numModel) && !Number.isNaN(numExp)) {
            return Math.abs(numModel - numExp) < 1e-6;
        }

        return false;
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

function shorten(text, maxLen = 20) {
    const s = String(text || "");
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
}

function loadExistingResults(resFile) {
    if (!fs.existsSync(resFile)) {
        return {
            records: [],
            completedIds: new Set(),
            correctCount: 0,
            totalTime: 0,
            validResponsesCount: 0
        };
    }

    const lines = fs.readFileSync(resFile, "utf-8")
        .split(/\r?\n/)
        .filter(line => line.trim() !== "");

    const records = [];
    const completedIds = new Set();
    let correctCount = 0;
    let totalTime = 0;
    let validResponsesCount = 0;

    for (const line of lines) {
        try {
            const rec = JSON.parse(line);
            if (!rec || typeof rec !== "object") continue;

            records.push(rec);

            if (Number.isInteger(rec.id) && rec.id > 0) {
                completedIds.add(rec.id);
            }

            if (rec.ok) correctCount++;

            const ms = Number(rec.ms);
            if (!Number.isNaN(ms) && ms >= 0) {
                totalTime += ms / 1000;
                validResponsesCount++;
            }
        } catch (_) {
            // ignore malformed lines
        }
    }

    return {
        records,
        completedIds,
        correctCount,
        totalTime,
        validResponsesCount
    };
}

async function main() {
    let dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        dataPath = path.join(__dirname, "..", "data_sets", "DROP", "train.jsonl");
    }

    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] Cannot find DROP dataset at ${dataPath}`);
        return;
    }

    console.log("[INFO] Loading DROP dataset...");
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
    console.log(`[INFO] Start DROP Eval (${total} items) | API: ${CONFIG.api_url}`);
    console.log("------------------------------------------------------------");

    const resultDir = path.join(__dirname, "result");
    if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir);

    const resFile = path.join(resultDir, "drop_res_optimized.jsonl");

    const {
        records,
        completedIds,
        correctCount: loadedCorrectCount,
        totalTime: loadedTotalTime,
        validResponsesCount: loadedValidResponsesCount
    } = loadExistingResults(resFile);

    let correctCount = loadedCorrectCount;
    let totalTime = loadedTotalTime;
    let validResponsesCount = loadedValidResponsesCount;

    if (records.length > 0) {
        const maxCompletedId = Math.max(...records.map(r => Number(r.id) || 0));
        console.log(
            `[RESUME] Found ${records.length} existing records, ` +
            `${completedIds.size} completed items. Next candidate: ${Math.min(maxCompletedId + 1, total)}`
        );
    } else {
        console.log("[RESUME] No existing result file found. Starting fresh.");
    }

    for (let i = 0; i < total; i++) {
        const itemId = i + 1;

        if (completedIds.has(itemId)) {
            continue;
        }

        const item = dataset[i];
        const passage = item.passage;
        const question = item.question;
        const types = item.answers_spans?.types || [];
        const expectList = item.answers_spans?.spans || [];
        const isNum = hasNumberType(types);

        process.stdout.write(`[${itemId}/${total}] Calculating...`);
        const { content: output, inferenceTime, error, errorMsg } = await ask(passage, question, isNum);
        clearProgressLine();

        if (error) {
            console.log(`[${itemId}/${total}] [ERROR] ${errorMsg}`);
            if (i < total - 1) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            continue;
        }

        totalTime += inferenceTime;
        validResponsesCount++;

        const answer = extractAnswer(output, isNum);
        const correct = matchExpect(expectList, answer);
        if (correct) correctCount++;

        const acc = validResponsesCount > 0
            ? ((correctCount / validResponsesCount) * 100).toFixed(1)
            : "0.0";
        const avgTime = validResponsesCount > 0
            ? (totalTime / validResponsesCount).toFixed(2)
            : "0.00";
        const firstExpect = expectList[0] || "";

        console.log(
            `[${itemId}/${total}] ${correct ? "[OK]" : "[FAIL]"} | ` +
            `Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s | Avg:${avgTime}s | ` +
            `Ans:${shorten(answer, 18)} (Exp:${shorten(firstExpect, 18)})`
        );

        const record = {
            id: itemId,
            q: question,
            out: output,
            ans_ext: answer,
            exp: expectList,
            ok: correct,
            ms: (inferenceTime * 1000).toFixed(0)
        };

        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");
        completedIds.add(itemId);

        if (!correct) {
            console.log("[DEBUG] output_tail:", shorten(output.slice(-300), 300));
        }

        if (i < total - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.cooldown_ms));
        }
    }

    const completedTotal = completedIds.size;
    const finalAvgTime = validResponsesCount > 0 ? (totalTime / validResponsesCount).toFixed(2) : "0.00";
    const finalAcc = validResponsesCount > 0 ? ((correctCount / validResponsesCount) * 100).toFixed(2) : "0.00";

    console.log("------------------------------------------------------------");
    console.log(
        `[SUMMARY] Dataset Total: ${total} | Completed: ${completedTotal} | ` +
        `Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s`
    );
}

main();