const fs = require("fs");
const path = require("path");

// 测试运行配置
const CONFIG = {
// 模型服务接口地址
    api_url: "http://localhost:9000/chat",
    
// 单次请求最大输出长度
    max_tokens: 4096, 
    
// 单次请求超时（毫秒）
    timeout_ms: 300000, 
    
// 样本间冷却时间（毫秒）
    cooldown_ms: 200,   
    
// 业务逻辑处理
    limit_per_subject: 50, 
    
// 业务逻辑处理
    data_dir: "../data_sets/MMLU" 
};

// 业务逻辑处理
const GLOBAL_STATS = {
    totalQuestions: 0,
    totalCorrect: 0,
    totalTimeMs: 0,
    startTime: Date.now()
};

// 业务逻辑处理
const SUBJECTS = [
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
        const response = await fetch(resource, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// 调用模型并获取回答
async function ask(prompt, subjectName) {
// 处理ask相关逻辑
    const fullPrompt = `You are an expert in ${subjectName.replace(/_/g, " ")}.

Question:
${prompt}

Instructions:
1. Think step by step to solve the problem.
2. **Be concise.** Do NOT double-check your work once you derive an answer.
3. You MUST end your response with exactly: "Answer: X" (where X is A, B, C, or D).
4. Do NOT output anything after the final answer.

Format Example:
<think>
... reasoning ...
</think>
Answer: A
`;

// 构造请求参数
    const payload = {
        prompt: fullPrompt,
        max_tokens: CONFIG.max_tokens,
        temperature: 0.1, // 采样温度
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
// 处理ask相关逻辑
        const fullContent = data.response || ""; 

        const t1 = Date.now();
        return { content: fullContent, inferenceTime: (t1 - t0) / 1000, error: false };

    } catch (err) {
        return { content: "", inferenceTime: 0, error: true, errorMsg: err.message };
    }
}

// 从文本中提取标准答案
function extractAnswer(rawOutput) {
    if (!rawOutput) return "INVALID";
    
    let cleanText = rawOutput;

// 处理extractAnswer相关逻辑
// 处理extractAnswer相关逻辑
    const thinkEndParts = rawOutput.split("</think>");
    if (thinkEndParts.length > 1) {
        cleanText = thinkEndParts[thinkEndParts.length - 1].trim();
    } else if (rawOutput.includes("<think>") && !rawOutput.includes("</think>")) {
// 处理extractAnswer相关逻辑
// 处理extractAnswer相关逻辑
        cleanText = rawOutput; 
    }

// 处理extractAnswer相关逻辑
    const patterns = [
        /Answer:\s*([A-D])/i, // 处理extractAnswer相关逻辑
        /The answer is\s*([A-D])/i, // 处理extractAnswer相关逻辑
        /The correct option is\s*([A-D])/i,
        /boxed\{([A-D])\}/i,              // LaTeX: \boxed{A}
        /^([A-D])$/m, // 处理extractAnswer相关逻辑
        /Option\s*([A-D])/i               // Option A
    ];

    for (const p of patterns) {
        const match = cleanText.match(p);
        if (match) return match[1].toUpperCase();
    }

// 处理extractAnswer相关逻辑
    const lastPart = cleanText.slice(-100); 
// 处理extractAnswer相关逻辑
    const looseMatch = lastPart.match(/(?:is|select|option)\s+([A-D])\W*$/i);
    if (looseMatch) return looseMatch[1].toUpperCase();

// 分支条件处理
    if (rawOutput.includes("<think>") && !rawOutput.includes("</think>")) {
        return "TRUNCATED";
    }

    return "INVALID";
}

// 函数：parseCSVLine
function parseCSVLine(line) {
    try {
        const parts = [];
        let current = "";
        let inQuote = false;
        
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                inQuote = !inQuote;
            } else if (char === ',' && !inQuote) {
                parts.push(current.trim().replace(/^"|"$/g, ""));
                current = "";
            } else {
                current += char;
            }
        }
        parts.push(current.trim().replace(/^"|"$/g, ""));
        
        if (parts.length < 6) return null;
        
        return {
            prompt: `${parts[0]}\nA) ${parts[1]}\nB) ${parts[2]}\nC) ${parts[3]}\nD) ${parts[4]}`,
            answer: parts[5].toUpperCase()
        };
    } catch (e) {
        return null;
    }
}

