const fs = require("fs");
const path = require("path");
const {
    DEFAULT_CONFIG,
    appendJsonl,
    askModel,
    buildSummaryPayload,
    createStatsTracker,
    ensureDir,
    formatMs,
    getDatasetPath,
    getGpuStats,
    sleep,
    startGpuMonitor,
    updateStatsTracker,
    writeAllTestSummary,
} = require("./common_v1");

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
    "sociology", "us_foreign_policy", "virology", "world_religions",
];

const LIMIT_PER_SUBJECT = Number(process.env.MMLU_LIMIT_PER_SUBJECT || 0);
const SUBJECT_FILTER = new Set(
    String(process.env.MMLU_SUBJECTS || "")
        .split(",")
        .map(item => item.trim())
        .filter(Boolean)
);
const RESULT_DIR = DEFAULT_CONFIG.resultDir;
const MMLU_MAX_TOKENS = Number(process.env.MMLU_MAX_TOKENS || 4096);
const MMLU_TEMPERATURE = Number(process.env.MMLU_TEMPERATURE || 0.1);

function parseCsvRecords(text) {
    const rows = [];
    let row = [];
    let current = "";
    let inQuotes = false;

    const pushField = () => {
        row.push(current);
        current = "";
    };

    const pushRow = () => {
        if (row.length === 0) return;
        if (row.length === 1 && !String(row[0] || "").trim()) {
            row = [];
            return;
        }
        rows.push(row);
        row = [];
    };

    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const next = text[i + 1];

        if (char === "\"") {
            if (inQuotes && next === "\"") {
                current += "\"";
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === "," && !inQuotes) {
            pushField();
            continue;
        }

        if ((char === "\n" || char === "\r") && !inQuotes) {
            pushField();
            pushRow();
            if (char === "\r" && next === "\n") {
                i++;
            }
            continue;
        }

        current += char;
    }

    if (current.length > 0 || row.length > 0) {
        pushField();
        pushRow();
    }

    return rows
        .map(fields => fields.map(field => String(field || "").trim()))
        .filter(fields => fields.length >= 6)
        .map(fields => ({
            question: fields[0],
            choices: fields.slice(1, 5),
            answer: fields[5].toUpperCase(),
        }))
        .filter(item =>
            item.question &&
            item.choices.length === 4 &&
            item.choices.every(Boolean) &&
            /^[A-D]$/.test(item.answer)
        );
}

function buildPrompt(item, subject) {
    const subjectLabel = subject.replace(/_/g, " ");
    return `
You are an expert in ${subjectLabel}.

Question:
${item.question}
A) ${item.choices[0]}
B) ${item.choices[1]}
C) ${item.choices[2]}
D) ${item.choices[3]}

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
`.trim();
}

function cleanModelOutput(rawOutput) {
    if (!rawOutput) return "";

    return String(rawOutput)
        .replace(/\u0000/g, "")
        .replace(/<\|im_end\|>/gi, "")
        .replace(/<\|endoftext\|>/gi, "")
        .trim();
}

function extractChoice(output) {
    const cleaned = cleanModelOutput(output);
    if (!cleaned) return "INVALID";

    let cleanText = cleaned;
    const thinkEndParts = cleaned.split("</think>");
    if (thinkEndParts.length > 1) {
        const tail = thinkEndParts[thinkEndParts.length - 1].trim();
        cleanText = tail || cleaned;
    } else if (cleaned.includes("<think>") && !cleaned.includes("</think>")) {
        cleanText = cleaned;
    }

    const patterns = [
        /Answer\s*:\s*([A-D])\b/i,
        /The answer is\s*([A-D])\b/i,
        /The correct option is\s*([A-D])\b/i,
        /boxed\{([A-D])\}/i,
        /^([A-D])$/m,
        /Option\s*([A-D])\b/i,
    ];

    for (const pattern of patterns) {
        const match = cleanText.match(pattern);
        if (match) {
            return match[1].toUpperCase();
        }
    }

    const lastWindow = cleanText.slice(-100);
    const loose = lastWindow.match(/(?:is|select|option)\s+([A-D])\W*$/i);
    if (loose) return loose[1].toUpperCase();

    if (cleaned.includes("<think>") && !cleaned.includes("</think>")) {
        return "TRUNCATED";
    }

    return "INVALID";
}

function logProgress(subject, localIndex, localTotal, tracker, prediction, expected, inferenceTimeMs, endpoint, error, gpu) {
    const acc = tracker.processed <= 0 ? 0 : (tracker.correct / tracker.processed) * 100;
    const avgMs = tracker.processed <= 0 ? 0 : tracker.totalInferenceTimeMs / tracker.processed;
    const status = error ? "ERROR" : prediction === expected ? "OK" : "FAIL";
    const endpointText = endpoint ? endpoint.replace("http://", "") : "-";
    const gpuText = gpu
        ? ` gpu=${gpu.gpuUtilization}% mem=${gpu.memoryUsedMB}/${gpu.memoryTotalMB}MB`
        : "";
    console.log(
        `[MMLU_V1][${subject}] ${localIndex}/${localTotal} ${status} ` +
        `acc=${acc.toFixed(2)}% pred=${prediction} gold=${expected} ` +
        `time=${formatMs(inferenceTimeMs)} avg=${formatMs(avgMs)} endpoint=${endpointText}${gpuText}${error ? ` error=${error}` : ""}`
    );
}

