下面这段可以直接作为研究报告中的一个章节草稿，写作风格尽量向中文学术期刊正文靠拢；其中代码均为你当前统一脚本的节选，可直接配合正文插入。

**第四章 统一测试框架的设计与实现**

为保证不同服务器端部署模型的评测结果具有可比性、可复现性与可解释性，本文构建了一套面向多数据集、多后端部署环境的统一测试框架 `jiuge_uniform`。该框架覆盖 TriviaQA、MMLU、DROP 与 GSM8K 四类典型任务，分别对应事实性问答、多学科选择题、阅读理解与数值推理等不同能力维度。与既有“按服务器分别维护脚本”的方式不同，本文所提出的统一框架遵循“评测语义固定、接口适配分离”的设计原则：在不同服务器端测试同一模型时，提示词、答案提取规则、生成参数上限、温度设置以及判题逻辑保持严格一致，仅允许接口地址、请求协议和返回格式适配层发生变化。由此，可以最大限度剥离部署差异对评测结论的干扰，使不同服务器环境下的准确率与推理时延具有更强的横向可比性。

从系统结构上看，统一测试框架主要由四个层次构成：其一为数据集层，负责定位数据文件并完成基础解析；其二为提示词层，负责为各数据集构造稳定且可复用的任务指令；其三为网络适配层，负责将统一提示词映射为不同服务端所要求的 HTTP 请求体格式；其四为结果分析层，负责答案提取、正确率计算、逐题结果落盘以及跨服务器汇总统计。该结构的关键意义在于，它将“任务定义”与“服务访问”明确解耦，使评测框架既能保持学术实验所要求的严格控制变量，又具备工程上的迁移能力与可维护性。

在服务端抽象方面，本文首先为不同部署环境定义了统一的服务器配置表。该配置仅描述后端连接信息与请求体类型，不允许修改任何与评测语义相关的字段。代码清单 4-1 给出了典型实现方式。

代码清单 4-1 摘自 [triviaqa.js](<C:/Users/zy/Desktop/0420/InfiniBenchmark 0420/InfiniBenchmark/jiuge_uniform/triviaqa.js>)

```js
const SERVER_PROFILES = {
    tianshu: {
        apiUrl: "http://localhost:9000/chat",
        apiType: "prompt",
        modelName: "9g_8b_thinking",
        stream: false,
    },
    muxi: {
        apiUrl: "http://172.22.162.17:8000/chat/completions",
        apiType: "chat",
        modelName: "9g_8b_thinking",
        stream: false,
    },
    moer: {
        apiUrl: "http://127.0.0.1:9501/chat/completions",
        apiType: "chat",
        modelName: "9G-8B",
        stream: false,
    },
    nvda: {
        apiUrl: "http://127.0.0.1:1145/completion",
        apiType: "completion",
        modelName: "9g_8b_thinking",
        stream: false,
    },
};
```

上述设计体现了统一测试框架的首要思想，即服务器配置只负责描述“如何访问模型”，而不负责定义“如何测试模型”。换言之，`tianshu`、`muxi`、`moer` 与 `nvda` 的差异仅体现在接口地址和请求格式上，而题目内容、提示词文本、答案提取方式与评分标准不因服务器不同而变化。这样的变量控制方式，符合实验研究中“单因素变动”的基本原则。

在请求协议适配方面，本文进一步设计了统一的 `buildPayload` 机制，用以兼容 `prompt`、`chat` 与 `completion` 三类接口风格。尽管不同服务端对字段命名与消息结构的要求不同，但统一框架始终向它们传递同一段任务提示词与同一组生成参数。代码清单 4-2 展示了这一适配策略。

代码清单 4-2 摘自 [gsm8k.js](<C:/Users/zy/Desktop/0420/InfiniBenchmark 0420/InfiniBenchmark/jiuge_uniform/gsm8k.js>)

```js
function buildPayload(prompt) {
    if (CONFIG.apiType === "chat") {
        return {
            model: CONFIG.modelName,
            messages: [{ role: "user", content: prompt }],
            max_tokens: CONFIG.maxTokens,
            temperature: CONFIG.temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
            stream: CONFIG.stream,
        };
    }

    if (CONFIG.apiType === "completion") {
        return {
            prompt,
            n_predict: CONFIG.maxTokens,
            temperature: CONFIG.temperature,
            top_p: CONFIG.topP,
            top_k: CONFIG.topK,
        };
    }

    return {
        prompt,
        max_tokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        top_p: CONFIG.topP,
        top_k: CONFIG.topK,
    };
}
```

