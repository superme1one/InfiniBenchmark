// test_drop_100_avg_time.js
const fs = require("fs");
const path = require("path");

// ================== ⚙️ 核心配置 ==================
const CONFIG = {
    api_url: "http://localhost:9000/chat",
    model_name: "9g_8b_thinking",
    // DROP 需要阅读长文章，给�?Token
    max_tokens: 4096, 
    // 答完一题休�?
    cooldown_ms: 2000, 
    // 单题超时
    timeout_ms: 600000,
    // 数据文件路径
    data_file: "./DROP/train.jsonl",
    // ⚠️ 仅测试前 100 �?
    limit: 100
};
// ================================================

// 带超时的 Fetch
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

// 核心请求函数 (流式)
async function askStream(prompt, isNumberType) {
    const systemPrompt = "You are an expert in reading comprehension and arithmetic.";
    
    // 构�?Instructions
    let instructions = "";
    if (isNumberType) {
        instructions = `
Instructions:
1. Think step-by-step based on the passage.
2. The answer MUST be a number.
3. Output the final answer starting strictly with "Answer:".
4. Use Arabic numerals (0-9). Do NOT add units (e.g. use "50", not "50 yards").

Example:
... thinking ...
Answer: 42
`.trim();
    } else {
        instructions = `
Instructions:
1. Think step-by-step based on the passage.
2. Extract the answer directly from the text if possible.
3. Output the final answer starting strictly with "Answer:".
4. Keep the answer concise (names, dates, or short phrases).

Example:
... thinking ...
Answer: Seattle Seahawks
`.trim();
    }

    const userPrompt = `${prompt}\n\n${instructions}`;

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

        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let buffer = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop(); 

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith("data: ")) {
                    const jsonStr = trimmed.slice(6);
                    if (jsonStr === "[DONE]") continue;
                    try {
                        const json = JSON.parse(jsonStr);
                        const token = json.choices[0].delta?.content || json.choices[0].text || "";
                        if (token) {
                            fullContent += token;
                            if (fullContent.length % 50 === 0) {
                                const preview = fullContent.slice(-40).replace(/\n/g, " ");
                                process.stdout.write(`\r   �?思考中... [${fullContent.length}字] ...${preview} `);
                            }
                        }
                    } catch (e) { }
                }
            }
        }
    } catch (err) {
        process.stdout.write(`\n�?请求出错: ${err.message}\n`);
        return { content: "", inferenceTime: 0, error: true };
    }

    const t1 = Date.now();
    return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };
}

// 🛠 辅助：构造基础 Prompt (Passage + Question)
function buildBasePrompt(passage, question) {
    return `Passage:\n${passage}\n\nQuestion:\n${question}`;
}

// 🛠 辅助：判断是否为数字�?
function hasNumberType(types) {
    return Array.isArray(types) && types.some(t => String(t).toLowerCase() === "number");
}

