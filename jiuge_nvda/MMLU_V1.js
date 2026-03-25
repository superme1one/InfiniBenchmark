const fs = require("fs");
const path = require("path");
const {
    DEFAULT_CONFIG,
    appendJsonl,
    askModel,
    buildSummaryPayload,
    createStatsTracker,
    ensureDir,
    extractTail,
    formatMs,
    getDatasetPath,
    getGpuStats,
    normalizeText,
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
    return [
        "Answer the multiple-choice question by replying with exactly one capital letter.",
        `Subject: ${subject.replace(/_/g, " ")}`,
        "",
        `Question: ${item.question}`,
        `A. ${item.choices[0]}`,
        `B. ${item.choices[1]}`,
        `C. ${item.choices[2]}`,
        `D. ${item.choices[3]}`,
        "Answer:",
    ].join("\n");
}

function extractChoice(output, choices = []) {
    const tail = extractTail(output);
    const patterns = [
        /answer\s*[:=]?\s*([A-D])\b/i,
        /(?:correct answer|final answer)\s*[:=]?\s*([A-D])\b/i,
        /the answer is\s*([A-D])\b/i,
        /\\boxed\{([A-D])\}/i,
        /\boption\s*([A-D])\b/i,
        /^\s*([A-D])(?:[\).:\s]|$)/i,
    ];

    for (const pattern of patterns) {
        const match = tail.match(pattern) || String(output || "").match(pattern);
        if (match) return match[1].toUpperCase();
    }

    const lines = tail.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i].match(/^([A-D])(?:[\).:\s]|$)/i);
        if (match) return match[1].toUpperCase();
    }

    const fallback = tail.match(/\b([A-D])\b(?!.*\b[A-D]\b)/i);
    if (fallback) return fallback[1].toUpperCase();

    const normalizedTail = normalizeText(tail);
    if (normalizedTail && Array.isArray(choices) && choices.length === 4) {
        const choiceMatches = choices
            .map((choice, index) => ({
                label: String.fromCharCode(65 + index),
                normalized: normalizeText(choice),
            }))
            .filter(choice => choice.normalized);

        const exact = choiceMatches.find(choice => choice.normalized === normalizedTail);
        if (exact) return exact.label;

        const prefixMatches = choiceMatches.filter(choice =>
            choice.normalized.startsWith(normalizedTail) || normalizedTail.startsWith(choice.normalized)
        );
        if (prefixMatches.length === 1) {
            return prefixMatches[0].label;
        }
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
                    maxTokens: 6,
                    temperature: 0,
                    stop: ["\n", "\r", "Question:"],
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
