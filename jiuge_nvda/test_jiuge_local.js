// 导入文件系统模块
const fs = require("fs");
const path = require("path");

// 测试运行配置
const CONFIG = {
// 模型服务接口地址
    api_url: "http://localhost:8000/v1/chat/completions", 
    model_name: "9g_8b_thinking", 
    max_tokens: 4096,
// 单次请求超时（毫秒）
    timeout_ms: 600000, 
// 样本间冷却时间（毫秒）
    cooldown_ms: 3000 
};
// =============================================

const testName = [
    "abstract_algebra", "anatomy", "astronomy", "business_ethics", "clinical_knowledge",
    "college_biology", "college_chemistry", "college_computer_science", "college_mathematics",
    "college_medicine", "college_physics", "computer_security", "conceptual_physics",
    "econometrics", "electrical_engineering", "elementary_mathematics", "formal_logic",
    "global_facts", "high_school_biology", "high_school_chemistry", "high_school_computer_science",
    "high_school_european_history", "high_school_geography", "high_school_government_and_politics",
    "high_school_macroeconomics", "high_school_mathematics", "high_school_microeconomics",
    "high_school_physics", "high_school_psychology", "high_school_statistics", "high_school_us_history",
    "high_school_world_history", "human_aging", "human_sexuality", "international_law",
    "jurisprudence", "logical_fallacies", "machine_learning", "management", "marketing",
    "medical_genetics", "miscellaneous", "moral_disputes", "moral_scenarios", "nutrition",
    "philosophy", "prehistory", "professional_accounting", "professional_law",
    "professional_medicine", "professional_psychology", "public_relations", "security_studies",
    "sociology", "us_foreign_policy", "virology", "world_religions"
];

// 封装带超时控制的请求
async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(resource, {
            ...options,
            signal: controller.signal  
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// 调用模型并获取回答
async function ask(prompt, retries = 5) { // 调用模型并获取回答
    const payload = {
        model: CONFIG.model_name,
        messages: [
            { 
                role: "user", 
                content: prompt + "\nPlease think step by step and output the final answer within boxed{}, e.g., boxed{A}." 
            }
        ],
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1,
        stream: false
    };

    const t0 = Date.now();
    
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetchWithTimeout(CONFIG.api_url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
                timeout: CONFIG.timeout_ms
            });

// 分支条件处理
            if (res.status === 503) {
 throw new Error("HTTP 503 Service Unavailable ( )");
            }

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();
            const content = data.choices?.[0]?.message?.content || "";
            const t1 = Date.now();
            return { content, inferenceTime: (t1 - t0) / 1000 };

        } catch (err) {
            const isTimeout = err.name === 'AbortError';
 const errMsg = isTimeout ? " " : err.message;
            
// 打印实时进度
 process.stdout.write(`\n [ ?{i+1} ${errMsg} -> 10 ?.. `);
            
            if (i === retries - 1) return { content: "Error", inferenceTime: 0 };
            
// 处理ask相关逻辑
            await new Promise(r => setTimeout(r, 10000));
        }
    }
}

// 函数：detailedQuestion
function detailedQuestion(str) {
    let data = ["", "", "", "", "", ""];
    let i = 0, quote = false;
    for (const ch of str) {
        if (ch === '"') { quote = !quote; continue; }
        if (ch === "," && !quote) { i++; continue; }
        if (i < 6) data[i] += ch;
    }
    return {
        question:
            data[0] +
            "\nA. " + data[1] +
            "\nB. " + data[2] +
            "\nC. " + data[3] +
            "\nD. " + data[4] +
            "\nThe answer should be A, B, C, or D." +
            "\nUse \"boxed{}\" to mark the answer.\n",
        answer: data[5] ? data[5].trim() : ""
    };
}

// 从文本中提取标准答案
function extractAnswer(str) {
    if (!str) return "invalid";
    const m = str.match(/boxed\{([A-D])\}/i);
    if (m) return m[1].toUpperCase();
    const m2 = str.match(/(?:answer|option) is\s?([A-D])/i);
    if (m2) return m2[1].toUpperCase();
    return "invalid";
}

// 函数：waitWithAnimation
async function waitWithAnimation(ms, message) {
    const frames = ['-', '\\', '|', '/'];
    let i = 0;
    const steps = ms / 100;
    for (let step = 0; step < steps; step++) {
        process.stdout.write(`\r   ${message} ${frames[i++ % frames.length]} `);
        await new Promise(r => setTimeout(r, 100));
    }
    process.stdout.write("\r" + " ".repeat(50) + "\r"); // 打印实时进度
}

// 主流程：逐题推理并统计指标
async function main() {
    const resultDir = path.join(__dirname, "result");
    if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir);

    console.log("Test setup ready. Please ensure backend service is running.");

    for (const tn of testName) {
        const csvPath = path.join(__dirname, "..", "data_sets", "MMLU", `${tn}_test.csv`);
        if (!fs.existsSync(csvPath)) continue;

        const csv = fs.readFileSync(csvPath, "utf-8");
        const lines = csv.split("\n").filter(l => l.trim().length);
        const resFile = path.join(resultDir, `${tn}_res.jsonl`);
        fs.writeFileSync(resFile, "");

        let count = 0, total = lines.length;

 console.log(`\n [${tn}] ?( ?${total} ?`);

        for (let idx = 0; idx < total; idx++) {
            const { question, answer: expect } = detailedQuestion(lines[idx]);
            
// 处理main相关逻辑
            const timer = setInterval(() => {
 process.stdout.write(`\r [${idx + 1}/${total}] ?.. `);
            }, 500);

// 处理main相关逻辑
            const { content: output, inferenceTime } = await ask(question);
            
            clearInterval(timer);

// 提取最终答案文本
            const answer = extractAnswer(output);
            const correct = answer === expect;
            if (correct) count++;

// 处理main相关逻辑
            const currentAcc = ((count / (idx + 1)) * 100).toFixed(1);
            const timeStr = inferenceTime.toFixed(1) + "s";
            
// 打印实时进度
 process.stdout.write(`\r [${idx + 1}/${total}] ${correct ? 'OK' : 'FAIL'} | ? ${currentAcc}% | : ${timeStr} | : ${answer} ( ${expect}) \n`);

// 构建本题结果记录
            const record = {
                id: idx + 1,
                out: output,
                ans: answer,
                exp: expect,
                ok: correct,
                ms: (inferenceTime * 1000).toFixed(0)
            };
            fs.appendFileSync(resFile, JSON.stringify(record) + "\n");

// 分支条件处理
            if (idx < total - 1) { // 处理main相关逻辑
 await waitWithAnimation(CONFIG.cooldown_ms, " ?..");
            }
        }
        
 console.log(` ${tn} -> : ${((count / total) * 100).toFixed(2)}%`);
    }
}

main();

