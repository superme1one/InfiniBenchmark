// 导入文件系统模块
const fs = require("fs");
const path = require("path");

// 测试运行配置
const CONFIG = {
    api_url: "http://localhost:9500/chat",
    model_name: "9g_8b_thinking", // 待评测模型名称
// 单次请求最大输出长度
    max_tokens: 4096, 
// 样本间冷却时间（毫秒）
    cooldown_ms: 3000, 
// 单次请求超时（毫秒）
    timeout_ms: 600000,
// 数据集文件路径
    data_file: "../data_sets/GSM8k/test.jsonl"
};
// ================================================

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
async function askStream(question) {
    const systemPrompt = "You are a helpful math expert.";
    
// 用户提示词
// 用户提示词
// 用户提示词
    const userPrompt = `
Question: ${question}

Instructions:
1. Think step-by-step to solve the problem, but keep your thinking process VERY BRIEF (limit to essential steps).
2. Calculate the final numerical result.
3. Start your final answer strictly with "Answer:".

Example:
... brief calculation steps ...
Answer: 42
`.trim();

    const payload = {
        model: CONFIG.model_name,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1, // 采样温度
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
// 分支条件处理
                            if (fullContent.length % 50 === 0) {
                                const preview = fullContent.slice(-40).replace(/\n/g, " ");
 process.stdout.write(`\r ? ... [${fullContent.length} ...${preview} `);
                            }
                        }
                    } catch (e) { }
                }
            }
        }
    } catch (err) {
 process.stdout.write(`\n ? : ${err.message}\n`);
        return { content: "", inferenceTime: 0, error: true };
    }

    const t1 = Date.now();
    return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };
}

// 从文本中提取标准答案
function extractExpect(answerStr) {
    if (!answerStr) return NaN;
// 处理extractExpect相关逻辑
    const match = answerStr.match(/####\s*(-?[\d,.]+)/);
    if (match) {
// 返回结果
        return parseFloat(match[1].replace(/,/g, ""));
    }
    return NaN;
}

// 从文本中提取标准答案
function extractAnswer(rawOutput) {
    if (!rawOutput) return NaN;
    
// 处理extractAnswer相关逻辑
    let cleanText = rawOutput;
    const thinkIndex = rawOutput.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = rawOutput.slice(thinkIndex + 8).trim();
    }

// 处理extractAnswer相关逻辑
// 处理extractAnswer相关逻辑
    const match = cleanText.match(/Answer:\s*[^\d-]*(-?[\d,.]+)/i);
    if (match) {
        return parseFloat(match[1].replace(/,/g, ""));
    }

// 处理extractAnswer相关逻辑
    const boxedMatch = cleanText.match(/\\boxed\{(-?[\d,.]+)\}/);
    if (boxedMatch) {
        return parseFloat(boxedMatch[1].replace(/,/g, ""));
    }

// 处理extractAnswer相关逻辑
    const allNumbers = cleanText.match(/-?[\d,.]+/g);
    if (allNumbers && allNumbers.length > 0) {
// 处理extractAnswer相关逻辑
        const lastNum = allNumbers[allNumbers.length - 1];
        if (/\d/.test(lastNum)) {
             return parseFloat(lastNum.replace(/,/g, ""));
        }
    }

    return NaN;
}

async function main() {
// 处理main相关逻辑
    const dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
 console.error(` ? ${dataPath}`);
        return;
    }

// 输出阶段统计信息
 console.log(" GSM8K ...");
    const rawData = fs.readFileSync(dataPath, "utf-8");
// 处理main相关逻辑
    let dataset = rawData.split(/\r?\n/).filter(line => line.trim() !== "").map(line => {
        try { return JSON.parse(line); } catch(e) { return null; }
    }).filter(item => item !== null);

// 分支条件处理
    if (dataset.length > 100) {
 console.log(` ?(${dataset.length} ? ?100 ?..`);
        dataset = dataset.slice(0, 100);
    }

    const total = dataset.length;
 console.log(` ?GSM8K (${total} ?`);

// 分支条件处理
    if (!fs.existsSync("./result")) fs.mkdirSync("./result");
    const resFile = "./result/gsm8k_res.jsonl";
    fs.writeFileSync(resFile, "");

    let count = 0;
    
// 遍历数据集样本
    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.question;
        const expectVal = extractExpect(item.answer); // 读取标准答案
 process.stdout.write(` [${i + 1}/${total}] ?.. `);

// 处理main相关逻辑
        const { content: output, inferenceTime, error } = await askStream(question);

        if (error) {
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

// 处理main相关逻辑
        const answerVal = extractAnswer(output);
        
// 处理main相关逻辑
        const isCorrect = !isNaN(answerVal) && !isNaN(expectVal) && Math.abs(answerVal - expectVal) < 1e-6;
        
        if (isCorrect) count++;

        const acc = ((count / (i + 1)) * 100).toFixed(1);
        const timeStr = inferenceTime.toFixed(1) + "s";

// 打印实时进度
        process.stdout.write("\r" + " ".repeat(100) + "\r"); 
        
// 打印实时进度
// 打印实时进度
 process.stdout.write(` [${i + 1}/${total}] ${isCorrect ? 'OK' : 'FAIL'} | Acc:${acc}% | :${timeStr} | ?${answerVal} ( ?${expectVal})\n`);

// 构建本题结果记录
        const record = {
            id: i + 1,
            q: question,
            out: output, // 处理main相关逻辑
            ans_ext: answerVal,
            exp: expectVal,
            ok: isCorrect,
            ms: (inferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

// 题间冷却，避免请求过载
        if (i < total - 1) {
            const steps = CONFIG.cooldown_ms / 100;
            for(let c = 0; c < steps; c++) {
 process.stdout.write(`\r ?.. ${(CONFIG.cooldown_ms - c*100)/1000}s `);
                await new Promise(r => setTimeout(r, 100));
            }
            process.stdout.write("\r" + " ".repeat(40) + "\r"); 
        }
    }

 console.log(`\n : ${((count / total) * 100).toFixed(2)}%`);
}

main();