async function main() {
    ensureDir(RESULT_DIR);
    const summaryPath = path.join(RESULT_DIR, "mmlu_v1_summary.txt");
    fs.writeFileSync(summaryPath, "", "utf-8");

    const subjectData = [];
    for (const subject of SUBJECTS) {
        if (SUBJECT_FILTER.size > 0 && !SUBJECT_FILTER.has(subject)) {
            continue;
        }
        const datasetPath = getDatasetPath("MMLU", `${subject}_test.csv`);
        if (!fs.existsSync(datasetPath)) continue;
        let items = parseCsvRecords(fs.readFileSync(datasetPath, "utf-8"));
        if (LIMIT_PER_SUBJECT > 0) {
            items = items.slice(0, LIMIT_PER_SUBJECT);
        }
        subjectData.push({ subject, items });
    }

    const totalQuestions = subjectData.reduce((sum, item) => sum + item.items.length, 0);
    const tracker = createStatsTracker("MMLU_V1", totalQuestions);
    const gpuMonitor = startGpuMonitor(tracker);
    let stopping = false;

    const flushSummary = async status => {
        const gpu = await getGpuStats();
        if (gpu) tracker.lastGpu = gpu;
        writeAllTestSummary("MMLU_V1", buildSummaryPayload(tracker, status));
    };

    process.on("SIGINT", async () => {
        if (stopping) return;
        stopping = true;
        console.log("\n[MMLU_V1] interrupted, writing summary...");
        await gpuMonitor.stop();
        await flushSummary("interrupted");
        process.exit(130);
    });

    for (const { subject, items } of subjectData) {
        const resultPath = path.join(RESULT_DIR, `mmlu_${subject}_v1.jsonl`);
        fs.writeFileSync(resultPath, "", "utf-8");

        let subjectCorrect = 0;

        for (let index = 0; index < items.length; index++) {
            const item = items[index];

            process.stdout.write(`\r[MMLU_V1][${subject}] ${index + 1}/${items.length}`);

            let output = "";
            let error = null;
            let inferenceTimeMs = 0;
            let endpoint = "";

            try {
                const result = await askModel(buildPrompt(item, subject), {
                    maxTokens: MMLU_MAX_TOKENS,
                    temperature: MMLU_TEMPERATURE,
                });
                output = result.output;
                inferenceTimeMs = result.inferenceTimeMs;
                endpoint = result.endpoint;
            } catch (err) {
                error = err.message;
            }

            const prediction = error ? "ERROR" : extractChoice(output, item.choices);
            const correct = prediction === item.answer;
            if (correct) subjectCorrect++;

            const gpu = await getGpuStats();
            updateStatsTracker(tracker, {
                correct,
                error,
                inferenceTimeMs,
                gpu,
            });

            appendJsonl(resultPath, {
                id: index + 1,
                subject,
                question: item.question,
                choices: item.choices,
                prediction,
                expected: item.answer,
                correct,
                inferenceTimeMs,
                endpoint,
                gpu,
                error,
                output,
            });

            await flushSummary("running");
            logProgress(subject, index + 1, items.length, tracker, prediction, item.answer, inferenceTimeMs, endpoint, error, gpu);

            if (DEFAULT_CONFIG.cooldownMs > 0 && index < items.length - 1) {
                await sleep(DEFAULT_CONFIG.cooldownMs);
            }
        }

        const subjectAcc = items.length === 0 ? 0 : (subjectCorrect / items.length) * 100;
        fs.appendFileSync(
            summaryPath,
            `${subject}\t${subjectCorrect}/${items.length}\t${subjectAcc.toFixed(2)}%\n`,
            "utf-8"
        );
        process.stdout.write(`\r[MMLU_V1][${subject}] done ${subjectAcc.toFixed(2)}%                        \n`);
    }

    const overall = tracker.total === 0 ? 0 : (tracker.correct / tracker.total) * 100;
    fs.appendFileSync(
        summaryPath,
        `TOTAL\t${tracker.correct}/${tracker.total}\t${overall.toFixed(2)}%\n`,
        "utf-8"
    );
    await gpuMonitor.stop();
    await flushSummary("completed");
    console.log(`MMLU_V1 finished. Accuracy: ${overall.toFixed(2)}% (${tracker.correct}/${tracker.total})`);
}

main().catch(err => {
    console.error("MMLU_V1 failed:", err);
    process.exitCode = 1;
});
