// 导入文件系统模块
const fs = require("fs");
const path = require("path");
const { openChatCompletionStream } = require("./api_client");

// 测试运行配置
const CONFIG = {
    api_url: "http://172.22.162.17:8000/chat/completions",
    model_name: "9g_8b_thinking",
// 单次请求最大输出长度
    max_tokens: 8192, 
// 样本间冷却时间（毫秒）
    cooldown_ms: 3000, 
// 单次请求超时（毫秒）
    timeout_ms: 600000,
// 数据集文件路径
    data_file: "../data_sets/TriviaQA/verified-web-dev.json"
};
// ================================================

// 调用模型并获取回答
async function askStream(question) {
// 系统提示词
    const systemPrompt = "You are a concise trivia expert.";
    const userPrompt = `
Question: ${question}

Instructions:
1. Think step-by-step first.
2. After thinking, output the final answer concisely.
3. Start your final answer with "Answer:".

Example:
... thinking process ...
Answer: Paris
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
 process.stdout.write(`\n ? :\n${err.message}\n`);
        return { content: "", inferenceTime: 0, error: true, errorMsg: err.message };
    }

    const t1 = Date.now();
    return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };
}

// 从文本中提取标准答案
function extractAnswer(rawOutput) {
    if (!rawOutput) return "";
    
// 处理extractAnswer相关逻辑
    let cleanText = rawOutput;
    const thinkEndValues = ["</think>", "```"]; 
    
// 处理extractAnswer相关逻辑
    const thinkIndex = rawOutput.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = rawOutput.slice(thinkIndex + 8).trim();
    }

// 处理extractAnswer相关逻辑
    const match = cleanText.match(/Answer:\s*(.*)/i);
    if (match) {
// 返回结果
 return match[1].split('\n')[0].replace(/[銆?,!]/g, "").trim();
    }

// 处理extractAnswer相关逻辑
    const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) {
 return lines[lines.length - 1].replace(/[銆?,!]/g, "").trim();
    }

    return "";
}

// 函数：matchExpect
function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer) return false;
    const ans = modelAnswer.toLowerCase();
// 返回结果
    return expectList.some(alias => ans.includes(alias.toLowerCase()));
}

async function main() {
// 处理main相关逻辑
    const dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
 console.error(` ? ${dataPath}`);
        console.error('Please make sure the TriviaQA folder is available.');
        return;
    }

// 输出阶段统计信息
 console.log(" TriviaQA ...");
    const raw = fs.readFileSync(dataPath, "utf-8");
    let dataset = [];
    try {
        const json = JSON.parse(raw);
// 处理main相关逻辑
        dataset = json.Data || json; 
    } catch (e) {
 console.error(" ?JSON :", e.message);
        return;
    }

    const total = dataset.length;
 console.log(` ?TriviaQA (${total} ?`);

// 分支条件处理
    if (!fs.existsSync("./result")) fs.mkdirSync("./result");
    const resFile = "./result/triviaqa_res.jsonl";
    fs.writeFileSync(resFile, "");

    let count = 0;
    let successCount = 0;
    let errorCount = 0;
    
// 遍历数据集样本
    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.Question;
        const expectList = item.Answer.NormalizedAliases; // 读取标准答案
 process.stdout.write(` [${i + 1}/${total}] ?.. `);

// 处理main相关逻辑
        const { content: output, inferenceTime, error } = await askStream(question);

        if (error) {
            errorCount++;
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

        successCount++;

// 提取最终答案文本
        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) count++;

        const acc = ((count / (i + 1)) * 100).toFixed(1);
        const timeStr = inferenceTime.toFixed(1) + "s";

// 打印实时进度
        process.stdout.write("\r" + " ".repeat(100) + "\r"); 
// 处理main相关逻辑
        const shortAns = answer.length > 20 ? answer.substring(0, 20) + "..." : answer;
        const shortExp = expectList[0].length > 20 ? expectList[0].substring(0, 20) + "..." : expectList[0];
        
 process.stdout.write(` [${i + 1}/${total}] ${correct ? 'OK' : 'FAIL'} | Acc:${acc}% | :${timeStr} | ?${shortAns} ( ?${shortExp})\n`);

// 构建本题结果记录
        const record = {
            id: i + 1,
            q: question,
            out: output, // 处理main相关逻辑
            ans_ext: answer, // 处理main相关逻辑
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
 console.log(`\nAll ${total} requests failed. No model responses were received.`);
 console.log("Please check network reachability or set OPENAI_API_URL explicitly.");
        return;
    }

    if (errorCount > 0) {
 console.log(`\nWarning: ${errorCount} requests failed. Accuracy below is still computed over ${total} samples.`);
    }

 console.log(`\n : ${((count / total) * 100).toFixed(2)}%`);
}

main();

