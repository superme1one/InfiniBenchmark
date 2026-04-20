const fs = require("fs");
const path = require("path");
const { openChatCompletionStream } = require("./api_client");

const CONFIG = {
    api_url: "http://172.22.162.17:8000/chat/completions",
    model_name: "9g_8b_thinking",
    max_tokens: Number(process.env.DROP_MAX_TOKENS || 1024),
    cooldown_ms: Number(process.env.DROP_COOLDOWN_MS || 2000),
    timeout_ms: Number(process.env.DROP_TIMEOUT_MS || 600000),
    data_file: "../data_sets/DROP/train.jsonl",
    limit: Number(process.env.DROP_LIMIT || 100)
};

const NUMBER_WORDS = {
    zero: "0",
    one: "1",
    two: "2",
    three: "3",
    four: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
    ten: "10",
    eleven: "11",
    twelve: "12",
    thirteen: "13",
    fourteen: "14",
    fifteen: "15",
    sixteen: "16",
    seventeen: "17",
    eighteen: "18",
    nineteen: "19",
    twenty: "20"
};
const NUMBER_WORD_PATTERN = Object.keys(NUMBER_WORDS).join("|");

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function buildBasePrompt(passage, question) {
    return `Passage:\n${passage}\n\nQuestion:\n${question}`;
}

function hasNumberType(types) {
    return Array.isArray(types) && types.some(type => String(type).toLowerCase() === "number");
}

function buildInstructions(isNumberType) {
    return isNumberType
        ? [
            "Instructions:",
            "1. Read the passage carefully and answer the question using only the passage.",
            "2. Think briefly before answering and reach the final answer as quickly as possible.",
            "3. Pay close attention to units in the question, such as points, yards, counts, and percentages.",
            "4. If the answer is a number, use Arabic numerals.",
            "5. Put the final answer on the last line in this format: Answer: <final answer>",
            "6. Do not output anything after the final answer."
        ].join("\n")
        : [
            "Instructions:",
            "1. Read the passage carefully and answer the question using only the passage.",
            "2. Think briefly before answering and reach the final answer as quickly as possible.",
            "3. Extract the answer directly from the passage when possible.",
            "4. Put the final answer on the last line in this format: Answer: <final answer>",
            "5. Do not output anything after the final answer."
        ].join("\n");
}

function tryConsumeSseLine(line, fullContentRef) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data: ")) return;

    const jsonStr = trimmed.slice(6).trim();
    if (!jsonStr || jsonStr === "[DONE]") return;

    try {
        const json = JSON.parse(jsonStr);
        const token = json?.choices?.[0]?.delta?.content || json?.choices?.[0]?.text || "";
        if (token) fullContentRef.value += token;
    } catch (_) {
        // Ignore malformed SSE fragments.
    }
}

