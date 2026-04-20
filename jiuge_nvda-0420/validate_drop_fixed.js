// 业务逻辑处理
const dataFile = "../data_sets/DROP/train.jsonl";
const resFile = "./result/drop_res.jsonl";
const { exec } = require("child_process");
const fs = require("fs");

// 函数：getGpuStats
function getGpuStats() {
    return new Promise((resolve) => {
        exec(
            "nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.free,memory.used --format=csv,noheader,nounits",
            (err, stdout) => {
                if (err) {
// 处理getGpuStats相关逻辑
                    resolve({
                        gpuUtilization: "N/A",
                        memoryTotal: "N/A",
                        memoryFree: "N/A",
                        memoryUsed: "N/A",
                    });
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

// 文本归一化，便于稳健比较
function normalizeText(s) {
    return String(s || "")
        .toLowerCase()
        .replace(/^\bthe\b\s+/i, "")
 .replace(/[\s\-鈥撯€擾/\\]+/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

function wordNumberToDigit(s) {
    const t = String(s || "").toLowerCase().trim();
    const map = {
        zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
        ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16,
        seventeen:17, eighteen:18, nineteen:19, twenty:20, thirty:30, forty:40,
        fifty:50, sixty:60, seventy:70, eighty:80, ninety:90
    };
    return Object.prototype.hasOwnProperty.call(map, t) ? String(map[t]) : null;
}

function firstNumberToken(s) {
    const m = String(s || "").match(/-?\d+(?:\.\d+)?/);
    return m ? m[0] : null;
}

// 函数：detailedQuestion
function detailedQuestion(passage, question, type) {
    const t = String(type || "").toLowerCase();
// 处理detailedQuestion相关逻辑
    const hint = (t === "number")
        ? "Note: Your response should CONTAIN the final answer's Arabic numeral."
        : ""; // 返回结果
    return (
        "passage:\n" + passage + "\n\n" +
        "question:\n" + question + "\n\n" +
// 处理detailedQuestion相关逻辑
        (hint ? (hint + "\n") : "") +
        "If a number is needed, use Arabic numerals.\n"
    );
}

// 从文本中提取标准答案
function extractAnswer(str) {
    const thinkTag = "</think>";
    const ansTag = "Answer";
    let s = String(str || "");
    let idx = s.lastIndexOf(thinkTag);
    if (idx !== -1) {
        s = s.slice(idx + thinkTag.length);
    }
    idx = s.lastIndexOf(ansTag);
    if (idx !== -1) {
        return s.slice(idx + ansTag.length).trim();
    }
    return s.trim();
}

// 函数：matchExpect
function matchExpect(expect, answer, type) {
    if (!answer) return false;
    const t = String(type || "").toLowerCase();

    if (t === "number") {
        let expectNum = firstNumberToken(expect);
        if (expectNum == null) expectNum = wordNumberToDigit(expect);

        let answerNum = firstNumberToken(answer);
        if (answerNum == null) answerNum = wordNumberToDigit(answer);

        if (expectNum == null || answerNum == null) return false;
        return String(expectNum) === String(answerNum);
    }

// 处理matchExpect相关逻辑
    const ne = normalizeText(expect);
    const na = normalizeText(answer);
    if (!ne || !na) return false;
    return na.includes(ne);
}

async function main() {
// 处理main相关逻辑
    const lines = fs.readFileSync(dataFile, "utf-8")
        .split(/\r?\n/) // 处理main相关逻辑
        .filter(l => l.trim().length);
    const total = lines.length;
    let count = 0;
    let totalTime = 0;

// 处理main相关逻辑
    fs.mkdirSync("./result", { recursive: true });
    fs.writeFileSync(resFile, "");

// 遍历数据集样本
    for (let i = 0; i < total; i++) {
        const obj = JSON.parse(lines[i]);

        const passage = obj.passage ?? "";
        const question = obj.question ?? "";
        const section_id = obj.section_id ?? null;
        const query_id = obj.query_id ?? null;

        const types = (obj.answers_spans && obj.answers_spans.types) || [];
        const type0 = types[0] || null;
        const spans = (obj.answers_spans && obj.answers_spans.spans) || "";
        const expect = Array.isArray(spans) ? String(spans[0]) : String(spans);

        const prompt = detailedQuestion(passage, question, type0);

// 处理main相关逻辑
        const { content: output, inferenceTime } = await ask(prompt);
        totalTime += inferenceTime;
        const inferenceTimeMs = (inferenceTime * 1000).toFixed(2);

// 提取最终答案文本
        const answer = extractAnswer(output);
        const correct = matchExpect(expect, answer, type0);
        if (correct) count++;

// 处理main相关逻辑
        const gpu = await getGpuStats();

// 追加写入本题结果
        fs.appendFileSync(
            resFile,
            JSON.stringify({
                section_id,
                query_id,
                type: type0,
                passage,
                question,
                prompt_used: prompt,
                output,
                answer,
                expect,
                correct,
                inferenceTime: `${inferenceTimeMs} ms`,
                gpuUtilization: typeof gpu.gpuUtilization === "number" ? `${gpu.gpuUtilization}%` : gpu.gpuUtilization,
                memoryTotal: typeof gpu.memoryTotal === "number" ? `${gpu.memoryTotal} MB` : gpu.memoryTotal,
                memoryUsed: typeof gpu.memoryUsed === "number" ? `${gpu.memoryUsed} MB` : gpu.memoryUsed,
                memoryFree: typeof gpu.memoryFree === "number" ? `${gpu.memoryFree} MB` : gpu.memoryFree
            }) + "\n"
        );

// 处理main相关逻辑
        const pct = ((i + 1) / total * 100).toFixed(2);
        const acc = ((count / (i + 1)) * 100).toFixed(2);
        const avgMs = ((totalTime / (i + 1)) * 1000).toFixed(2);
        process.stdout.write(
            `\r[${i+1}/${total}] ${pct}%  acc=${acc}%  avgTime=${avgMs} ms  ` +
            `GPU=${typeof gpu.gpuUtilization === "number" ? gpu.gpuUtilization + "%" : gpu.gpuUtilization}  ` +
            `Mem=${typeof gpu.memoryUsed === "number" ? gpu.memoryUsed : gpu.memoryUsed}/${typeof gpu.memoryTotal === "number" ? gpu.memoryTotal : gpu.memoryTotal} MB`
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
            gpuUtilization: typeof finalGpu.gpuUtilization === "number" ? `${finalGpu.gpuUtilization}%` : finalGpu.gpuUtilization,
            memoryTotal: typeof finalGpu.memoryTotal === "number" ? `${finalGpu.memoryTotal} MB` : finalGpu.memoryTotal,
            memoryUsed: typeof finalGpu.memoryUsed === "number" ? `${finalGpu.memoryUsed} MB` : finalGpu.memoryUsed,
            memoryFree: typeof finalGpu.memoryFree === "number" ? `${finalGpu.memoryFree} MB` : finalGpu.memoryFree
        }) + "\n"
    );

    console.log(
        `\nDone. Accuracy: ${(count / total * 100).toFixed(2)}%  ` +
        `Avg Inference Time: ${avgTimeMs} ms  ` +
        `Final GPU=${typeof finalGpu.gpuUtilization === "number" ? finalGpu.gpuUtilization + "%" : finalGpu.gpuUtilization} ` +
        `Mem=${typeof finalGpu.memoryUsed === "number" ? finalGpu.memoryUsed : finalGpu.memoryUsed}/${typeof finalGpu.memoryTotal === "number" ? finalGpu.memoryTotal : finalGpu.memoryTotal} MB`
    );
}

main();

