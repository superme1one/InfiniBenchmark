// validate_drop.js

const dataFile = "./DROP/train.jsonl";
const resFile = "./result/drop_res.jsonl";
const { exec } = require("child_process");
const fs = require("fs");

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

// 向模型服务发送请求并测量推理时间
async function ask(prompt) {
    const t0 = Date.now();
    const res = await fetch("http://127.0.0.1:1145/completion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, n_predict: 10240 })
    });
    const { content } = await res.json();
    const t1 = Date.now();
    return { content, inferenceTime: (t1 - t0) / 1000 }; // 秒
}

// 构造 DROP 格式的 prompt
function detailedQuestion(passage, question) {
    return (
        "passage:\n" +
        passage + "\n\n" +
        "question:\n" +
        question + "\n\n" +
        "Please use Arabic numerals if number is needed\n"
    );
}

// 从模型输出中提取 </think> 之后，再按 “Answer” 标签截取
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

// 检查答案是否包含期望文本（不区分大小写）
function matchExpect(expect, answer) {
    if (!answer) return false;
    return answer.toLowerCase().includes(expect.toLowerCase());
}

async function main() {
    // 1. 读取所有行并初始化
    const lines = fs.readFileSync(dataFile, "utf-8")
        .split("\r\n")
        .filter(l => l.trim().length);
    const total = lines.length;
    let count = 0;
    let totalTime = 0;

    // 2. 清空输出文件
    fs.writeFileSync(resFile, "");

    // 3. 逐条测试
    for (let i = 0; i < total; i++) {
        const obj = JSON.parse(lines[i]);
        const prompt = detailedQuestion(obj.passage, obj.question);
        const expect = String(obj.answers_spans.spans);

        // 调用模型并计时
        const { content: output, inferenceTime } = await ask(prompt);
        totalTime += inferenceTime;
        const inferenceTimeMs = (inferenceTime * 1000).toFixed(2);

        // 提取答案并判断
        const answer = extractAnswer(output);
        const correct = matchExpect(expect, answer);
        if (correct) count++;

        // 获取 GPU 状态
        const gpu = await getGpuStats();

        // 写入每条记录（带单位）
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

        // 控制台实时输出
        const pct = ((i + 1) / total * 100).toFixed(2);
        const acc = ((count / (i + 1)) * 100).toFixed(2);
        const avgMs = ((totalTime / (i + 1)) * 1000).toFixed(2);
        process.stdout.write(
            `\r[${i+1}/${total}] ${pct}%  acc=${acc}%  avgTime=${avgMs} ms  ` +
            `GPU=${gpu.gpuUtilization}%  Mem=${gpu.memoryUsed}/${gpu.memoryTotal} MB`
        );
    }
    console.log();

    // 4. 写入 summary（带单位）
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
