// 导入文件系统模块
const fs = require("fs");
const path = require("path");
const { openChatCompletionStream } = require("./api_client");

// 测试运行配置
const CONFIG = {
    api_url: "http://172.22.162.17:8000/chat/completions",
    model_name: "deepseek-r1",
// 单次请求最大输出长度
    max_tokens: 4096, 
// 样本间冷却时间（毫秒）
    cooldown_ms: 2000, 
// 单次请求超时（毫秒）
    timeout_ms: 600000,
// 数据集文件路径
    data_file: "../data_sets/DROP/train.jsonl",
// 业务逻辑处理
    limit: 100
};
// ================================================

// 调用模型并获取回答
async function askStream(prompt, isNumberType) {
    const systemPrompt = "You are an expert in reading comprehension and arithmetic.";
    
// 处理askStream相关逻辑
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
        const { response } = await openChatCompletionStream({
            preferredUrl: CONFIG.api_url,
            payload,
            timeoutMs: CONFIG.timeout_ms
        });

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
 process.stdout.write(`\r ? ... [${fullContent.length} ...${preview} `);
                            }
                        }
                    } catch (e) { }
                }
            }
        }
    } catch (err) {
 process.stdout.write(`\n ? :\n${err.message}\n`);
        return { content: "", inferenceTime: 0, error: true, errorMsg: err.message };
    }

    const t1 = Date.now();
    return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };
}

// 函数：buildBasePrompt
function buildBasePrompt(passage, question) {
    return `Passage:\n${passage}\n\nQuestion:\n${question}`;
}

// 函数：hasNumberType
function hasNumberType(types) {
    return Array.isArray(types) && types.some(t => String(t).toLowerCase() === "number");
}

// 文本归一化，便于稳健比较
function normalizeAnswer(s) {
    if (!s) return "";
    return String(s)
        .toLowerCase()
        .replace(/\b(a|an|the)\b/g, " ") // 去除冠词，降低匹配噪声
        .replace(/[.,!?;:"]/g, "") // 去除常见标点
        .replace(/\s+/g, " ") // 合并多余空白字符
        .trim();
}

// 从文本中提取标准答案
function extractAnswer(rawOutput) {
    if (!rawOutput) return "";
    
// 处理extractAnswer相关逻辑
    let cleanText = rawOutput;
    const thinkIndex = rawOutput.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = rawOutput.slice(thinkIndex + 8).trim();
    }

// 处理extractAnswer相关逻辑
    const match = cleanText.match(/Answer:\s*(.*)/i);
    let result = "";
    if (match) {
// 处理extractAnswer相关逻辑
        result = match[1].split('\n')[0];
    } else {
// 处理extractAnswer相关逻辑
        const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
        if (lines.length > 0) result = lines[lines.length - 1];
    }
    
// 返回结果
 return result.replace(/^[\s"' ?>\[\]()]+|[\s"' ?>\[\]()]+$/g, "");
}

// 函数：matchExpect
function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer) return false;
    const normModel = normalizeAnswer(modelAnswer);

// 返回结果
    return expectList.some(exp => {
        const normExp = normalizeAnswer(exp);
// 分支条件处理
        if (normModel.includes(normExp)) return true;
// 处理matchExpect相关逻辑
        const numModel = parseFloat(normModel);
        const numExp = parseFloat(normExp);
        if (!isNaN(numModel) && !isNaN(numExp)) {
            return Math.abs(numModel - numExp) < 1e-6;
        }
        return false;
    });
}

async function main() {
// 处理main相关逻辑
    const dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
 console.error(` ? ${dataPath}`);
        return;
    }

// 输出阶段统计信息
 console.log(" DROP ...");
    const rawData = fs.readFileSync(dataPath, "utf-8");
    let dataset = rawData.split(/\r?\n/)
        .filter(line => line.trim() !== "")
        .map(line => {
            try { return JSON.parse(line); } catch(e) { return null; }
        })
        .filter(item => item !== null);

// 分支条件处理
    if (dataset.length > CONFIG.limit) {
 console.log(` ?(${dataset.length} ? ?${CONFIG.limit} ?..`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
 console.log(` ?DROP (${total} ?`);

// 分支条件处理
    if (!fs.existsSync("./result")) fs.mkdirSync("./result");
    const resFile = "./result/drop_res.jsonl";
    fs.writeFileSync(resFile, "");

    let count = 0;
    let successCount = 0;
    let errorCount = 0;
    let totalTime = 0; // 累计总耗时（毫秒）
// 遍历数据集样本
    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const passage = item.passage;
        const question = item.question;
        const types = (item.answers_spans && item.answers_spans.types) || [];
        const expectList = (item.answers_spans && item.answers_spans.spans) || [];
        
        const isNum = hasNumberType(types);
        const basePrompt = buildBasePrompt(passage, question);

 process.stdout.write(` [${i + 1}/${total}] ?.. `);

// 处理main相关逻辑
        const { content: output, inferenceTime, error } = await askStream(basePrompt, isNum);

        if (error) {
            errorCount++;
            await new Promise(r => setTimeout(r, 5000));
            continue;
        }

        successCount++;

// 处理main相关逻辑
        totalTime += inferenceTime;

// 提取最终答案文本
        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) count++;

// 计算当前累计准确率
        const acc = ((count / (i + 1)) * 100).toFixed(1);
        const currentAvgTime = (totalTime / (i + 1)).toFixed(2);
        const thisTimeStr = inferenceTime.toFixed(1) + "s";

// 打印实时进度
        process.stdout.write("\r" + " ".repeat(100) + "\r"); 
        
// 处理main相关逻辑
        const shortAns = answer.length > 15 ? answer.substring(0, 15) + "..." : answer;
        const shortExp = expectList[0].length > 15 ? expectList[0].substring(0, 15) + "..." : expectList[0];
        
// 打印实时进度
 process.stdout.write(` [${i + 1}/${total}] ${correct ? 'OK' : 'FAIL'} | Acc:${acc}% | :${thisTimeStr} | Avg:${currentAvgTime}s | ?${shortAns} ( ?${shortExp})\n`);

// 构建本题结果记录
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

    if (successCount === 0) {
 console.log("\nAll requests failed. No model responses were received.");
 console.log("Please check network reachability or set OPENAI_API_URL explicitly.");
        return;
    }

    const finalAvgTime = (totalTime / successCount).toFixed(2);
    const finalAcc = ((count / total) * 100).toFixed(2);

    console.log("Test completed.");
 console.log(` : ${finalAcc}%`);
    console.log(`Average latency: ${finalAvgTime} s`);
    if (errorCount > 0) {
 console.log(`Failed requests: ${errorCount}`);
    }
}

main();

