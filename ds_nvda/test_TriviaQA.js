// validate_triviaqa.js

const dataFile = "./TriviaQA/verified-web-dev.json";
const resFile = "./result/triviaqa_res.jsonl";
const { exec } = require("child_process");

// 获取 GPU 利用率和显存使用情况
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

// 向模型服务发送请求并测量推理时间，加入 stop 控制
async function ask(prompt) {
    const t0 = Date.now();
    const res = await fetch("http://127.0.0.1:1145/completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            prompt,
            n_predict: 10240,
            stop: ["</think>"]       // 输出到 </think> 即停止
        })
    });
    const { content } = await res.json();
    const t1 = Date.now();
    const inferenceTime = (t1 - t0) / 1000;  // 秒
    return { content, inferenceTime };
}

// 从模型输出中提取 </think> 之后的答案
function extractAnswer(str) {
    const tag = "</think>";
    const idx = str.lastIndexOf(tag);
    return idx >= 0 ? str.slice(idx + tag.length).trim() : str.trim();
}

// 判断模型答案是否包含任何期望别名
function matchExpect(expectList, answer) {
    if (!answer) return false;
    const ans = answer.toLowerCase();
    return expectList.some(alias => ans.includes(alias.toLowerCase()));
}

async function main() {
    const fs = require("fs");
    // 1. 清空结果文件
    fs.writeFileSync(resFile, "");

    // 2. 读取测试集
    const raw = fs.readFileSync(dataFile, "utf-8");
    const data = JSON.parse(raw).Data;
    const total = data.length;

    let count = 0;
    let totalInferenceTime = 0;

    for (let i = 0; i < total; i++) {
        const { Question, Answer } = data[i];
        const expectList = Answer.NormalizedAliases;

        // 3. 调用模型，获取输出和推理时长
        const { content: output, inferenceTime } = await ask(Question);
        totalInferenceTime += inferenceTime;
        const inferenceTimeMs = (inferenceTime * 1000).toFixed(2);

        // 4. 提取答案并判断是否正确
        const answer = extractAnswer(output);
        const correct = matchExpect(expectList, answer);
        if (correct) count++;

        // 5. 获取 GPU/显存状态
        const gpuStats = await getGpuStats();

        // 6. 写入每条记录（带单位）
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

        // 7. 控制台实时输出
        const pct = ((i + 1) / total * 100).toFixed(2);
        const acc = ((count / (i + 1)) * 100).toFixed(2);
        const avgMs = ((totalInferenceTime / (i + 1)) * 1000).toFixed(2);
        process.stdout.write(
            `\r[${i + 1}/${total}] ${pct}%  acc=${acc}%  avgTime=${avgMs} ms  ` +
            `GPU=${gpuStats.gpuUtilization}%  Mem=${gpuStats.memoryUsed}/${gpuStats.memoryTotal} MB`
        );
    }

    // 8. 写入 summary（带单位）
    const avgInferenceTime = totalInferenceTime / total;       // 秒
    const avgMs = (avgInferenceTime * 1000).toFixed(2);        // 毫秒
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
