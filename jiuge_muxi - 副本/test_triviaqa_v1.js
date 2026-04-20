// test_triviaqa.js
const fs = require("fs");
const path = require("path");
const { openChatCompletionStream } = require("./api_client");

// ================== ⚙️ 核心配置 ==================
const CONFIG = {
    api_url: "http://172.22.162.17:8000/chat/completions",
    model_name: "9g_8b_thinking",
    // 虽然要求思考简短，但保留足够的 max_tokens 以防回答被截断
    max_tokens: 4096, 
    // 答完一题休息 3 秒
    cooldown_ms: 3000, 
    // 单题超时 10 分钟
    timeout_ms: 600000,
    // 数据文件路径
    data_file: "../data_sets/TriviaQA/verified-web-dev.json"
};
// ================================================

// 核心请求函数 (流式)
async function askStream(question) {
    // 构造提示词：强制要求 "Answer: " 格式
    const systemPrompt = "You are a concise trivia expert.";
    
    // 👇 修改点 1：在 Instructions 中明确要求思考简短
    const userPrompt = `
Question: ${question}

Instructions:
1. Think step-by-step first, but keep your thinking process VERY BRIEF and concise (limit to roughly 50-100 words).
2. After thinking, output the final answer concisely.
3. Start your final answer with "Answer:".

Example:
... short thinking process ...
Answer: Paris
`.trim();

    const payload = {
        model: CONFIG.model_name,
        messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
        ],
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1, // 问答题需要低温
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
                            // 实时反馈
                            if (fullContent.length % 50 === 0) {
                                const preview = fullContent.slice(-40).replace(/\n/g, " ");
                                process.stdout.write(`\r   ⏳ 思考中... [${fullContent.length}字] ...${preview} `);
                            }
                        }
                    } catch (e) { }
                }
            }
        }
    } catch (err) {
        process.stdout.write(`\n❌ 请求出错:\n${err.message}\n`);
        return { content: "", inferenceTime: 0, error: true, errorMsg: err.message };
    }

    const t1 = Date.now();
    return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };
}

// 🧹 清洗答案：去掉 </think> 之前的内容，提取 "Answer:" 后面的内容
function extractAnswer(rawOutput) {
    if (!rawOutput) return "";
    
    // 1. 先去掉思考过程 (兼容 deepseek 风格的 </think>)
    let cleanText = rawOutput;
    
    // 找到最后一个 </think> 的位置
    const thinkIndex = rawOutput.lastIndexOf("</think>");
    if (thinkIndex !== -1) {
        cleanText = rawOutput.slice(thinkIndex + 8).trim();
    }

    // 2. 提取 "Answer:" 之后的内容
    const match = cleanText.match(/Answer:\s*(.*)/i);
    if (match) {
        // 取第一行作为答案，并去掉句号等标点
        return match[1].split('\n')[0].replace(/[。.,!]/g, "").trim();
    }

    // 3. 如果没找到 "Answer:"，就硬取最后一行非空内容
    const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0) {
        return lines[lines.length - 1].replace(/[。.,!]/g, "").trim();
    }

    return "";
}

// 🎯 判题逻辑：只要答案里包含了任何一个别名，就算对
function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer) return false;
    const ans = modelAnswer.toLowerCase();
    // 宽松匹配：只要包含了别名即可 (比如 "The answer is Harry Potter" 包含了 "Harry Potter")
    return expectList.some(alias => ans.includes(alias.toLowerCase()));
}

async function main() {
    // 1. 寻找数据文件
    const dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        console.error(`❌ 错误：找不到数据文件 ${dataPath}`);
        console.error("请确认 TriviaQA 文件夹在当前目录下。");
        return;
    }

    // 2. 加载数据
    console.log("📂 正在加载 TriviaQA 数据...");
    const raw = fs.readFileSync(dataPath, "utf-8");
    let dataset = [];
    try {
        const json = JSON.parse(raw);
        // TriviaQA 结构通常是 { Data: [...] }
        dataset = json.Data || json; 
    } catch (e) {
        console.error("❌ JSON 解析失败:", e.message);
        return;
    }

    // 👇 修改点 2：截取前 100 条数据
    if (dataset.length > 100) {
        console.log(`✂️ 数据集较大 (${dataset.length}条)，仅测试前 100 条...`);
        dataset = dataset.slice(0, 100);
    }

    const total = dataset.length;
    console.log(`🚀 开始测试 TriviaQA (${total} 条数据)`);

    // 3. 准备结果文件
    if (!fs.existsSync("./result")) fs.mkdirSync("./result");
    const resFile = "./result/triviaqa_res.jsonl";
    fs.writeFileSync(resFile, "");

    let count = 0;
    let successCount = 0;
    let errorCount = 0;
    
    // 4. 开始循环
    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.Question;
        const expectList = item.Answer.NormalizedAliases; // 这是一个数组

        process.stdout.write(`   [${i + 1}/${total}] 连接中... `);

        // --- 请求 ---
        const { content: output, inferenceTime, error } = await askStream(question);

        if (error) {
            errorCount++;
            await new Promise(r => setTimeout(r, 10000));
            continue;
        }

        successCount++;

        // --- 提取与判题 ---
        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) count++;

        const acc = ((count / (i + 1)) * 100).toFixed(1);
        const timeStr = inferenceTime.toFixed(1) + "s";

        // --- UI 更新 ---
        process.stdout.write("\r" + " ".repeat(100) + "\r"); 
        // 打印简略信息，防止刷屏
        const shortAns = answer.length > 20 ? answer.substring(0, 20) + "..." : answer;
        const shortExp = expectList[0].length > 20 ? expectList[0].substring(0, 20) + "..." : expectList[0];
        
        process.stdout.write(`   [${i + 1}/${total}] ${correct ? '✅' : '❌'} | Acc:${acc}% | 耗时:${timeStr} | 答:${shortAns} (标:${shortExp})\n`);

        // --- 记录文件 ---
        const record = {
            id: i + 1,
            q: question,
            out: output,      // 原始长输出 (包含思考)
            ans_ext: answer,  // 提取出的答案
            exp: expectList,
            ok: correct,
            ms: (inferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        // --- 冷却显存 ---
        if (i < total - 1) {
            const steps = CONFIG.cooldown_ms / 100;
            for(let c = 0; c < steps; c++) {
                process.stdout.write(`\r            ❄️ 冷却中... ${(CONFIG.cooldown_ms - c*100)/1000}s `);
                await new Promise(r => setTimeout(r, 100));
            }
            process.stdout.write("\r" + " ".repeat(40) + "\r"); 
        }
    }

    if (successCount === 0) {
        console.log(`\n❌ 测试终止：${total} 条请求全部失败，没有拿到任何模型响应。`);
        console.log("请检查当前机器是否能访问模型服务，或显式设置 OPENAI_API_URL。");
        return;
    }

    if (errorCount > 0) {
        console.log(`\n⚠️ 有 ${errorCount} 条请求失败，以下准确率仅基于全部 ${total} 条样本统计。`);
    }

    console.log(`\n🎉 测试完成！最终准确率: ${((count / total) * 100).toFixed(2)}%`);
}

main();
