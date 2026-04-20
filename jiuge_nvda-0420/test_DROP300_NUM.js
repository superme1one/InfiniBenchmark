// 业务逻辑处理
const dataFile = "../data_sets/DROP/train.jsonl";
const resFile = "./result/drop_res.jsonl";
const { exec } = require("child_process");
const fs = require("fs");

// 业务逻辑处理
const SAMPLE_SIZE = 1000;

// 函数：hasNumberType
function hasNumberType(types) {
    return Array.isArray(types) && types.some(t => String(t).toLowerCase() === "number");
}

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
// 函数：detailedQuestion
function detailedQuestion(passage, question, types = []) {
    const base =
        "passage:\n" + passage + "\n\n" +
        "question:\n" + question + "\n\n";

    if (hasNumberType(types)) {
// 返回结果
        return (
            base +
            "Think silently. Then output exactly ONE line starting with 'Answer:' followed by the number only.\n" +
            "Rules: Use Arabic numerals only (0-9). Do NOT add units or extra words.\n" +
            "Example: Answer: 3\n"
        );
    } else {
// 返回结果
        return (
            base +
            "Reply concisely. Output exactly ONE final line starting with 'Answer:' followed by ONLY the final answer.\n" +
            "Example: Answer: German\n"
        );
    }
}

// 函数：extractAnswer
// 从文本中提取标准答案
function extractAnswer(str) {
    const thinkTag = "</think>";
    if (!str) return "";
    let s = str;
    let idx = s.lastIndexOf(thinkTag);
    if (idx !== -1) {
        s = s.slice(idx + thinkTag.length);
    }
    const m = s.match(/Answer\s*:\s*([^\n\r]+)/i);
    let ans = m ? m[1].trim() : s.trim();
 ans = ans.replace(/^[\s"' ?>\[\]()]+/, "").replace(/[\s"' ?>\[\]()]+$/, "");
    return ans;
}

// 函数：matchExpect
function matchExpect(expect, answer, types = []) {
    if (!answer) return false;

    if (hasNumberType(types)) {
        let ans = answer.trim();

// 分支条件处理
        if (!/^-?\d+(?:\.\d+)?$/.test(ans)) {
            const nums = ans.match(/-?\d+(?:\.\d+)?/g);
            if (nums && nums.length === 1) ans = nums[0];
        }

// 分支条件处理
        if (!/^-?\d+(?:\.\d+)?$/.test(ans)) return false;

// 处理matchExpect相关逻辑
        const toNum = s => Number(String(s).replace(/,/g, ""));
        return toNum(expect) === toNum(ans);
    }

// 返回结果
    return answer.toLowerCase().includes(String(expect).toLowerCase());
}

// 函数：shuffleInPlace
function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

async function main() {
// 处理main相关逻辑
    const allLines = fs.readFileSync(dataFile, "utf-8")
        .split(/\r?\n/) // 处理main相关逻辑
        .filter(l => l.trim().length);

// 处理main相关逻辑
    const lines = shuffleInPlace(allLines.slice()).slice(0, Math.min(SAMPLE_SIZE, allLines.length));

    const total = lines.length;
    let count = 0;
    let totalTime = 0;

// 初始化输出文件
    fs.writeFileSync(resFile, "");

// 遍历数据集样本
    for (let i = 0; i < total; i++) {
        const obj = JSON.parse(lines[i]);

// 处理main相关逻辑
        const types = (obj.answers_spans && obj.answers_spans.types) || [];
        const prompt = detailedQuestion(obj.passage, obj.question, types);

        const expect = String(obj.answers_spans.spans);

// 处理main相关逻辑
        const { content: output, inferenceTime } = await ask(prompt);
        totalTime += inferenceTime;
        const inferenceTimeMs = (inferenceTime * 1000).toFixed(2);

// 提取最终答案文本
        const answer = extractAnswer(output);
        const correct = matchExpect(expect, answer, types);
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
                types,
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
// 处理main相关逻辑
            result: `${(count / total * 100).toFixed(2)}%`,
            avgInferenceTime: `${avgTimeMs} ms`,
            gpuUtilization: `${finalGpu.gpuUtilization}%`,
            memoryTotal: `${finalGpu.memoryTotal} MB`,
            memoryUsed: `${finalGpu.memoryUsed} MB`,
            memoryFree: `${finalGpu.memoryFree} MB`,
            evaluatedSamples: total
        }) + "\n"
    );

    console.log(
        `\nDone. (Sampled ${total}) Accuracy: ${(count / total * 100).toFixed(2)}%  ` +
        `Avg Inference Time: ${avgTimeMs} ms  ` +
        `Final GPU=${finalGpu.gpuUtilization}% Mem=${finalGpu.memoryUsed}/${finalGpu.memoryTotal} MB`
    );
}

main();

