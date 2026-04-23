# TriviaQA Unified Benchmark

`triviaqa.js` 是 `jiuge_uniform` 下的统一版 TriviaQA 测试脚本。它的目标是让不同服务器部署模型时只切换接口地址和请求协议，而提示词、答案提取规则、`maxTokens`、温度和判题逻辑保持一致。

## 设计目标

- 保持评测语义一致：不同服务器使用同一套 prompt、提取规则和判题逻辑。
- 保持接口适配独立：服务器差异只放在 `server profile` 和 `apiType`。
- 保持结果可复盘：每题原始输出、提取答案、标准 aliases、耗时和错误都会写入 JSONL。
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

注意：profile 只应该描述接口差异，不应该改变 prompt 或判题规则。

### CLI Parsing

位置：`parseArgs`、`toNumber`、`toBoolean`、`inferApiType`、`printUsage`

作用：解析启动参数、环境变量和默认值。

支持两种参数形式：

```powershell
node triviaqa.js --server tianshu
node triviaqa.js --server=tianshu
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

- `maxTokens = 1024`
- `temperature = 0.1`
- `limit = 100`
- `cooldownMs = 500`
- `timeoutMs = 120000`

### Utilities

位置：`sleep`、`ensureDir`、`clearCurrentLine`、`printProgress`、`resolveDataPath`

作用：提供通用辅助能力，比如等待、创建目录、刷新进度行、定位 TriviaQA 数据集。

默认数据路径：

```text
../data_sets/TriviaQA/verified-web-dev.json
```

### Prompt Module

位置：`buildPrompt`

作用：构造统一 prompt。

这部分是跨服务器公平对比的核心。无论 `tianshu`、`muxi`、`moer` 还是 `nvda`，都使用同一段 TriviaQA prompt，只要求模型最终以 `Answer: <final answer>` 格式输出。

### Network Module

位置：`fetchWithTimeout`、`buildPayload`、`extractModelText`、`readSseText`、`askModel`

作用：把统一 prompt 转换成不同服务器需要的请求格式，并把不同响应结构统一成纯文本输出。

支持的 `apiType`：

- `prompt`：请求体使用 `prompt` 和 `max_tokens`，适配 `tianshu` 风格接口。
- `chat`：请求体使用 `messages` 和 `max_tokens`，适配 `/chat/completions`。
- `completion`：请求体使用 `prompt` 和 `n_predict`，适配本地 completion 接口。

### Parsing Module

位置：`cleanModelOutput`、`normalizeCandidate`、`isMetaLine`、`extractAnswer`

作用：清洗模型输出并提取最终答案。

提取优先级：

1. 优先提取最后一个有效的 `Answer: ...`。
2. 如果没有 `Answer:`，从输出尾部选择短的非模板行。
3. 如果无法提取，返回 `FORMAT_ERROR`。

会过滤的内容包括：

- `<|im_end|>`、`<|endoftext|>` 等控制 token。
- `</think>` 之前的思考内容。
- `Question:`、`Instructions:`、`Example:` 等模板行。

### Evaluation Module

位置：`normalizeTriviaText`、`matchExpect`

作用：将预测答案和 TriviaQA aliases 标准化后比较。

判对规则：

- 归一化后完全相等算对。
- 预测包含 alias 算对。
- alias 包含预测也算对。

这样可以兼容 TriviaQA 中常见的简称、别名和轻微格式差异。

### Result Module

位置：`appendJsonl`、`updateDatasetSummary`、`logResult`

作用：输出进度日志，将每题结果写入 JSONL，并在测试结束后更新跨服务器汇总 JSON。

每题记录包含：

- `id`
- `server`
- `api_url`
- `api_type`
- `question`
- `prediction`
- `expected`
- `correct`
- `inferenceTimeMs`
- `error`
- `output`

最后会追加一条 summary 记录。

### Main Pipeline

位置：`main`

完整流程：

```text
读取参数 -> 定位数据集 -> 创建结果文件 -> 逐题请求模型 -> 提取答案 -> 判题 -> 写 JSONL -> 输出汇总
```

## 运行示例

进入目录：

```powershell
cd "C:\Users\zy\Desktop\0420\InfiniBenchmark 0420\InfiniBenchmark\jiuge_uniform"
```

测试 `tianshu`：

```powershell
node triviaqa.js --server tianshu --limit 100
```

测试 `muxi`：

```powershell
node triviaqa.js --server muxi --limit 100
```

测试 `moer`：

```powershell
node triviaqa.js --server moer --limit 100
```

测试 `nvda`：

```powershell
node triviaqa.js --server nvda --limit 100
```

临时指定接口：

```powershell
node triviaqa.js --server tianshu --api-url http://localhost:9000/chat --limit 100
```

自定义 completion 接口：

```powershell
node triviaqa.js --server custom --api-url http://127.0.0.1:1145/completion --api-type completion --limit 100
```

查看帮助：

```powershell
node triviaqa.js --help
```

## 常用参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--server` | 服务器 profile | `tianshu` |
| `--api-url` | 覆盖接口地址 | profile 默认值 |
| `--api-type` | 请求格式：`prompt`、`chat`、`completion` | profile 默认值或按 URL 推断 |
| `--model` | 模型名 | profile 默认值 |
| `--limit` | 测试样本数 | `100` |
| `--max-tokens` | 最大生成 token | `1024` |
| `--temperature` | 温度 | `0.1` |
| `--cooldown-ms` | 样本间隔 | `500` |
| `--timeout-ms` | 单题超时 | `120000` |
| `--data-file` | 数据文件路径 | `../data_sets/TriviaQA/verified-web-dev.json` |
| `--result-file` | 结果文件路径 | `result/triviaqa_<server>.jsonl` |
| `--stream` | 是否启用 SSE 流式读取 | `false` |

## 结果文件

默认写入：

```text
jiuge_uniform/result/triviaqa_<server>.jsonl
```

示例单题记录：

```json
{
  "id": 1,
  "server": "tianshu",
  "api_url": "http://localhost:9000/chat",
  "api_type": "prompt",
  "question": "...",
  "prediction": "...",
  "expected": ["..."],
  "correct": true,
  "inferenceTimeMs": 1234,
  "error": "",
  "output": "..."
}
```

最后一行是 summary：

```json
{
  "summary": true,
  "server": "tianshu",
  "total": 100,
  "correct": 42,
  "accuracy": 42,
  "avgLatencyMs": 1234,
  "errors": 0
}
```

同时会更新一个数据集级别的跨服务器汇总文件：

```text
jiuge_uniform/result/triviaqa_summary.json
```

这个文件按 server 保存最近一次运行结果，方便横向比较不同服务器的准确率和平均推理时延：

```json
{
  "dataset": "TriviaQA",
  "updatedAt": "2026-04-23T00:00:00.000Z",
  "servers": {
    "tianshu": {
      "server": "tianshu",
      "api_url": "http://localhost:9000/chat",
      "api_type": "prompt",
      "model": "9g_8b_thinking",
      "total": 100,
      "correct": 42,
      "accuracy": 42,
      "avgLatencyMs": 1234,
      "errors": 0,
      "result_file": "..."
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
node triviaqa.js --server custom --api-url http://host:port/chat/completions --api-type chat
```

## 可靠性注意点

- 不要为了某个服务器单独改 prompt，否则准确率对比会失真。
- 不要为了某个服务器单独改 `maxTokens` 或温度，否则平均时延和准确率都不可比。
- `apiType` 可以不同，因为它只影响请求格式，不改变测试语义。
- 如果某个服务器输出格式异常，优先检查接口适配层，不要先改判题规则。
