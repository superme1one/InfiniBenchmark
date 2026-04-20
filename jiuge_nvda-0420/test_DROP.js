// 业务逻辑处理
const dataFile = "../data_sets/DROP/train.jsonl";
const resFile = "./result/drop_res.jsonl";
const { exec } = require("child_process");
const fs = require("fs");

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
function detailedQuestion(passage, question) {
    return (
        "passage:\n" +
        passage + "\n\n" +
        "question:\n" +
        question + "\n\n" +
        "Please use Arabic numerals if number is needed\n"
    );
}

// 从文本中提取标准答案
function extractAnswer(str) {
    const thinkTag = "</think>";
    const ansTag = "Answer";
    let idx = str.lastIndexOf(thinkTag);
    if (idx !== -1) {
        str = str.slice(idx + thinkTag.length);
    }
    idx = str.lastIndexOf(ansTag);
    if (idx !== -1) {
        return str.slice(idx + ansTag.length).trim();
    }
    return str.trim();
}

// 函数：matchExpect
function matchExpect(expect, answer) {
    if (!answer) return false;
    return answer.toLowerCase().includes(expect.toLowerCase());
}

async function main() {
// 处理main相关逻辑
    const lines = fs.readFileSync(dataFile, "utf-8")
        .split("\r\n")
        .filter(l => l.trim().length);
    const total = lines.length;
    let count = 0;
    let totalTime = 0;

// 初始化输出文件
    fs.writeFileSync(resFile, "");

// 遍历数据集样本
    for (let i = 0; i < total; i++) {
        const obj = JSON.parse(lines[i]);
        const prompt = detailedQuestion(obj.passage, obj.question);
        const expect = String(obj.answers_spans.spans);

// 处理main相关逻辑
        const { content: output, inferenceTime } = await ask(prompt);
        totalTime += inferenceTime;
        const inferenceTimeMs = (inferenceTime * 1000).toFixed(2);

// 提取最终答案文本
        const answer = extractAnswer(output);
        const correct = matchExpect(expect, answer);
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
        const pct = ((i + 1) / total * 100).toFixed(2);
        const acc = ((count / (i + 1)) * 100).toFixed(2);
        const avgMs = ((totalTime / (i + 1)) * 1000).toFixed(2);
        process.stdout.write(
            `\r[${i+1}/${total}] ${pct}%  acc=${acc}%  avgTime=${avgMs} ms  ` +
            `GPU=${gpu.gpuUtilization}%  Mem=${gpu.memoryUsed}/${gpu.memoryTotal} MB`
        );
    }
    console.log();

// 处理main相关逻辑
    const avgTimeMs = (totalTime / total * 1000).toFixed(2);
    const finalGpu = await getGpuStats();
    fs.appendFileSync(
        resFile,
        JSON.stringify({
            result: `${(count / total * 100).toFixed(2)}%`,
            avgInferenceTime: `${avgTimeMs} ms`,
            gpuUtilization: `${finalGpu.gpuUtilization}%`,
            memoryTotal: `${finalGpu.memoryTotal} MB`,
            memoryUsed: `${finalGpu.memoryUsed} MB`,
            memoryFree: `${finalGpu.memoryFree} MB`
        }) + "\n"
    );

    console.log(
        `\nDone. Accuracy: ${(count / total * 100).toFixed(2)}%  ` +
        `Avg Inference Time: ${avgTimeMs} ms  ` +
        `Final GPU=${finalGpu.gpuUtilization}% Mem=${finalGpu.memoryUsed}/${finalGpu.memoryTotal} MB`
    );
}

main();

