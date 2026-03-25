const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const DEFAULT_CONFIG = {
    apiUrl: process.env.JIUGE_API_URL || "http://127.0.0.1:1145/completion",
    modelName: process.env.JIUGE_MODEL_NAME || "9g_8b_thinking",
    maxTokens: Number(process.env.JIUGE_MAX_TOKENS || 4096),
    timeoutMs: Number(process.env.JIUGE_TIMEOUT_MS || 300000),
    cooldownMs: Number(process.env.JIUGE_COOLDOWN_MS || 300),
    temperature: Number(process.env.JIUGE_TEMPERATURE || 0.1),
    retries: Number(process.env.JIUGE_RETRIES || 3),
    gpuSampleIntervalMs: Number(process.env.JIUGE_GPU_SAMPLE_INTERVAL_MS || 500),
    resultDir: path.join(__dirname, "result_v1"),
    allTestDir: path.join(__dirname, "result_alltest"),
};

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureJsonFile(filePath, defaultValue) {
    ensureDir(path.dirname(filePath));
    if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), "utf-8");
    }
}

async function fetchWithTimeout(url, options = {}) {
    const { timeout = DEFAULT_CONFIG.timeoutMs, ...rest } = options;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
        return await fetch(url, { ...rest, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function extractModelText(data) {
    if (!data || typeof data !== "object") {
        return "";
    }

    if (typeof data.response === "string") return data.response;
    if (typeof data.content === "string") return data.content;

    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice) {
        if (typeof choice.text === "string") return choice.text;
        if (typeof choice.message?.content === "string") return choice.message.content;
        if (typeof choice.delta?.content === "string") return choice.delta.content;
    }

    return "";
}

function getEndpointCandidates(config) {
    return [{ type: "completion1145", url: config.apiUrl }];
}

function buildPayload(prompt, config, endpointType) {
    if (endpointType === "completion1145") {
        return {
            prompt,
            n_predict: config.maxTokens,
            temperature: config.temperature,
            stop: Array.isArray(config.stop) ? config.stop : [],
        };
    }

    return {
        prompt,
        n_predict: config.maxTokens,
        temperature: config.temperature,
        stop: Array.isArray(config.stop) ? config.stop : [],
    };
}

async function askModel(prompt, overrides = {}) {
    const config = { ...DEFAULT_CONFIG, ...overrides };
    const endpoints = getEndpointCandidates(config);
    const errors = [];

    for (const endpoint of endpoints) {
        for (let attempt = 0; attempt < config.retries; attempt++) {
            const startedAt = Date.now();

            try {
                const response = await fetchWithTimeout(endpoint.url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(buildPayload(prompt, config, endpoint.type)),
                    timeout: config.timeoutMs,
                });

                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();
                const output = extractModelText(data);
                if (!String(output || "").trim()) {
                    throw new Error("empty response body");
                }

                return {
                    output,
                    inferenceTimeMs: Date.now() - startedAt,
                    endpoint: endpoint.url,
                };
            } catch (err) {
                errors.push(`${endpoint.url} [attempt ${attempt + 1}/${config.retries}]: ${err.message}`);
                if (attempt < config.retries - 1) {
                    await sleep(200);
                }
            }
        }
    }

    throw new Error(errors.join(" | "));
}

function appendJsonl(filePath, record) {
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
}

function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/<think>[\s\S]*?<\/think>/gi, " ")
        .replace(/[\u2018\u2019]/g, "'")
        .replace(/[\u201c\u201d]/g, "\"")
        .replace(/[^a-z0-9.\-\s]/gi, " ")
        .replace(/\b(a|an|the)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function normalizeNumberString(value) {
    return String(value || "")
        .replace(/,/g, "")
        .replace(/\$/g, "")
        .trim();
}

function parseLastNumber(text) {
    const matches = String(text || "").match(/-?\d+(?:\.\d+)?/g);
    if (!matches || matches.length === 0) return NaN;
    return Number(matches[matches.length - 1]);
}

function extractTail(text) {
    const raw = String(text || "");
    const noThink = raw.includes("</think>") ? raw.slice(raw.lastIndexOf("</think>") + 8) : raw;
    return noThink.trim();
}

function getDatasetPath(...segments) {
    return path.join(__dirname, "..", "data_sets", ...segments);
}

function formatMs(ms) {
    return `${Number(ms || 0).toFixed(0)}ms`;
}

function createStatsTracker(datasetName, total) {
    return {
        datasetName,
        total,
        startedAt: new Date().toISOString(),
        processed: 0,
        correct: 0,
        totalInferenceTimeMs: 0,
        errors: 0,
        emptyResponses: 0,
        lastGpu: null,
        gpuSamples: 0,
        gpuUtilizationSum: 0,
        gpuMemoryUsedSumMB: 0,
        gpuMemoryFreeSumMB: 0,
        gpuMemoryTotalSumMB: 0,
        gpuUtilizationMax: 0,
        gpuMonitorSamples: 0,
        gpuMonitorUtilizationSum: 0,
        gpuMonitorMemoryUsedSumMB: 0,
        gpuMonitorMemoryFreeSumMB: 0,
        gpuMonitorMemoryTotalSumMB: 0,
        gpuMonitorUtilizationMax: 0,
    };
}

function updateStatsTracker(tracker, record) {
    tracker.processed += 1;
    if (record.correct) tracker.correct += 1;
    tracker.totalInferenceTimeMs += Number(record.inferenceTimeMs || 0);
    if (record.error) tracker.errors += 1;
    if (String(record.error || "").includes("empty response body")) {
        tracker.emptyResponses += 1;
    }
    if (record.gpu) {
        tracker.lastGpu = record.gpu;
        tracker.gpuSamples += 1;
        tracker.gpuUtilizationSum += Number(record.gpu.gpuUtilization || 0);
        tracker.gpuMemoryUsedSumMB += Number(record.gpu.memoryUsedMB || 0);
        tracker.gpuMemoryFreeSumMB += Number(record.gpu.memoryFreeMB || 0);
        tracker.gpuMemoryTotalSumMB += Number(record.gpu.memoryTotalMB || 0);
        tracker.gpuUtilizationMax = Math.max(
            tracker.gpuUtilizationMax,
            Number(record.gpu.gpuUtilization || 0)
        );
    }
}

function buildSummaryPayload(tracker, status) {
    const accuracy = tracker.processed === 0 ? 0 : (tracker.correct / tracker.processed) * 100;
    const avgInferenceTimeMs = tracker.processed === 0 ? 0 : tracker.totalInferenceTimeMs / tracker.processed;
    const useMonitorSamples = tracker.gpuMonitorSamples > 0;
    const sampleCount = useMonitorSamples ? tracker.gpuMonitorSamples : tracker.gpuSamples;
    const utilizationSum = useMonitorSamples ? tracker.gpuMonitorUtilizationSum : tracker.gpuUtilizationSum;
    const memoryUsedSum = useMonitorSamples ? tracker.gpuMonitorMemoryUsedSumMB : tracker.gpuMemoryUsedSumMB;
    const memoryFreeSum = useMonitorSamples ? tracker.gpuMonitorMemoryFreeSumMB : tracker.gpuMemoryFreeSumMB;
    const memoryTotalSum = useMonitorSamples ? tracker.gpuMonitorMemoryTotalSumMB : tracker.gpuMemoryTotalSumMB;
    const maxUtilization = useMonitorSamples ? tracker.gpuMonitorUtilizationMax : tracker.gpuUtilizationMax;
    const avgGpu = sampleCount === 0
        ? null
        : {
            avgGpuUtilization: Number((utilizationSum / sampleCount).toFixed(2)),
            avgMemoryUsedMB: Number((memoryUsedSum / sampleCount).toFixed(2)),
            avgMemoryFreeMB: Number((memoryFreeSum / sampleCount).toFixed(2)),
            avgMemoryTotalMB: Number((memoryTotalSum / sampleCount).toFixed(2)),
            maxGpuUtilization: Number(maxUtilization.toFixed(2)),
            samples: sampleCount,
            mode: useMonitorSamples ? "continuous" : "per_item",
        };
    return {
        dataset: tracker.datasetName,
        status,
        startedAt: tracker.startedAt,
        updatedAt: new Date().toISOString(),
        total: tracker.total,
        processed: tracker.processed,
        correct: tracker.correct,
        accuracy: Number(accuracy.toFixed(2)),
        avgInferenceTimeMs: Number(avgInferenceTimeMs.toFixed(2)),
        errors: tracker.errors,
        emptyResponses: tracker.emptyResponses,
        gpu: tracker.lastGpu,
        avgGpu,
    };
}

function startGpuMonitor(tracker, intervalMs = DEFAULT_CONFIG.gpuSampleIntervalMs) {
    let stopped = false;
    let timer = null;
    let inFlight = false;

    const sample = async () => {
        if (stopped || inFlight) return;
        inFlight = true;
        try {
            const gpu = await getGpuStats();
            if (gpu) {
                tracker.lastGpu = gpu;
                tracker.gpuMonitorSamples += 1;
                tracker.gpuMonitorUtilizationSum += Number(gpu.gpuUtilization || 0);
                tracker.gpuMonitorMemoryUsedSumMB += Number(gpu.memoryUsedMB || 0);
                tracker.gpuMonitorMemoryFreeSumMB += Number(gpu.memoryFreeMB || 0);
                tracker.gpuMonitorMemoryTotalSumMB += Number(gpu.memoryTotalMB || 0);
                tracker.gpuMonitorUtilizationMax = Math.max(
                    tracker.gpuMonitorUtilizationMax,
                    Number(gpu.gpuUtilization || 0)
                );
            }
        } finally {
            inFlight = false;
        }
    };

    sample();
    timer = setInterval(sample, Math.max(100, intervalMs));
    if (typeof timer.unref === "function") {
        timer.unref();
    }

    return {
        stop: async () => {
            stopped = true;
            if (timer) clearInterval(timer);
            await sample();
        },
    };
}

function writeAllTestSummary(datasetName, payload) {
    const summaryPath = path.join(DEFAULT_CONFIG.allTestDir, "alltest_summary.json");
    ensureJsonFile(summaryPath, {});
    const raw = fs.readFileSync(summaryPath, "utf-8");
    const data = raw.trim() ? JSON.parse(raw) : {};
    data[datasetName] = payload;
    fs.writeFileSync(summaryPath, JSON.stringify(data, null, 2), "utf-8");
    return summaryPath;
}

function getGpuStats() {
    return new Promise(resolve => {
        try {
            exec(
                "nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used,memory.free --format=csv,noheader,nounits",
                { timeout: 5000 },
                (err, stdout) => {
                    if (err || !stdout) {
                        resolve(null);
                        return;
                    }

                    const values = stdout.trim().split(",").map(item => Number(item.trim()));
                    if (values.length < 4 || values.some(Number.isNaN)) {
                        resolve(null);
                        return;
                    }

                    resolve({
                        gpuUtilization: values[0],
                        memoryTotalMB: values[1],
                        memoryUsedMB: values[2],
                        memoryFreeMB: values[3],
                    });
                }
            );
        } catch (_error) {
            resolve(null);
        }
    });
}

module.exports = {
    DEFAULT_CONFIG,
    appendJsonl,
    askModel,
    buildSummaryPayload,
    createStatsTracker,
    ensureDir,
    extractTail,
    getDatasetPath,
    getGpuStats,
    normalizeNumberString,
    normalizeText,
    parseLastNumber,
    formatMs,
    sleep,
    startGpuMonitor,
    updateStatsTracker,
    writeAllTestSummary,
};
