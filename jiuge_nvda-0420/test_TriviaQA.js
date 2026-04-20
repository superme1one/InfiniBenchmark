// 业务逻辑处理
const dataFile = "../data_sets/TriviaQA/verified-web-dev.json";
const resFile = "./result/triviaqa_res.jsonl";
const { exec } = require("child_process");

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
                const stats = stdout
                    .trim()
                    .split(", ")
                    .map(val => parseInt(val, 10));
                resolve({
                    gpuUtilization: stats[0],  // %
                    memoryTotal: stats[1],     // MiB
                    memoryFree: stats[2],      // MiB
                    memoryUsed: stats[3],      // MiB
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
        body: JSON.stringify({
            prompt,
            n_predict: 10240,
            stop: ["</think>"] // 处理ask相关逻辑
        })
    });
    const { content } = await res.json();
    const t1 = Date.now();
    const inferenceTime = (t1 - t0) / 1000; // 返回结果
    return { content, inferenceTime };
}

// 从文本中提取标准答案
function extractAnswer(str) {
    const tag = "</think>";
    const idx = str.lastIndexOf(tag);
    return idx >= 0 ? str.slice(idx + tag.length).trim() : str.trim();
}

// 函数：matchExpect
function matchExpect(expectList, answer) {
    if (!answer) return false;
    const ans = answer.toLowerCase();
    return expectList.some(alias => ans.includes(alias.toLowerCase()));
}

async function main() {
    const fs = require("fs");
// 初始化输出文件
    fs.writeFileSync(resFile, "");

// 处理main相关逻辑
    const raw = fs.readFileSync(dataFile, "utf-8");
    const data = JSON.parse(raw).Data;
    const total = data.length;

    let count = 0;
    let totalInferenceTime = 0;

    for (let i = 0; i < total; i++) {
        const { Question, Answer } = data[i];
        const expectList = Answer.NormalizedAliases;

// 处理main相关逻辑
        const { content: output, inferenceTime } = await ask(Question);
        totalInferenceTime += inferenceTime;
        const inferenceTimeMs = (inferenceTime * 1000).toFixed(2);

// 提取最终答案文本
        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) count++;

// 处理main相关逻辑
        const gpuStats = await getGpuStats();

// 追加写入本题结果
        fs.appendFileSync(
            resFile,
            JSON.stringify({
                question: Question,
                answer: answer,
                expect: expectList,
                correct: correct,
                inferenceTime: `${inferenceTimeMs} ms`,
                gpuUtilization: `${gpuStats.gpuUtilization}%`,
                memoryTotal: `${gpuStats.memoryTotal} MB`,
                memoryUsed: `${gpuStats.memoryUsed} MB`,
                memoryFree: `${gpuStats.memoryFree} MB`
            }) + "\n"
        );

// 处理main相关逻辑
        const pct = ((i + 1) / total * 100).toFixed(2);
        const acc = ((count / (i + 1)) * 100).toFixed(2);
        const avgMs = ((totalInferenceTime / (i + 1)) * 1000).toFixed(2);
        process.stdout.write(
            `\r[${i + 1}/${total}] ${pct}%  acc=${acc}%  avgTime=${avgMs} ms  ` +
            `GPU=${gpuStats.gpuUtilization}%  Mem=${gpuStats.memoryUsed}/${gpuStats.memoryTotal} MB`
        );
    }

// 处理main相关逻辑
    const avgInferenceTime = totalInferenceTime / total; // 处理main相关逻辑
    const avgMs = (avgInferenceTime * 1000).toFixed(2); // 处理main相关逻辑
    const finalGpu = await getGpuStats();

    fs.appendFileSync(
        resFile,
        JSON.stringify({
            result: `${(count / total * 100).toFixed(2)}%`,
            avgInferenceTime: `${avgMs} ms`,
            gpuUtilization: `${finalGpu.gpuUtilization}%`,
            memoryTotal: `${finalGpu.memoryTotal} MB`,
            memoryUsed: `${finalGpu.memoryUsed} MB`,
            memoryFree: `${finalGpu.memoryFree} MB`
        }) + "\n"
    );

    console.log(
        `\nDone. Accuracy: ${(count / total * 100).toFixed(2)}%  ` +
        `Avg Inference Time: ${avgMs} ms  ` +
        `Final GPU=${finalGpu.gpuUtilization}% Mem=${finalGpu.memoryUsed}/${finalGpu.memoryTotal} MB`
    );
}

main();

