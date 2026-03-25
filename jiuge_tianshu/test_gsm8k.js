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
    let dataset = rawData.split(/\r?\n/).filter(line => line.trim() !== "").map(line => {
        try { return JSON.parse(line); } catch(e) { return null; }
    }).filter(item => item !== null);

    const total = dataset.length;
    console.log(`[INFO] Start GSM8K (${total} items) | API Port: 9000`);
    console.log("------------------------------------------------------------");

    const resDir = path.join(__dirname, "result");
    if (!fs.existsSync(resDir)) fs.mkdirSync(resDir);
    const resFile = path.join(resDir, "gsm8k_res.jsonl");
    fs.writeFileSync(resFile, ""); // 清空/创建结果文件

    let correctCount = 0;
    let totalInferenceTime = 0; // 新增：累计推理时间
    let validResponsesCount = 0; // 新增：有效回答次数
    
    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.question;
        const expectVal = extractExpect(item.answer); 

        process.stdout.write(`[${i + 1}/${total}] Calculating...`);

        const { content: output, inferenceTime, error, errorMsg } = await ask(question);

        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);

        if (error) {
            console.log(`[${i+1}/${total}] Error: ${errorMsg}`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }

        // 累计成功请求的时延
        totalInferenceTime += inferenceTime;
        validResponsesCount++;

        const answerVal = extractAnswer(output);
        const isCorrect = !isNaN(answerVal) && !isNaN(expectVal) && Math.abs(answerVal - expectVal) < 1e-6;
        
        if (isCorrect) correctCount++;

        // 计算各项指标
        const acc = ((correctCount / (i + 1)) * 100).toFixed(1);
        const avgTime = (totalInferenceTime / validResponsesCount).toFixed(1);
        const icon = isCorrect ? '[OK]' : '[FAIL]';
        const colorAns = isCorrect ? '\x1b[32m' : '\x1b[31m'; 
        const reset = '\x1b[0m';

        // 纯英文控制台输出，避免终端乱码
        console.log(`[${i + 1}/${total}] ${icon} Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s (Avg:${avgTime}s) | Ans:${colorAns}${answerVal}${reset} (Exp:${expectVal})`);

        const record = {
            id: i + 1,
            q: question,
            out: output,
            ans_model: answerVal,
            ans_gold: expectVal,
            ok: isCorrect,
            ms: (inferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            await new Promise(r => setTimeout(r, CONFIG.cooldown_ms));
        }
    }

    // 测试完成，计算最终统计数据
    const finalAcc = ((correctCount / total) * 100).toFixed(2);
    const finalAvgTime = validResponsesCount > 0 ? (totalInferenceTime / validResponsesCount).toFixed(2) : "0.00";
    
    const summaryMsg = `\n[SUMMARY] Total: ${total} | Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s\n`;

    console.log("------------------------------------------------------------");
    console.log(summaryMsg.trim());

    // 将最终统计数据追加到 JSONL 文件末尾
    fs.appendFileSync(resFile, summaryMsg);
}

main();