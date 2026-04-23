# MMLU Unified Benchmark

`mmlu.js` 是 `jiuge_uniform` 下的统一版 MMLU 测试脚本。它用于在不同服务器部署上跑同一套 MMLU 评测，只允许接口地址和请求协议变化，prompt、答案提取规则、`maxTokens`、温度和判题逻辑保持一致。

## 设计目标

- 保持评测语义一致：所有服务器使用同一套 MMLU prompt 和 `Answer: X` 输出格式。
- 保持接口适配独立：服务器差异只放在 `server profile` 和 `apiType`。
- 保持结果可复盘：每题原始输出、提取答案、标准答案、耗时和错误都会写入 JSONL。
- 保持脚本可迁移：不依赖其他 `jiuge_*` 文件夹中的 `common_v1.js` 或 `api_client.js`。

## 文件模块

### Server Profiles

位置：`SERVER_PROFILES`

作用：定义每个服务器的默认接口地址、请求类型、模型名和是否流式返回。

内置 profile：

- `tianshu`：默认 `http://localhost:9000/chat`，使用 `prompt` 请求格式。
- `muxi`：默认 `http://172.22.162.17:8000/chat/completions`，使用 `chat` 请求格式。
- `moer`：默认 `http://127.0.0.1:9501/chat/completions`，使用 `chat` 请求格式。
- `nvda`：默认 `http://127.0.0.1:1145/completion`，使用 `completion` 请求格式。

注意：profile 只应该描述接口差异，不应该改变 prompt、提取规则或判题规则。

### Subject List

位置：`SUBJECTS`

作用：定义 MMLU 的 57 个测试学科。默认会按列表顺序全部运行。

如果只想跑部分学科，可以使用：

```powershell
node mmlu.js --subjects abstract_algebra,anatomy
```

### CLI Parsing

位置：`parseArgs`、`toNumber`、`toBoolean`、`inferApiType`、`printUsage`

作用：解析启动参数、环境变量和默认值。

支持两种参数形式：

```powershell
node mmlu.js --server tianshu
node mmlu.js --server=tianshu
```

### Configuration

位置：`CONFIG`

作用：在启动时汇总所有运行配置。

优先级：

1. 命令行参数
2. 环境变量
3. server profile 默认值
4. 脚本内默认值

关键默认值：

- `maxTokens = 4096`
- `temperature = 0.1`
- `limitPerSubject = 100`
- `cooldownMs = 200`
- `timeoutMs = 300000`

### Utilities

位置：`sleep`、`ensureDir`、`clearCurrentLine`、`printProgress`、`resolveDataDir`、`getSelectedSubjects`

作用：提供通用辅助能力，比如等待、创建目录、刷新进度行、定位 MMLU 数据集、筛选 subject。

默认数据路径：

```text
../data_sets/MMLU
```

### Dataset Module

位置：`parseCsvRecords`、`loadSubjectItems`

作用：读取每个 MMLU subject 的 CSV 文件，并转换成统一结构：

```json
{
  "question": "...",
  "choices": ["A option", "B option", "C option", "D option"],
  "answer": "B"
}
```

CSV 解析器支持带引号的逗号和转义双引号，避免简单 `split(",")` 把题目切坏。

### Prompt Module

位置：`buildPrompt`

作用：构造统一 MMLU prompt。

当前统一格式采用 `tianshu/nvda` 已经对齐过的风格：

```text
You are an expert in <subject>.

Question:
...
A) ...
B) ...
C) ...
D) ...

Instructions:
1. Think step by step to solve the problem.
2. **Be concise.** Do NOT double-check your work once you derive an answer.
3. You MUST end your response with exactly: "Answer: X" (where X is A, B, C, or D).
4. Do NOT output anything after the final answer.
```

注意：这里没有采用 `ds_nvda/test_MMLU.js` 中的 `boxed{}` 作为主格式，因为本目录目标是统一 `jiuge_*` 服务器，而当前 `jiuge` 系列已统一到 `Answer: X`。

### Network Module

位置：`fetchWithTimeout`、`buildPayload`、`extractModelText`、`readSseText`、`askModel`

作用：把统一 prompt 转换成不同服务器需要的请求格式，并把不同响应结构统一成纯文本输出。

支持的 `apiType`：

- `prompt`：请求体使用 `prompt` 和 `max_tokens`，适配 `tianshu` 风格接口。
- `chat`：请求体使用 `messages` 和 `max_tokens`，适配 `/chat/completions`。
- `completion`：请求体使用 `prompt` 和 `n_predict`，适配本地 completion 接口。

### Parsing Module

位置：`cleanModelOutput`、`extractChoice`

作用：清洗模型输出并提取最终选项。

提取优先级：

1. `Answer: X`
2. `The answer is X`
3. `The correct option is X`
4. `boxed{X}`
5. 单独一行 `A`、`B`、`C` 或 `D`
6. `Option X`
7. 最后 100 个字符里的宽松匹配

如果输出包含未闭合的 `<think>`，会返回 `TRUNCATED`。

### Evaluation Module

位置：`isCorrect`

作用：严格比较预测选项和标准选项。

MMLU 判题规则很简单：

```text
prediction === expected
```

### Result Module

位置：`appendJsonl`、`updateDatasetSummary`、`logResult`

