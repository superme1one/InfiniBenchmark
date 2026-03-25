const fs = require("fs");
const path = require("path");

// ================== ⚙️ Configuration ==================
const CONFIG = {
    // 修改为 8000 端口，匹配你服务器启动的端口
    api_url: "http://localhost:8000/chat", 
    model_name: "9g_8b_thinking",
    max_tokens: 800,      
    cooldown_ms: 200,      // 摩尔线程推理较快，可以稍微缩短冷却
    timeout_ms: 120000,    
    data_file: "../data_sets/DROP/train.jsonl", 
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

async function ask(passage, question, isNumberType) {
    const instructions = isNumberType 
        ? `1. Think VERY BRIEFLY.\n2. The answer MUST be a number.\n3. Output the final answer starting with "Answer: ".`
        : `1. Think VERY BRIEFLY.\n2. Extract the answer directly.\n3. Output the final answer starting with "Answer: ".`;

    const fullPrompt = `Passage:\n${passage}\n\nQuestion:\n${question}\n\nInstructions:\n${instructions}`;

    // 适配 InfiniLM 的 Payload 格式
    const payload = {
        prompt: fullPrompt,
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1, 
        top_p: 1.0,
        // 部分版本可能不支持 top_k 参数，如果报错请删除下一行
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
        
        // 核心适配：InfiniLM 的返回字段通常是 'response' 或 'text'
        // 根据你之前的截图逻辑，这里保留 data.response
        const fullContent = data.response || data.text || ""; 

        const t1 = Date.now();
        return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };

    } catch (err) {
        return { content: "", inferenceTime: 0, error: true, errorMsg: err.message };
    }
}

// ... (中间的 normalizeAnswer, extractAnswer, matchExpect 函数保持不变) ...

// ================== 🧠 Parsing & Evaluation ==================
function hasNumberType(types) {
    return Array.isArray(types) && types.some(t => String(t).toLowerCase() === "number");
}

function normalizeAnswer(s) {
    if (!s) return "";
    return String(s).toLowerCase().replace(/\b(a|an|the)\b/g, "").replace(/[.,!?;:"]/g, "").replace(/\s+/g, " ").trim();
}

function extractAnswer(rawOutput) {
    if (!rawOutput) return "FORMAT_ERROR";
    let cleanText = rawOutput;

    // 适配九格/InfiniLM 可能出现的标记
    if (rawOutput.includes("**🤖 回答:**")) {
        cleanText = rawOutput.split("**🤖 回答:**").pop().trim();
    } else if (rawOutput.includes("</think>")) {
        cleanText = rawOutput.split("</think>").pop().trim();
    }

    const match = cleanText.match(/\*?Answer:\*?\s*(.*)/i);
    if (match) {
        let result = match[1].split('\n')[0].replace(/^[\s"'\[\]()]+|[\s"'\[\]()]+$/g, "").trim();
        if (result.length > 0) return result;
    }
    
    const numbers = cleanText.match(/-?[\d,.]+/g);
    if (numbers && numbers.length > 0) {
        return numbers[numbers.length - 1].replace(/,/g, "");
    }

    return "FORMAT_ERROR";
}

function matchExpect(expectList, modelAnswer) {
    if (!modelAnswer || modelAnswer === "FORMAT_ERROR") return false;
    const normModel = normalizeAnswer(modelAnswer);
    return expectList.some(exp => {
        const normExp = normalizeAnswer(exp);
        const numModel = parseFloat(normModel);
        const numExp = parseFloat(normExp);
        if (!isNaN(numModel) && !isNaN(numExp)) return Math.abs(numModel - numExp) < 1e-6;
        return (normModel === normExp && normExp.length > 0);
    });
}

// ================== 🚀 Main Pipeline (逻辑同原脚本) ==================
async function main() {
    // 自动检测数据集路径
    let dataPath = path.join(__dirname, CONFIG.data_file);
    if (!fs.existsSync(dataPath)) {
        dataPath = path.join(__dirname, "..", "data_sets", "DROP", "train.jsonl");
    }
    
    if (!fs.existsSync(dataPath)) {
        console.error(`[ERROR] 找不到数据集: ${dataPath}`);
        return;
    }

    const rawData = fs.readFileSync(dataPath, "utf-8");
    let dataset = rawData.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
    if (dataset.length > CONFIG.limit) dataset = dataset.slice(0, CONFIG.limit);

    console.log(`[INFO] 摩尔线程测试开始 | 目标: http://localhost:8000 | 样本量: ${dataset.length}`);
    console.log("------------------------------------------------------------");

    const resDir = path.join(__dirname, "result");
    if (!fs.existsSync(resDir)) fs.mkdirSync(resDir);
    const resFile = path.join(resDir, "drop_res.jsonl");
    fs.writeFileSync(resFile, ""); 

    let correctCount = 0;
    let totalTime = 0; 

    for (let i = 0; i < dataset.length; i++) {
        const item = dataset[i];
        const isNum = hasNumberType(item.answers_spans?.types || []);
        const expectList = item.answers_spans?.spans || [];
        
        const { content, inferenceTime, error, errorMsg } = await ask(item.passage, item.question, isNum);

        if (error) {
            console.log(`[${i + 1}] [ERROR] ${errorMsg}`);
            continue;
        }

        totalTime += inferenceTime;
        const answer = extractAnswer(content);
        const correct = matchExpect(expectList, answer);
        if (correct) correctCount++;

        const icon = correct ? '✅' : '❌';
        console.log(`[${i + 1}/${dataset.length}] ${icon} Time:${inferenceTime.toFixed(2)}s | Ans:${answer} | Exp:${expectList[0]}`);

        fs.appendFileSync(resFile, JSON.stringify({ id: i+1, ok: correct, time: inferenceTime }) + "\n");
        await new Promise(r => setTimeout(r, CONFIG.cooldown_ms));
    }

    console.log("------------------------------------------------------------");
    console.log(`[完成] 正确率: ${(correctCount/dataset.length*100).toFixed(2)}% | 平均耗时: ${(totalTime/dataset.length).toFixed(2)}s`);
}

main();