从方法论上看，这一设计具有两点意义。其一，它避免了“针对某个服务器单独重写测试逻辑”的碎片化实现，使不同部署端的测试过程具备统一的可解释性。其二，它清晰地区分了“评测任务本身”与“服务端调用协议”这两个层面的问题，从而保证了当后端接口发生迁移时，研究者只需调整适配层而不必改动实验设置。这种架构既提升了代码复用性，也增强了评测结果的稳定性。

为了进一步保证跨服务器测试的公平性，本文对各数据集的提示词进行了显式统一。例如，在 GSM8K 数学推理任务中，脚本要求模型以 `#### <final_number>` 的形式输出最终答案，避免模型仅输出中间推理而缺失最终数值。代码清单 4-3 给出了统一提示词模板。

代码清单 4-3 摘自 [gsm8k.js](<C:/Users/zy/Desktop/0420/InfiniBenchmark 0420/InfiniBenchmark/jiuge_uniform/gsm8k.js>)

```js
function buildPrompt(question) {
    return `
You are a math expert.

Question:
${question}

Instructions:
1. Think step-by-step to solve the problem.
2. Be concise but show your calculation clearly.
3. You MUST end your response with: "#### <final_number>"
   Example:
   ... reasoning ...
   #### 42

Response:
`.trim();
}
```

类似地，在 MMLU 中统一规定模型以 `Answer: X` 输出四选一答案，在 TriviaQA 中统一规定最终答案必须以 `Answer:` 开头，在 DROP 中则区分数字题与文本 span 题，并统一要求模型输出单一最终答案。这里的核心并不在于提示词“是否最优”，而在于提示词“是否在所有服务器上完全一致”。在跨平台评测研究中，统一性优先于局部最优性；如果对某一服务器单独优化提示词，即便该服务器准确率提升，也无法说明这种提升来自模型能力本身还是来自额外的提示词适配。

除提示词控制外，答案提取与判题规则同样是统一评测中的关键环节。由于不同服务端的输出格式并不完全稳定，模型有时会出现思维链标签、控制 token、示例泄漏或模板回显等现象，因此统一框架必须在后处理阶段执行稳健的答案抽取。以 TriviaQA 为例，框架优先提取显式 `Answer:` 标记后的内容；若模型未按规范输出，则回退到输出末尾的短文本行。代码清单 4-4 展示了该策略。

代码清单 4-4 摘自 [triviaqa.js](<C:/Users/zy/Desktop/0420/InfiniBenchmark 0420/InfiniBenchmark/jiuge_uniform/triviaqa.js>)

```js
function extractAnswer(rawOutput) {
    const cleanText = cleanModelOutput(rawOutput);
    if (!cleanText) return "FORMAT_ERROR";

    const answers = [];
    const answerRegex = /\*{0,2}Answer\s*:\*{0,2}\s*([^\r\n]+)/gi;
    for (const match of cleanText.matchAll(answerRegex)) {
        const candidate = normalizeCandidate(match[1]);
        if (candidate && !isMetaLine(candidate)) {
            answers.push(candidate);
        }
    }

    if (answers.length > 0) {
        return answers[answers.length - 1];
    }

    const lines = cleanText
        .split(/\r?\n/)
        .map(line => normalizeCandidate(line))
        .filter(Boolean)
        .filter(line => !isMetaLine(line));

    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].length <= 120) {
            return lines[i];
        }
    }

    return "FORMAT_ERROR";
}
```

这一设计说明，统一测试并非简单地“统一提示词”即可完成，而是需要在输出后处理层面同步建立稳健规则。尤其是在本地 `completion` 风格接口中，模型更容易继续补写下一题模板、重复 prompt 内容或输出多个候选答案，因此若缺乏统一的答案提取机制，最终准确率会受到解析误差的显著影响。

针对结构复杂、输出噪声较多的 DROP 数据集，本文还进一步设计了“主请求 + 严格重试”的双阶段机制。当模型第一次输出的结构不满足约束时，例如缺少 `Answer:`、出现多个候选答案或数值题未给出有效数字，脚本将自动触发一次更短、更强约束的重试请求。代码清单 4-5 展示了这一实现。