// 函数：logDashboard
function logDashboard(subject, currentQ, totalSubjectQ, isCorrect, answer, expected, time, errorMsg = null) {
    GLOBAL_STATS.totalQuestions++;
    if (isCorrect) GLOBAL_STATS.totalCorrect++;
    GLOBAL_STATS.totalTimeMs += (time * 1000);

    const globalAcc = ((GLOBAL_STATS.totalCorrect / GLOBAL_STATS.totalQuestions) * 100).toFixed(2);
    const globalAvgTime = (GLOBAL_STATS.totalTimeMs / GLOBAL_STATS.totalQuestions / 1000).toFixed(2);
    
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);

    const icon = errorMsg ? 'ERR' : (isCorrect ? 'OK' : 'FAIL');
    const colorAns = isCorrect ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';

    let logLine = `[${subject}] ${currentQ}/${totalSubjectQ} ${icon} `;
    if (errorMsg) {
        logLine += `Err: ${errorMsg}`;
    } else {
 logLine += `| ?${colorAns}${answer}${reset} ( ?${expected}) | ${time.toFixed(1)}s`;
    }

 const statsPart = ` | : \x1b[33m${globalAcc}%\x1b[0m | : ${globalAvgTime}s`;
    console.log(logLine + statsPart);
}

async function main() {
// 处理main相关逻辑
    let dataDir = path.join(__dirname, CONFIG.data_dir);
    if (!fs.existsSync(dataDir)) {
// 处理main相关逻辑
        dataDir = path.join(__dirname, "..", "data_sets", "MMLU");
    }
    if (!fs.existsSync(dataDir)) {
        console.error(`Error: cannot find MMLU dataset at ${dataDir}`);
        return;
    }

// 处理main相关逻辑
    const resultDir = path.join(__dirname, "result");
    if (!fs.existsSync(resultDir)) fs.mkdirSync(resultDir);
    const summaryFile = path.join(resultDir, "mmlu_summary.txt");
    fs.writeFileSync(summaryFile, `MMLU Test Summary (${new Date().toISOString()})\n\n`);

    console.log(`MMLU evaluation start | limit: ${CONFIG.limit_per_subject}/subject`);
 console.log(` Max Tokens: ${CONFIG.max_tokens} ( ?`);
    console.log("----------------------------------------------------------------");

// 循环处理样本
    for (const subject of SUBJECTS) {
        const csvPath = path.join(dataDir, `${subject}_test.csv`);
        if (!fs.existsSync(csvPath)) continue;

        const rawFile = fs.readFileSync(csvPath, "utf-8");
        const lines = rawFile.split("\n").filter(l => l.trim().length > 0);
        
        let testLines = lines;
        if (lines.length > CONFIG.limit_per_subject) {
            testLines = lines.slice(0, CONFIG.limit_per_subject);
        }
        
        const subTotal = testLines.length;
        let subCorrect = 0;
        const resFile = path.join(resultDir, `mmlu_${subject}_res.jsonl`);
        fs.writeFileSync(resFile, ""); 

        for (let i = 0; i < subTotal; i++) {
            const data = parseCSVLine(testLines[i]);
            if (!data) continue;

 process.stdout.write(` ?[${subject} ${i+1}/${subTotal}] Thinking...`);

            const { content: output, inferenceTime, error, errorMsg } = await ask(data.prompt, subject);

            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);

            let isCorrect = false;
            let answer = "ERR";

            if (error) {
                logDashboard(subject, i + 1, subTotal, false, "ERR", data.answer, 0, errorMsg);
// 处理main相关逻辑
                await new Promise(r => setTimeout(r, 2000));
            } else {
                answer = extractAnswer(output);
                isCorrect = answer === data.answer;
                if (isCorrect) subCorrect++;

                logDashboard(subject, i + 1, subTotal, isCorrect, answer, data.answer, inferenceTime);

// 分支条件处理
                if (answer === "INVALID" || answer === "TRUNCATED") {
 console.log("\n ?( ?00 ):");
                    console.log("Test setup ready. Please ensure backend service is running.");
                    console.log("");
                }

// 构建本题结果记录
                const record = {
                    id: i + 1,
                    subject: subject,
                    q: data.prompt,
                    out: output,
                    ans: answer,
                    exp: data.answer,
                    ok: isCorrect,
                    ms: (inferenceTime * 1000).toFixed(0)
                };
                fs.appendFileSync(resFile, JSON.stringify(record) + "\n");
            }

// 分支条件处理
            if (i < subTotal - 1) {
                await new Promise(r => setTimeout(r, CONFIG.cooldown_ms));
            }
        }

        const subAcc = subTotal > 0 ? ((subCorrect / subTotal) * 100).toFixed(1) : "0.0";
        fs.appendFileSync(summaryFile, `${subject}: ${subAcc}% (${subCorrect}/${subTotal})\n`);
    }

    const finalAcc = GLOBAL_STATS.totalQuestions > 0 
        ? ((GLOBAL_STATS.totalCorrect / GLOBAL_STATS.totalQuestions) * 100).toFixed(2) 
        : "0.00";
        
    console.log("\n================================================================");
    console.log("Test completed.");
 console.log(` : ${finalAcc}%`);
    console.log("================================================================");
    
    fs.appendFileSync(summaryFile, `\nTOTAL AVERAGE: ${finalAcc}%`);
}

main();



