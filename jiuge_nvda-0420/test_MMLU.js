// 业务逻辑处理
const testName = [
    // stem
    "abstract_algebra",
    "anatomy",
    "astronomy",
    "college_biology",
    "college_chemistry",
    "college_computer_science",
    "college_mathematics",
    "college_physics",
    "computer_security",
    "conceptual_physics",
    "electrical_engineering",
    "elementary_mathematics",
    "high_school_biology",
    "high_school_chemistry",
    "high_school_computer_science",
    "high_school_mathematics",
    "high_school_physics",
    "high_school_statistics",
    "machine_learning",
    // Humanities
    "formal_logic",
    "high_school_european_history",
    "high_school_us_history",
    "high_school_world_history",
    "international_law",
    "jurisprudence",
    "logical_fallacies",
    "moral_disputes",
    "moral_scenarios",
    "philosophy",
    "prehistory",
    "professional_law",
    "world_religions",
    // other
    "business_ethics",
    "college_medicine",
    "human_aging",
    "management",
    "marketing",
    "medical_genetics",
    "miscellaneous",
    "nutrition",
    "professional_accounting",
    "professional_medicine",
    "virology",
    "global_facts",
    "clinical_knowledge",
    // social
    "econometrics",
    "high_school_geography",
    "high_school_government_and_politics",
    "high_school_macroeconomics",
    "high_school_microeconomics",
    "high_school_psychology",
    "human_sexuality",
    "professional_psychology",
    "public_relations",
    "security_studies",
    "sociology",
    "us_foreign_policy",
];

const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

// 函数：getGpuStats
function getGpuStats() {
    return new Promise((resolve, reject) => {
        exec(
            "nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.free,memory.used --format=csv,noheader,nounits",
            (err, stdout, stderr) => {
                if (err) {
                    reject(`Error executing nvidia-smi: ${stderr}`);
                    return;
                }
                const stats = stdout.trim().split(", ").map(v => parseInt(v, 10));
                resolve({
                    gpuUtilization: stats[0], // %
                    memoryTotal: stats[1],    // MiB
                    memoryFree: stats[2],     // MiB
                    memoryUsed: stats[3],     // MiB
                });
            }
        );
    });
}

// 调用模型并获取回答
async function ask(prompt) {
    const t0 = Date.now();
    const res = await fetch("http://127.0.0.1:1145/completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, n_predict: 10240 })
    });
    const { content } = await res.json();
    const t1 = Date.now();
    return { content, inferenceTime: (t1 - t0) / 1000 }; // 处理ask相关逻辑
}

// 函数：detailedQuestion
function detailedQuestion(str) {
    let data = ["", "", "", "", "", ""];
    let i = 0, quote = false;
    for (const ch of str) {
        if (ch === '"' ) { quote = !quote; continue; }
        if (ch === "," && !quote) { i++; continue; }
        data[i] += ch;
    }
    return {
        question:
            data[0] +
            "\nA. " + data[1] +
            "\nB. " + data[2] +
            "\nC. " + data[3] +
            "\nD. " + data[4] +
            "\nThe answer should be A, B, C, or D" +
            "\nUse \"boxed{}\" to mark the answer\n",
        answer: data[5]
    };
}

// 从文本中提取标准答案
function extractAnswer(str) {
    const m = str.match(/boxed\{[A-D]\}/);
    return m ? m[0].match(/[A-D]/)[0] : "invalid";
}

// 主流程：逐题推理并统计指标
async function main() {
    for (const tn of testName) {
        const csv = fs.readFileSync(path.join(__dirname, "..", "data_sets", "MMLU", `${tn}_test.csv`), "utf-8");
        const lines = csv.split("\n").filter(l => l.trim().length);
        const resFile = `./result/mmlu_${tn}_res.jsonl`;
        fs.writeFileSync(resFile, "");

        let count = 0,
            total = lines.length,
            totalTime = 0;

        for (let idx = 0; idx < total; idx++) {
            const { question, answer: expect } = detailedQuestion(lines[idx]);
// 处理main相关逻辑
            const { content: output, inferenceTime } = await ask(question);
            totalTime += inferenceTime;
            const inferenceTimeMs = (inferenceTime * 1000).toFixed(2);

// 提取最终答案文本
            const answer = extractAnswer(output);
            const correct = answer === expect;
            if (correct) count++;

// 处理main相关逻辑
            const gpu = await getGpuStats();

// 追加写入本题结果
            fs.appendFileSync(
                resFile,
                JSON.stringify({
                    output,
                    answer,
                    expect,
                    correct,
                    inferenceTime: `${inferenceTimeMs} ms`,
                    gpuUtilization: `${gpu.gpuUtilization}%`,
                    memoryTotal: `${gpu.memoryTotal} MB`,
                    memoryUsed: `${gpu.memoryUsed} MB`,
                    memoryFree: `${gpu.memoryFree} MB`
                }) + "\n"
            );

// 处理main相关逻辑
            const pct = ((idx + 1) / total * 100).toFixed(2);
            const acc = ((count / (idx + 1)) * 100).toFixed(2);
            const avgMs = ((totalTime / (idx + 1)) * 1000).toFixed(2);
            process.stdout.write(
                `\r[${tn}] ${idx + 1}/${total} ${pct}% ` +
                `acc=${acc}% avgTime=${avgMs} ms ` +
                `GPU=${gpu.gpuUtilization}% Mem=${gpu.memoryUsed}/${gpu.memoryTotal}MB`
            );
        }
        console.log();

// 处理main相关逻辑
        const avgTime = (totalTime / total) * 1000;
        const finalGpu = await getGpuStats();
        fs.appendFileSync(
            resFile,
            JSON.stringify({
                result: `${(count / total * 100).toFixed(2)}%`,
                avgInferenceTime: `${avgTime.toFixed(2)} ms`,
                gpuUtilization: `${finalGpu.gpuUtilization}%`,
                memoryTotal: `${finalGpu.memoryTotal} MB`,
                memoryUsed: `${finalGpu.memoryUsed} MB`,
                memoryFree: `${finalGpu.memoryFree} MB`
            }) + "\n"
        );
    }
}

main();