代码清单 4-5 摘自 [drop.js](<C:/Users/zy/Desktop/0420/InfiniBenchmark 0420/InfiniBenchmark/jiuge_uniform/drop.js>)

```js
async function askDrop(passage, question, expectsNumber) {
    const primaryResult = await requestModel(buildPrimaryPrompt(passage, question, expectsNumber), {
        maxTokens: CONFIG.maxTokens,
        temperature: CONFIG.temperature,
        stop: PRIMARY_STOP,
    });

    const primaryPrediction = selectPrediction(primaryResult.output, expectsNumber, question);
    if (!CONFIG.retry || !needsRetry(primaryResult.output, primaryPrediction, expectsNumber)) {
        return { ...primaryResult, prediction: primaryPrediction, strategy: "primary" };
    }

    const strictResult = await requestModel(buildStrictPrompt(passage, question, expectsNumber), {
        maxTokens: CONFIG.strictMaxTokens,
        temperature: 0,
        stop: STRICT_STOP,
    });

    return {
        ...strictResult,
        prediction: selectPrediction(strictResult.output, expectsNumber, question),
        strategy: "strict_retry",
    };
}
```

从实验规范的角度看，这一机制并不构成对某一服务器的额外优化，而是作为统一框架的一部分，对所有服务器一视同仁地启用。其目的在于降低输出格式异常对结果统计的污染，使最终准确率更能反映模型的真实任务完成能力，而非输出格式是否恰好符合解析器要求。

在结果记录方面，统一框架采用“逐题明细 + 跨服务器汇总”双层结构。逐题结果以 JSONL 形式保存，包含题目、模型原始输出、提取答案、判题结果和单题耗时，便于后续误差分析；跨服务器汇总则用于记录同一数据集在不同后端上的总体表现。代码清单 4-6 给出了汇总文件的更新逻辑。

代码清单 4-6 摘自 [drop.js](<C:/Users/zy/Desktop/0420/InfiniBenchmark 0420/InfiniBenchmark/jiuge_uniform/drop.js>)

```js
function updateDatasetSummary(summaryPath, datasetName, serverKey, record) {
    ensureDir(path.dirname(summaryPath));

    let payload = { dataset: datasetName, updatedAt: "", servers: {} };
    if (fs.existsSync(summaryPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
            if (parsed && typeof parsed === "object") payload = parsed;
        } catch (_error) {}
    }

    const updatedAt = new Date().toISOString();
    payload.dataset = datasetName;
    payload.updatedAt = updatedAt;
    payload.servers[serverKey] = { ...record, updatedAt };

    fs.writeFileSync(summaryPath, JSON.stringify(payload, null, 2), "utf-8");
}
```

基于上述实现，本文在每个数据集下均生成独立的汇总结果文件，例如 `triviaqa_summary.json`、`mmlu_summary.json`、`drop_summary.json` 与 `gsm8k_summary.json`。这些文件按照服务器名称保存最近一次实验结果，记录准确率、平均推理时延、错误数以及相关配置参数，从而为后续研究中的横向对比分析提供直接支撑。相较于仅保存逐题明细的做法，这种设计显著提升了实验结果的可读性与复用性。

在评价指标上，本文主要关注两类指标：一是样本级总体准确率，定义为
`Accuracy = Correct / Total × 100%`；
二是平均推理时延，定义为
`AvgLatency = (1 / Total) × Σ inferenceTimeMs`。
其中，准确率反映模型在给定任务上的最终作答能力，平均推理时延则反映模型在具体部署环境中的响应效率。需要指出的是，本文所统计的推理时延为“从发起 HTTP 请求到接收完整响应”的端到端耗时，因此其既包含模型生成时间，也包含接口序列化、网络传输与响应解析的额外开销。正因为如此，该指标更适合用于部署层面对比，而非纯粹的底层算力分析。

综合来看，统一测试框架的价值主要体现在三个方面。其一，它通过固定提示词、提取规则与判题逻辑，确保了不同服务器端实验结果的公平可比。其二，它通过抽象请求适配层，实现了 `prompt`、`chat` 与 `completion` 三类接口风格的统一接入，增强了评测系统的通用性与可迁移性。其三，它通过逐题结果与跨服务器汇总的双层存储机制，为后续的误差定位、性能复盘与部署选型提供了完整的数据支撑。由此，本文所构建的统一测试框架不仅是一组工程脚本，更是保障评测实验有效性与结论可信度的重要基础设施。