async function askStream(prompt, isNumberType) {
    const payload = {
        model: CONFIG.model_name,
        messages: [
            {
                role: "system",
                content: "You are a careful reading comprehension assistant. Answer only from the passage and reach the final answer quickly."
            },
            {
                role: "user",
                content: `${prompt}\n\n${buildInstructions(isNumberType)}`
            }
        ],
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1,
        stream: true
    };

    const startedAt = Date.now();
    const fullContentRef = { value: "" };
    let buffer = "";

    try {
        const { response, endpoint } = await openChatCompletionStream({
            preferredUrl: CONFIG.api_url,
            payload,
            timeoutMs: CONFIG.timeout_ms
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                tryConsumeSseLine(line, fullContentRef);
            }
        }

        if (buffer.trim()) {
            tryConsumeSseLine(buffer, fullContentRef);
        }

        return {
            content: fullContentRef.value,
            inferenceTime: (Date.now() - startedAt) / 1000,
            error: false,
            partial: false,
            endpoint
        };
    } catch (err) {
        if (buffer.trim()) {
            tryConsumeSseLine(buffer, fullContentRef);
        }

        if (fullContentRef.value.trim()) {
            return {
                content: fullContentRef.value,
                inferenceTime: (Date.now() - startedAt) / 1000,
                error: false,
                partial: true,
                warning: err.message
            };
        }

        return {
            content: "",
            inferenceTime: 0,
            error: true,
            errorMsg: err.message
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
        .replace(/```[\s\S]*?```/g, m => m.replace(/```/g, " "))
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function parseNumericToken(text) {
    if (!text) return "";

    const digitMatch = String(text).match(/-?\d+(?:\.\d+)?/);
    if (digitMatch) return digitMatch[0];

    const normalized = String(text).trim().toLowerCase();
    return NUMBER_WORDS[normalized] || "";
}

function extractExplicitAnswer(cleanText, isNumberType) {
    const matches = [...cleanText.matchAll(/Answer:\s*(.+)/gi)];
    if (matches.length === 0) return "";

    let result = matches[matches.length - 1][1].split("\n")[0].trim();
    result = result.replace(/^[\s"'`>\[\]()]+|[\s"'`>\[\]()]+$/g, "").trim();

    if (!result) return "";

    if (isNumberType) {
        return parseNumericToken(result);
    }

    return result;
}

function extractNumberFallback(lines) {
    const conclusionPattern = new RegExp(
        `(?:there\\s+(?:are|were)|answer(?:\\s+should\\s+be|\\s+is)?|(?:the\\s+)?(?:total|count|number)(?:\\s+is|\\s+was)?|(?:shortest|longest|fewest|most)(?:\\s+[a-z]+){0,4}?\\s+(?:is|was)|would\\s+be|equals?|equal\\s+to|needed|need|scored|total(?:ed)?|for|have|has)\\s+(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})(?:\\s*%|\\s+(?:yards?|points?|field\\s+goals?)|\\b|$)`,
        "i"
    );

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const lower = line.toLowerCase();

        const tiedMatch = line.match(/tied at\s+(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/i);
        if (tiedMatch && tiedMatch[1] === tiedMatch[2]) {
            return tiedMatch[1];
        }

        const pointsMatch = line.match(/\b(?:have|has)\s+(-?\d+(?:\.\d+)?)\s+points?\b/i);
        if (pointsMatch) {
            return pointsMatch[1];
        }

        const directNumeric = parseNumericToken(line);
        if (directNumeric && new RegExp(`^(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})$`, "i").test(line.trim())) {
            return directNumeric;
        }

        const m = line.match(conclusionPattern);
        if (m) {
            const parsed = parseNumericToken(m[1]);
            if (parsed) return parsed;
        }

        const percentMatches = [...line.matchAll(/(-?\d+(?:\.\d+)?)\s*%/g)];
        if (percentMatches.length > 0) {
            return percentMatches[percentMatches.length - 1][1];
        }

        if (/yard|yards|field goal|touchdown|td pass|quarter|intercepted|pass from|ran it in/.test(lower)) {
            continue;
        }
    }

    return "";
}

function extractComputedNumber(cleanText) {
    const patterns = [
        /100\s*%\s*-\s*-?\d+(?:\.\d+)?\s*%\s*=\s*(-?\d+(?:\.\d+)?)/gi,
        /not [^.\n]*?\b(?:is|was|were|would be|equals?|equal to)\s*(-?\d+(?:\.\d+)?)\s*%/gi,
        /tied at\s+(-?\d+(?:\.\d+)?)\s*-\s*\1/gi,
        /(?:have|has)\s+(-?\d+(?:\.\d+)?)\s+points?\b/gi,
        new RegExp(`there\\s+(?:are|were)\\s+(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})\\s+(?:field goals?|touchdowns?|points?)`, "gi"),
        new RegExp(`(?:shortest|longest|fewest|most)[^.\\n]*?\\b(?:is|was)\\s+(-?\\d+(?:\\.\\d+)?|${NUMBER_WORD_PATTERN})(?:\\s+(?:yards?|points?|percent))?`, "gi"),
        /therefore[^.\n]*?(-?\d+(?:\.\d+)?)\s*%/gi,
        /so[^.\n]*?(-?\d+(?:\.\d+)?)\s*%/gi
    ];

    for (const pattern of patterns) {
        const matches = [...cleanText.matchAll(pattern)];
        if (matches.length > 0) {
            const last = matches[matches.length - 1];
            if (last[1]) {
                return parseNumericToken(last[1]) || last[1];
            }
        }
    }

    return "";
}

function extractConclusionText(cleanText) {
    const patterns = [
        /answer should be\s+([^\n.]{1,80})/gi,
        /answer is\s+([^\n.]{1,80})/gi,
        /final answer[: ]+\s*([^\n.]{1,80})/gi,
        /therefore[,:\s]+([^\n.]{1,80})/gi,
        /thus[,:\s]+([^\n.]{1,80})/gi,
        /so[,:\s]+([^\n.]{1,80})/gi
    ];

    for (const pattern of patterns) {
        const matches = [...cleanText.matchAll(pattern)];
        if (matches.length === 0) continue;

        const candidate = matches[matches.length - 1][1]
            .replace(/^[\s"'`>\[\]()]+|[\s"'`>\[\]()]+$/g, "")
            .trim();

        if (!candidate) continue;
        if (/^(i think|let me|the question|from the passage|it means)/i.test(candidate)) continue;
        return candidate;
    }

    return "";
}

function extractTextFallback(lines) {
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];

        if (!line || line.length > 80) continue;
        if (/^(okay|ok|well|now|first|second|third|finally)[,:\s]/i.test(line)) continue;
        if (/^(i think|i need to|let me|we need to|the question is|looking at the passage)/i.test(line)) continue;
        if (/^(reasoning|analysis|explanation|step|steps)/i.test(line)) continue;
        if (/^(therefore|thus|so|hence|from the passage)[,:]?\s*$/i.test(line)) continue;
        if (/[.?!]$/.test(line) && line.length > 40) continue;

        return line.replace(/^[\s"'`>\[\]()]+|[\s"'`>\[\]()]+$/g, "").trim();
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
        const computed = extractComputedNumber(cleanText);
        if (computed) return computed;
        return extractNumberFallback(lines);
    }

    const concluded = extractConclusionText(cleanText);
    if (concluded) return concluded;

    return extractTextFallback(lines);
}

function matchExpect(expectList, modelAnswer, isNumberType = false) {
    if (!modelAnswer) return false;
    const normalizedModel = normalizeAnswer(modelAnswer);

    return expectList.some(exp => {
        const normalizedExp = normalizeAnswer(exp);
        if (!normalizedExp) return false;

        if (isNumberType) {
            const numModel = parseFloat(normalizedModel);
            const numExp = parseFloat(normalizedExp);
            if (Number.isNaN(numModel) || Number.isNaN(numExp)) {
                return false;
            }
            return Math.abs(numModel - numExp) < 1e-6;
        }

        if (normalizedModel === normalizedExp) return true;
        if (normalizedModel.includes(normalizedExp)) return true;
        if (normalizedExp.includes(normalizedModel) && normalizedModel.length >= 2) return true;

        const numModel = parseFloat(normalizedModel);
        const numExp = parseFloat(normalizedExp);
        if (!Number.isNaN(numModel) && !Number.isNaN(numExp)) {
            return Math.abs(numModel - numExp) < 1e-6;
        }

        return false;
    });
}

function ensureDatasetPath() {
    const primary = path.join(__dirname, CONFIG.data_file);
    if (fs.existsSync(primary)) return primary;

    const fallback = path.join(__dirname, "..", "data_sets", "DROP", "train.jsonl");
    if (fs.existsSync(fallback)) return fallback;

    return primary;
}

async function main() {
    const dataPath = ensureDatasetPath();
    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] Data file not found: ${dataPath}`);
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
        console.log(`[INFO] Dataset size ${dataset.length}, truncating to ${CONFIG.limit}.`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    const resultDir = path.join(__dirname, "result");
    fs.mkdirSync(resultDir, { recursive: true });
    const resultFile = path.join(resultDir, "drop_res.jsonl");
    fs.writeFileSync(resultFile, "");

    let correctCount = 0;
    let evaluatedCount = 0;
    let successCount = 0;
    let errorCount = 0;
    let partialCount = 0;
    let totalLatency = 0;

    console.log(`[INFO] Start DROP (${total} items) | API: ${CONFIG.api_url}`);
    console.log("------------------------------------------------------------");

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const isNumber = hasNumberType(item.answers_spans?.types || []);
        const expectList = item.answers_spans?.spans || [];
        const prompt = buildBasePrompt(item.passage, item.question);

        process.stdout.write(`[${i + 1}/${total}] Calculating...`);
        const result = await askStream(prompt, isNumber);
        process.stdout.write("\r" + " ".repeat(140) + "\r");

        if (result.error) {
            errorCount++;
            const record = {
                id: i + 1,
                q: item.question,
                type: isNumber ? "number" : "span",
                out: "",
                ans_ext: "",
                exp: expectList,
                ok: false,
                skipped: true,
                error: result.errorMsg
            };
            fs.appendFileSync(resultFile, JSON.stringify(record) + "\n");
            console.log(`[${i + 1}/${total}] [ERROR] skipped | ${result.errorMsg}`);

            if (i < total - 1) {
                await sleep(Math.min(CONFIG.cooldown_ms, 5000));
            }
            continue;
        }

        successCount++;
        evaluatedCount++;
        totalLatency += result.inferenceTime;
        if (result.partial) partialCount++;

        const answer = extractAnswer(result.content, isNumber);
        const correct = matchExpect(expectList, answer, isNumber);
        if (correct) correctCount++;

        const accuracy = evaluatedCount > 0
            ? ((correctCount / evaluatedCount) * 100).toFixed(1)
            : "0.0";
        const avgLatency = successCount > 0
            ? (totalLatency / successCount).toFixed(2)
            : "0.00";
        const shortAnswer = answer.length > 20 ? `${answer.slice(0, 20)}...` : answer;
        const expected = expectList[0] || "";
        const shortExpected = expected.length > 20 ? `${expected.slice(0, 20)}...` : expected;
        const suffix = result.partial ? " [partial]" : "";

        console.log(
            `[${i + 1}/${total}] ${correct ? "[OK]" : "[FAIL]"}${suffix} | Acc:${accuracy}% | Time:${result.inferenceTime.toFixed(1)}s | Avg:${avgLatency}s | Ans:${shortAnswer} (Exp:${shortExpected})`
        );

        const record = {
            id: i + 1,
            q: item.question,
            type: isNumber ? "number" : "span",
            out: result.content,
            ans_ext: answer,
            exp: expectList,
            ok: correct,
            skipped: false,
            partial: Boolean(result.partial),
            warning: result.warning || "",
            ms: String(Math.round(result.inferenceTime * 1000))
        };
        fs.appendFileSync(resultFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            const steps = Math.max(1, Math.floor(CONFIG.cooldown_ms / 100));
            for (let step = 0; step < steps; step++) {
                const remaining = ((CONFIG.cooldown_ms - step * 100) / 1000).toFixed(1);
                process.stdout.write(`\rCooling down... ${remaining}s `);
                await sleep(100);
            }
            process.stdout.write("\r" + " ".repeat(40) + "\r");
        }
    }

    if (successCount === 0) {
        console.log("[INFO] No successful model responses were received.");
        console.log("[INFO] Check network reachability or set OPENAI_API_URL explicitly.");
        return;
    }

    const finalAccuracy = evaluatedCount > 0
        ? ((correctCount / evaluatedCount) * 100).toFixed(2)
        : "0.00";
    const finalAvgLatency = (totalLatency / successCount).toFixed(2);

    console.log("------------------------------------------------------------");
    console.log(`[INFO] Completed. Accuracy: ${finalAccuracy}% (${correctCount}/${evaluatedCount})`);
    console.log(`[INFO] Average latency: ${finalAvgLatency}s`);
    if (errorCount > 0) {
        console.log(`[INFO] Skipped request errors: ${errorCount}`);
    }
    if (partialCount > 0) {
        console.log(`[INFO] Partial stream terminations salvaged: ${partialCount}`);
    }
}

main();
