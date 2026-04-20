const fs = require("fs");
const path = require("path");

// ================== ⚙️ Configuration ==================
const CONFIG = {
    api_url: "http://localhost:9000/chat",
    model_name: "9g_8b_thinking",
    max_tokens: 1024,      // 稍微放宽一点，让它能正常进行知识检索
    cooldown_ms: 500,      
    timeout_ms: 120000,    
    data_file: "../data_sets/TriviaQA/verified-web-dev.json",
    limit: 100             
};

// ================== 🌐 Network & API ==================
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

async function ask(question) {
    // 💡 优化 1：去掉冲突的 <think> 标签，让模型自行发挥思维链
    const fullPrompt = `You are a concise trivia expert.

Question:
${question}

Instructions:
1. Think step-by-step to recall the correct fact.
2. Output the final answer concisely (just the entity, name, or fact).
3. Start your final answer strictly with "Answer: ".

Example format:
... your reasoning ...
Answer: <concise_answer>
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

// ================== 🧠 Parsing & Evaluation ==================
function extractAnswer(rawOutput) {
    if (!rawOutput) return "FORMAT_ERROR";
    
    let cleanText = rawOutput;

    // 适配九格分割符及标准 think 分割符
    if (rawOutput.includes("**🤖 回答:**")) {
        const parts = rawOutput.split("**🤖 回答:**");
        cleanText = parts[parts.length - 1].trim();
    } else if (rawOutput.includes("</think>")) {
        const parts = rawOutput.split("</think>");
        cleanText = parts[parts.length - 1].trim();
    }

    // 1. 优先提取 Answer: 后的内容
    const match = cleanText.match(/\*?Answer:\*?\s*(.*)/i);
    if (match) {
        let result = match[1].split('\n')[0].replace(/^[\s"'\[\]()]+|[\s"'\[\]()]+$/g, "").trim();
        if (result.length > 0) return result;
    }

    // 💡 优化 2：智能兜底。如果没写 Answer: 但文本非常短（典型的 Trivia 答案），直接作为答案
    const lines = cleanText.split('\n').filter(l => l.trim().length > 0);
    if (lines.length > 0 && cleanText.length < 100) {
        return lines[lines.length - 1].replace(/^[\s"'\[\]()]+|[\s"'\[\]()]+$/g, "").trim();
    }

    return "FORMAT_ERROR";
}

function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer || modelAnswer === "FORMAT_ERROR") return false;
    const ans = modelAnswer.toLowerCase();
    
    // TriviaQA 包含即算对（因为标准答案是 Alias 列表）
    return expectList.some(alias => ans.includes(alias.toLowerCase()));
}

// ================== 🚀 Main Pipeline ==================
async function main() {
    let dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        dataPath = path.join(__dirname, "..", "data_sets", "TriviaQA", "verified-web-dev.json");
    }

    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] Cannot find TriviaQA dataset at ${dataPath}`);
        return;
    }

    console.log(`[INFO] Loading TriviaQA Dataset from: ${dataPath}`);
    const rawData = fs.readFileSync(dataPath, "utf-8");
    let dataset = [];
    try {
        const json = JSON.parse(rawData);
        dataset = json.Data || json; 
    } catch (e) {
        console.error(`[ERROR] JSON Parse Failed: ${e.message}`);
        return;
    }

    if (dataset.length > CONFIG.limit) {
        console.log(`[INFO] Dataset size (${dataset.length}) exceeds limit. Truncating to ${CONFIG.limit}.`);
        dataset = dataset.slice(0, CONFIG.limit);
    }

    const total = dataset.length;
    console.log(`[INFO] Start TriviaQA Eval (${total} items) | API Port: 9000`);
    console.log("------------------------------------------------------------");

    const resDir = path.join(__dirname, "result");
    if (!fs.existsSync(resDir)) fs.mkdirSync(resDir);
    const resFile = path.join(resDir, "triviaqa_res.jsonl");
    fs.writeFileSync(resFile, ""); 

    let correctCount = 0;
    let totalTime = 0; 
    let validResponsesCount = 0;

    for (let i = 0; i < total; i++) {
        const item = dataset[i];
        const question = item.Question;
        const expectList = item.Answer.NormalizedAliases || []; 

        process.stdout.write(`[${i + 1}/${total}] Calculating...`);

        const { content: output, inferenceTime, error, errorMsg } = await ask(question);

        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);

        if (error) {
            console.log(`[${i + 1}/${total}] [ERROR] ${errorMsg}`);
            await new Promise(r => setTimeout(r, 2000));
            continue;
        }

        totalTime += inferenceTime;
        validResponsesCount++;

        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) correctCount++;

        const acc = ((correctCount / validResponsesCount) * 100).toFixed(1);
        const currentAvgTime = (totalTime / validResponsesCount).toFixed(1);
        
        const shortAns = answer.length > 20 ? answer.substring(0, 20) + "..." : answer;
        const shortExp = expectList.length > 0 ? (expectList[0].length > 20 ? expectList[0].substring(0, 20) + "..." : expectList[0]) : "N/A";
        
        const icon = correct ? '[OK]' : '[FAIL]';
        
        console.log(`[${i + 1}/${total}] ${icon} Acc:${acc}% | Time:${inferenceTime.toFixed(1)}s (Avg:${currentAvgTime}s) | Ans:${shortAns} (Exp:${shortExp})`);

        const record = {
            id: i + 1,
            q: question,
            out: output,
            ans_ext: answer,
            exp: expectList,
            ok: correct,
            ms: (inferenceTime * 1000).toFixed(0)
        };
        fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

        if (i < total - 1) {
            await new Promise(r => setTimeout(r, CONFIG.cooldown_ms));
        }
    }

    const finalAvgTime = validResponsesCount > 0 ? (totalTime / validResponsesCount).toFixed(2) : "0.00";
    const finalAcc = total > 0 ? ((correctCount / total) * 100).toFixed(2) : "0.00";

    const summaryStr = `\n[SUMMARY] Total: ${total} | Correct: ${correctCount} | Accuracy: ${finalAcc}% | Avg Latency: ${finalAvgTime}s\n`;
    
    console.log("------------------------------------------------------------");
    console.log(summaryStr.trim());
    
    fs.appendFileSync(resFile, summaryStr);
}

main();