const fs = require("fs");
const path = require("path");

// 测试运行配置
const CONFIG = {
    api_url: "http://localhost:9000/chat",
    model_name: "9g_8b_thinking",
    max_tokens: 4096,
    cooldown_ms: 500,
    timeout_ms: 300000,
    data_file: "../data_sets/GSM8k/test.jsonl"
};

// 封装带超时控制的请求
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// 调用模型并获取回答
async function ask(question) {
    const fullPrompt = `You are a math expert.

Question:
${question}

Instructions:
1. Think step-by-step to solve the problem.
2. **Be concise** but show your calculation clearly.
3. You MUST end your response with: "#### <final_number>"
   Example:
   ... reasoning ...
   #### 42

Response:
`;

    const payload = {
        prompt: fullPrompt,
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1,
        top_p: 1.0,
        top_k: 1
    };

    const t0 = Date.now();

    try {
        const response = await fetchWithTimeout(CONFIG.api_url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            timeout: CONFIG.timeout_ms
        });

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const data = await response.json();
        const fullContent = data.response;

        const t1 = Date.now();
        return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };

    } catch (err) {
        return { content: "", inferenceTime: 0, error: true, errorMsg: err.message };
    }
}

// 从文本中提取标准答案
function extractExpect(answerStr) {
    if (!answerStr) return NaN;
    const match = answerStr.match(/####\s*(-?[\d,.]+)/);
    if (match) {
        return parseFloat(match[1].replace(/,/g, ""));
    }
    return NaN;
}

// 从模型输出中提取生成的答案
function extractAnswer(rawOutput) {
    if (!rawOutput) return NaN;

    let cleanText = rawOutput;
    const thinkIndex = rawOutput.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = rawOutput.slice(thinkIndex + 8).trim();
    }

    let match = cleanText.match(/####\s*(-?[\d,.]+)/);
    if (match) {
        return parseFloat(match[1].replace(/,/g, ""));
    }

    match = cleanText.match(/Answer:\s*(-?[\d,.]+)/i);
    if (match) return parseFloat(match[1].replace(/,/g, ""));

    const boxedMatch = cleanText.match(/\\boxed\{(-?[\d,.]+)\}/);
    if (boxedMatch) return parseFloat(boxedMatch[1].replace(/,/g, ""));

    const allNumbers = cleanText.match(/-?[\d,.]+/g);
    if (allNumbers && allNumbers.length > 0) {
        const lastNum = allNumbers[allNumbers.length - 1];
        if (/^-?[\d,.]+$/.test(lastNum)) {
            return parseFloat(lastNum.replace(/,/g, ""));
        }
    }

    return NaN;
}

function loadExistingResults(resFile) {
    if (!fs.existsSync(resFile)) {
        return {
            records: [],
            completedIds: new Set(),
            correctCount: 0,
            totalInferenceTime: 0,
            validResponsesCount: 0
        };
    }

    const lines = fs.readFileSync(resFile, "utf-8")
        .split(/\r?\n/)
        .filter(line => line.trim() !== "");

    const records = [];
    const completedIds = new Set();
    let correctCount = 0;
    let totalInferenceTime = 0;
    let validResponsesCount = 0;

    for (const line of lines) {
        try {
            const rec = JSON.parse(line);
            if (!rec || typeof rec !== "object") continue;

            records.push(rec);

            if (Number.isInteger(rec.id) && rec.id > 0) {
                completedIds.add(rec.id);
            }

            if (rec.ok === true) correctCount++;

            const ms = Number(rec.ms);
            if (!Number.isNaN(ms) && ms >= 0) {
                totalInferenceTime += ms / 1000;
                validResponsesCount++;
            }
        } catch (_) {
            // 忽略非 JSON 行或损坏行，避免旧 summary 影响续跑
        }
    }

    return {
        records,
        completedIds,
        correctCount,
        totalInferenceTime,
        validResponsesCount
    };
}

function clearProgressLine() {
    if (typeof process.stdout.clearLine === "function" && typeof process.stdout.cursorTo === "function") {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
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
        console.error(`Error: cannot find dataset file at ${dataPath}`);
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
            } catch (e) {
                return null;
            }
        })
        .filter(item => item !== null);

    const total = dataset.length;
    console.log(`[INFO] Start GSM8K (${total} items) | API Port: 9000`);
    console.log("------------------------------------------------------------");

    const resDir = path.join(__dirname, "result");
    if (!fs.existsSync(resDir)) fs.mkdirSync(resDir);

    const resFile = path.join(resDir, "gsm8k_res.jsonl");

    const {
        records,
        completedIds,
        correctCount: loadedCorrectCount,
        totalInferenceTime: loadedTotalInferenceTime,
        validResponsesCount: loadedValidResponsesCount
    } = loadExistingResults(resFile);

    let correctCount = loadedCorrectCount;
    let totalInferenceTime = loadedTotalInferenceTime;
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
        const question = item.question;
        const expectVal = extractExpect(item.answer);

        process.stdout.write(`[${itemId}/${total}] Calculating...`);

        const { content: output, inferenceTime, error, errorMsg } = await ask(question);

        clearProgressLine();

        if (error) {
            console.log(`[${itemId}/${total}] Error: ${errorMsg}`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }

        totalInferenceTime += inferenceTime;
        validResponsesCount++;

        const answerVal = extractAnswer(output);
        const isCorrect = !isNaN(answerVal) && !isNaN(expectVal) && Math.abs(answerVal - expectVal) < 1e-6;

        if (isCorrect) correctCount++;

        const acc = validResponsesCount > 0
            ? ((correctCount / validResponsesCount) * 100).toFixed(1)
            : "0.0";
        const avgTime = validResponsesCount > 0
            ? (totalInferenceTime / validResponsesCount).toFixed(1)
            : "0.0";
        const icon = isCorrect ? "[OK]" : "[FAIL]";
        const colorAns = isCorrect ? "\x1b[32m" : "\x1b[31m";
        const reset = "\x1b[0m";

        console.log(
            `[${itemId}/${total}] ${icon} Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s ` +
            `(Avg:${avgTime}s) | Ans:${colorAns}${answerVal}${reset} (Exp:${expectVal})`
        );

        const record = {
            id: itemId,
            q: question,
            out: output,
            ans_model: answerVal,
            ans_gold: expectVal,
            ok: isCorrect,
            ms: (inferenceTime * 1000).toFixed(0)
        };

        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");
        completedIds.add(itemId);

        if (i < total - 1) {
            await new Promise(r => setTimeout(r, CONFIG.cooldown_ms));
        }
    }

    const completedTotal = completedIds.size;
    const finalAcc = validResponsesCount > 0
        ? ((correctCount / validResponsesCount) * 100).toFixed(2)
        : "0.00";
    const finalAvgTime = validResponsesCount > 0
        ? (totalInferenceTime / validResponsesCount).toFixed(2)
        : "0.00";

    console.log("------------------------------------------------------------");
    console.log(
        `[SUMMARY] Dataset Total: ${total} | Completed: ${completedTotal} | ` +
        `Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s`
    );
}

main();