作用：输出进度日志，将每题结果写入 JSONL，并在测试结束后更新跨服务器汇总 JSON。

每题记录包含：

- `id`
- `server`
- `api_url`
- `api_type`
- `subject`
- `question`
- `choices`
- `prediction`
- `expected`
- `correct`
- `inferenceTimeMs`
- `error`
- `output`

### Main Pipeline

位置：`main`

完整流程：

```text
读取参数 -> 定位 MMLU 数据目录 -> 筛选 subjects -> 逐 subject 读取 CSV -> 逐题请求模型 -> 提取答案 -> 判题 -> 写 JSONL -> 写汇总
```

## 运行示例

进入目录：

```powershell
cd "C:\Users\zy\Desktop\0420\InfiniBenchmark 0420\InfiniBenchmark\jiuge_uniform"
```

测试 `tianshu`：

```powershell
node mmlu.js --server tianshu --limit-per-subject 100
```

测试 `muxi`：

```powershell
node mmlu.js --server muxi --limit-per-subject 100
```

测试 `moer`：

```powershell
node mmlu.js --server moer --limit-per-subject 100
```

测试 `nvda`：

```powershell
node mmlu.js --server nvda --limit-per-subject 100
```

只跑一个学科：

```powershell
node mmlu.js --server tianshu --subjects abstract_algebra --limit-per-subject 100
```

只跑多个学科：

```powershell
node mmlu.js --server muxi --subjects abstract_algebra,anatomy,astronomy --limit-per-subject 100
```

临时指定接口：

```powershell
node mmlu.js --server moer --api-url http://127.0.0.1:9501/chat/completions --limit-per-subject 100
```

自定义 completion 接口：

```powershell
node mmlu.js --server custom --api-url http://127.0.0.1:1145/completion --api-type completion --subjects abstract_algebra
```

查看帮助：

```powershell
node mmlu.js --help
```

## 常用参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--server` | 服务器 profile | `tianshu` |
| `--api-url` | 覆盖接口地址 | profile 默认值 |
| `--api-type` | 请求格式：`prompt`、`chat`、`completion` | profile 默认值或按 URL 推断 |
| `--model` | 模型名 | profile 默认值 |
| `--subjects` | 指定 subject 列表 | 全部 subject |
| `--limit-per-subject` | 每个 subject 测试样本数 | `100` |
| `--max-tokens` | 最大生成 token | `4096` |
| `--temperature` | 温度 | `0.1` |
| `--cooldown-ms` | 样本间隔 | `200` |
| `--timeout-ms` | 单题超时 | `300000` |
| `--data-dir` | MMLU 数据目录 | `../data_sets/MMLU` |
| `--result-dir` | 结果目录 | `result` |
| `--stream` | 是否启用 SSE 流式读取 | `false` |

## 结果文件

默认写入：

```text
jiuge_uniform/result/
```

每个 subject 一个结果文件：

```text
mmlu_<server>_<subject>.jsonl
```

每个 subject 的汇总：

```text
mmlu_<server>_subjects.jsonl
```

文本汇总：

```text
mmlu_<server>_summary.txt
```

示例单题记录：

```json
{
  "id": 1,
  "server": "tianshu",
  "api_url": "http://localhost:9000/chat",
  "api_type": "prompt",
  "subject": "abstract_algebra",
  "question": "...",
  "choices": ["0", "4", "2", "6"],
  "prediction": "B",
  "expected": "B",
  "correct": true,
  "inferenceTimeMs": 1234,
  "error": "",
  "output": "..."
}
```

同时会更新一个数据集级别的跨服务器汇总文件：

```text
jiuge_uniform/result/mmlu_summary.json
```

这个文件按 server 保存最近一次运行结果，方便横向比较不同服务器的总体准确率和平均推理时延：

```json
{
  "dataset": "MMLU",
  "updatedAt": "2026-04-23T00:00:00.000Z",
  "servers": {
    "nvda": {
      "server": "nvda",
      "api_url": "http://127.0.0.1:1145/completion",
      "api_type": "completion",
      "model": "9g_8b_thinking",
      "total": 5700,
      "correct": 3000,
      "accuracy": 52.63,
      "avgLatencyMs": 1234,
      "errors": 0,
      "subject_summary_file": "...",
      "text_summary_file": "..."
    }
  }
}
```

## 新增服务器

如果以后要新增服务器，比如 `newserver`，优先只改 `SERVER_PROFILES`：

```js
newserver: {
    apiUrl: "http://host:port/chat/completions",
    apiType: "chat",
    modelName: "9g_8b_thinking",
    stream: false,
},
```

如果接口只是端口不同，也可以不改代码，直接用命令行覆盖：

```powershell
node mmlu.js --server custom --api-url http://host:port/chat/completions --api-type chat
```

## 可靠性注意点

- 不要为了某个服务器单独改 prompt，否则准确率对比会失真。
- 不要为了某个服务器单独改 `maxTokens` 或温度，否则平均时延和准确率都不可比。
- `apiType` 可以不同，因为它只影响请求格式，不改变测试语义。
- 如果某个服务器输出格式异常，优先检查接口适配层，不要先改判题规则。
- MMLU 是选择题，最终答案只应该是 `A`、`B`、`C` 或 `D`。
