const fs = require("fs");
const path = require("path");

const CONFIG = {
    api_url: "http://localhost:9000/chat",
    model_name: "9g_8b_thinking",
    max_tokens: 4096,
    cooldown_ms: 2000,
    timeout_ms: 600000,
    data_file: "../data_sets/DROP/train.jsonl",
    limit: 100
};

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000, ...rest } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(resource, { ...rest, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function askStream(prompt, isNumberType) {
    const systemPrompt = "You are an expert in reading comprehension and arithmetic.";

    const instructions = isNumberType
        ? [
            "Instructions:",
            "1. Think step-by-step based on the passage.",
            "2. The answer MUST be a number.",
            "3. Output the final answer on its own line starting strictly with \"Answer:\".",
            "4. Use Arabic numerals (0-9). Do NOT add units.",
            "",
            "Example:",
            "Answer: 42"
        ].join("\n")
        : [
            "Instructions:",
            "1. Think step-by-step based on the passage.",
            "2. Extract the answer directly from the text if possible.",
            "3. Output the final answer on its own line starting strictly with \"Answer:\".",
            "4. Keep the answer concise.",
            "",
            "Example:",
            "Answer: Seattle Seahawks"
        ].join("\n");

    const payload = {
        prompt: `${systemPrompt}\n\n${prompt}\n\n${instructions}`,
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1,
        top_p: 1.0,
        top_k: 1
    };

    const startedAt = Date.now();

    try {
        const response = await fetchWithTimeout(CONFIG.api_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout: CONFIG.timeout_ms
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const data = await response.json();
        return {
            content: data.response || "",
            inferenceTime: (Date.now() - startedAt) / 1000,
            error: false
        };
    } catch (err) {
        process.stdout.write(`\n[ERROR] Request failed: ${err.message}\n`);
        return {
            content: "",
            inferenceTime: 0,
            error: true
        };
    }
}

function buildBasePrompt(passage, question) {
    return `Passage:\n${passage}\n\nQuestion:\n${question}`;
}

function hasNumberType(types) {
    return Array.isArray(types) && types.some(type => String(type).toLowerCase() === "number");
}

function normalizeAnswer(value) {
    if (!value) return "";

    return String(value)
        .toLowerCase()
        .replace(/<\|im_end\|>|<\|endoftext\|>|<\/?think>/gi, " ")
        .replace(/\b(\d+)\s*-\s*yards?\b/g, "$1 yard")
        .replace(/\b(\d+)\s+yards?\b/g, "$1 yard")
        .replace(/\b(\d+)\s*-\s*points?\b/g, "$1 point")
        .replace(/\b(\d+)\s+points?\b/g, "$1 point")
        .replace(/\b(a|an|the)\b/g, " ")
        .replace(/[.,!?;:"'`]/g, "")
        .replace(/-/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function cleanExtractedAnswer(text) {
    if (!text) return "";

    return String(text)
        .replace(/^Answer\s*:\s*/i, "")
        .replace(/^[:：\-\s]+/, "")
        .replace(/^\.\.\.\s*thinking\s*\.\.\.\s*/i, "")
        .replace(/<\|im_end\|>|<\|endoftext\|>/gi, "")
        .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
        .replace(/^[>\-\*\s\[\](){}]+|[>\-\*\s\[\](){}]+$/g, "")
        .trim();
}

function isBadExtractedAnswer(text) {
    if (!text) return true;
    if (/^[.。,，;；:：!?！？]+$/.test(text)) return true;
    if (/[.?!。？！]/.test(text) && /\s/.test(text)) return true;
    if (/^(instructions?|example|question|passage|thinking)$/i.test(text)) return true;
    if (/^(i need to|let me|based on|therefore|so,|thus,|moreover,|however,)/i.test(text)) return true;
    if (text.length > 120) return true;
    return false;
}

function extractAnswer(rawOutput, isNumberType) {
    if (!rawOutput) return "FORMAT_ERROR";

    let cleanText = String(rawOutput).replace(/\r/g, "");

    const answerSectionMatch = cleanText.match(/(?:---\s*)?\*\*🤖\s*回答:\*\*([\s\S]*)$/);
    if (answerSectionMatch) {
        cleanText = answerSectionMatch[1].trim();
    } else {
        const thinkIndex = cleanText.lastIndexOf("</think>");
        if (thinkIndex !== -1) {
            cleanText = cleanText.slice(thinkIndex + 8).trim();
        }
    }

    const lines = cleanText
        .split("\n")
        .map(line => line.replace(/^\s*>\s?/, "").trim())
        .filter(Boolean);

    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const answerMatch = line.match(/^Answer\s*:\s*(.+)$/i);
        if (answerMatch) {
            const candidate = cleanExtractedAnswer(answerMatch[1]);
            if (!isBadExtractedAnswer(candidate)) return candidate;
        }

        if (/^Answer\s*:\s*$/i.test(line)) {
            for (let j = i + 1; j < lines.length; j++) {
                const candidate = cleanExtractedAnswer(lines[j]);
                if (!isBadExtractedAnswer(candidate)) return candidate;
            }
        }
    }

    if (isNumberType) {
        for (let i = lines.length - 1; i >= 0; i--) {
            const line = lines[i];
            if (/^(instructions?|example|question|passage)/i.test(line)) continue;
            const numberMatch = line.match(/(-?\d+(?:\.\d+)?)/);
            if (numberMatch) return numberMatch[1];
        }
    }

    const fallback = [...lines].reverse().find(line => {
        const candidate = cleanExtractedAnswer(line);
        return candidate
            && !isBadExtractedAnswer(candidate)
            && !/[,:;，：；]/.test(candidate)
            && candidate.split(/\s+/).length <= 3;
    });

    if (fallback) return cleanExtractedAnswer(fallback);
    return "FORMAT_ERROR";
}

function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer || modelAnswer === "FORMAT_ERROR") return false;
    const normModel = normalizeAnswer(modelAnswer);

    return expectList.some(exp => {
        const normExp = normalizeAnswer(exp);
        if (!normExp) return false;
        if (normModel === normExp) return true;
        if (normModel.includes(normExp) || normExp.includes(normModel)) return true;

        const numModel = parseFloat(normModel);
        const numExp = parseFloat(normExp);
        if (!Number.isNaN(numModel) && !Number.isNaN(numExp)) {
            return Math.abs(numModel - numExp) < 1e-6;
        }

        return false;
    });
}

async function main() {
    let dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        dataPath = path.join(__dirname, "..", "data_sets", "DROP", "train.jsonl");
    }

    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] Data file not found: ${dataPath}`);
        return;
    }

    console.log("[INFO] Loading DROP data...");
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
        console.log(`[INFO] Dataset is large (${dataset.length}). Truncating to ${CONFIG.limit}.`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    console.log(`[INFO] Start DROP (${total} items) | API: ${CONFIG.api_url}`);

    const resultDir = path.join(__dirname, "result");
    if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir, { recursive: true });
    const resFile = path.join(resultDir, "drop_res.jsonl");
    fs.writeFileSync(resFile, "");

    let count = 0;
    let totalTime = 0;

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const passage = item.passage;
        const question = item.question;
        const types = item.answers_spans?.types || [];
        const expectList = item.answers_spans?.spans || [];

        const isNum = hasNumberType(types);
        const basePrompt = buildBasePrompt(passage, question);

        process.stdout.write(`   [${i + 1}/${total}] Connecting... `);
        const { content: output, inferenceTime, error } = await askStream(basePrompt, isNum);

        if (error) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            continue;
        }

        totalTime += inferenceTime;

        const answer = extractAnswer(output, isNum);
        const correct = matchExpect(expectList, answer);
        if (correct) count++;

        const acc = ((count / (i + 1)) * 100).toFixed(1);
        const avgTime = (totalTime / (i + 1)).toFixed(2);
        const shortAns = answer.length > 20 ? `${answer.slice(0, 20)}...` : answer;
        const firstExpect = expectList[0] || "";
        const shortExp = firstExpect.length > 20 ? `${firstExpect.slice(0, 20)}...` : firstExpect;
        const status = correct ? "[OK]" : "[FAIL]";

        process.stdout.write("\r" + " ".repeat(120) + "\r");
        process.stdout.write(
            `   [${i + 1}/${total}] ${status} | Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s | Avg:${avgTime}s | Ans:${shortAns} (Exp:${shortExp})\n`
        );

        const record = {
            id: i + 1,
            q: question,
            type: isNum ? "number" : "span",
            out: output,
            ans_ext: answer,
            exp: expectList,
            ok: correct,
            ms: String(Math.round(inferenceTime * 1000))
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            const steps = Math.max(1, Math.floor(CONFIG.cooldown_ms / 100));
            for (let step = 0; step < steps; step++) {
                const remaining = ((CONFIG.cooldown_ms - step * 100) / 1000).toFixed(1);
                process.stdout.write(`\r            Cooling down... ${remaining}s `);
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            process.stdout.write("\r" + " ".repeat(50) + "\r");
        }
    }

    const finalAvgTime = total > 0 ? (totalTime / total).toFixed(2) : "0.00";
    const finalAcc = total > 0 ? ((count / total) * 100).toFixed(2) : "0.00";

    console.log("\n[INFO] DROP finished.");
    console.log(`[INFO] Final accuracy: ${finalAcc}%`);
    console.log(`[INFO] Average latency: ${finalAvgTime}s`);
}

main();