// 🧹 清洗答案 (Standardize for DROP evaluation)
function normalizeAnswer(s) {
    if (!s) return "";
    return String(s)
        .toLowerCase()
        .replace(/\b(a|an|the)\b/g, " ") // 去掉冠词
        .replace(/[.,!?;:"]/g, "")      // 去掉标点
        .replace(/\s+/g, " ")            // 合并空格
        .trim();
}

// 🧹 提取模型答案
function extractAnswer(rawOutput) {
    if (!rawOutput) return "";
    
    // 1. 去掉 </think> 之前的内�?
    let cleanText = rawOutput;
    const thinkIndex = rawOutput.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = rawOutput.slice(thinkIndex + 8).trim();
    }

    // 2. 提取 Answer: 之后的内�?
    const match = cleanText.match(/Answer:\s*(.*)/i);
    let result = "";
    if (match) {
        // 取第一�?
        result = match[1].split('\n')[0];
    } else {
        // 兜底：取最后一行非�?
        const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
        if (lines.length > 0) result = lines[lines.length - 1];
    }
    
    // 清理首尾特殊字符
    return result.replace(/^[\s"'«»“”‘�?>\[\]()]+|[\s"'«»“”‘�?>\[\]()]+$/g, "");
}

// 🎯 判题逻辑
function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer) return false;
    const normModel = normalizeAnswer(modelAnswer);

    // 只要匹配到了 expectList 中的任意一个答案即�?
    return expectList.some(exp => {
        const normExp = normalizeAnswer(exp);
        // 1. 文本包含匹配 (宽松)
        if (normModel.includes(normExp)) return true;
        // 2. 数字匹配 (处理 10 vs 10.0)
        const numModel = parseFloat(normModel);
        const numExp = parseFloat(normExp);
        if (!isNaN(numModel) && !isNaN(numExp)) {
            return Math.abs(numModel - numExp) < 1e-6;
        }
        return false;
    });
}

async function main() {
    // 1. 寻找数据文件
    const dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        console.error(`�?错误：找不到数据文件 ${dataPath}`);
        return;
    }

    // 2. 加载数据 (JSONL)
    console.log("📂 正在加载 DROP 数据...");
    const rawData = fs.readFileSync(dataPath, "utf-8");
    let dataset = rawData.split(/\r?\n/)
        .filter(line => line.trim() !== "")
        .map(line => {
            try { return JSON.parse(line); } catch(e) { return null; }
        })
        .filter(item => item !== null);

    // ✂️ 截取�?100 �?
    if (dataset.length > CONFIG.limit) {
        console.log(`✂️ 数据集较�?(${dataset.length}�?，仅测试�?${CONFIG.limit} �?..`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    console.log(`🚀 开始测�?DROP (${total} 条数�?`);

    // 3. 准备结果文件
    if (!fs.existsSync("./result")) fs.mkdirSync("./result");
    const resFile = "./result/drop_res.jsonl";
    fs.writeFileSync(resFile, "");

    let count = 0;
    let totalTime = 0; // ⏱️ 用于统计总时�?
    
    // 4. 开始循�?
    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const passage = item.passage;
        const question = item.question;
        const types = (item.answers_spans && item.answers_spans.types) || [];
        const expectList = (item.answers_spans && item.answers_spans.spans) || [];
        
        const isNum = hasNumberType(types);
        const basePrompt = buildBasePrompt(passage, question);

        process.stdout.write(`   [${i + 1}/${total}] 连接�?.. `);

        // --- 请求 ---
        const { content: output, inferenceTime, error } = await askStream(basePrompt, isNum);

        if (error) {
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        // --- 累计时间 ---
        totalTime += inferenceTime;

        // --- 提取与判�?---
        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) count++;

        // 计算当前准确率和平均时间
        const acc = ((count / (i + 1)) * 100).toFixed(1);
        const currentAvgTime = (totalTime / (i + 1)).toFixed(2);
        const thisTimeStr = inferenceTime.toFixed(1) + "s";

        // --- UI 更新 ---
        process.stdout.write("\r" + " ".repeat(100) + "\r"); 
        
        // 简略显�?
        const shortAns = answer.length > 15 ? answer.substring(0, 15) + "..." : answer;
        const shortExp = expectList[0].length > 15 ? expectList[0].substring(0, 15) + "..." : expectList[0];
        
        // 🌟 重点：显�?AvgTime
        process.stdout.write(`   [${i + 1}/${total}] ${correct ? '�? : '�?} | Acc:${acc}% | 本题:${thisTimeStr} | Avg:${currentAvgTime}s | �?${shortAns} (�?${shortExp})\n`);

        // --- 记录文件 ---
        const record = {
            id: i + 1,
            q: question,
            type: isNum ? "number" : "span",
            out: output,
            ans_ext: answer,
            exp: expectList,
            ok: correct,
            ms: (inferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        // --- 冷却 ---
        if (i < total - 1) {
            const steps = CONFIG.cooldown_ms / 100;
            for(let c = 0; c < steps; c++) {
                process.stdout.write(`\r            ❄️ 冷却�?.. ${(CONFIG.cooldown_ms - c*100)/1000}s `);
                await new Promise(r => setTimeout(r, 100));
            }
            process.stdout.write("\r" + " ".repeat(40) + "\r"); 
        }
    }

    const finalAvgTime = (totalTime / total).toFixed(2);
    const finalAcc = ((count / total) * 100).toFixed(2);

    console.log(`\n🎉 测试完成！`);
    console.log(`📊 最终准确率: ${finalAcc}%`);
    console.log(`⏱️ 平均推理时长: ${finalAvgTime} 秒`);
}

main();
