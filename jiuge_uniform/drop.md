# DROP Unified Benchmark

`drop.js` 是 `jiuge_uniform` 下的统一版 DROP 测试脚本。它用于在不同服务器部署上跑同一套 DROP 评测，只允许接口地址和请求协议变化，prompt、答案提取规则、`maxTokens`、温度、重试策略和判题逻辑保持一致。

## 设计目标

- 保持评测语义一致：所有服务器使用同一套 DROP prompt、提取规则和判题逻辑。
- 保持接口适配独立：服务器差异只放在 `server profile` 和 `apiType`。
- 减少 completion 续写污染：统一使用短输出主请求，并在结构异常时进行严格重试。
- 保持结果可复盘：每题原始输出、严格重试前输出、提取答案、标准答案、耗时和错误都会写入 JSONL。

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

### Stop Sequences

位置：`PRIMARY_STOP`、`STRICT_STOP`

作用：减少模型在 completion 接口下继续续写新的 `Passage:`、`Question:` 或模板内容。

如果某个服务端不支持 `stop` 参数，可以启动时加：

```powershell
node drop.js --server tianshu --no-stop
```

### CLI Parsing

位置：`parseArgs`、`toNumber`、`toBoolean`、`inferApiType`、`printUsage`

作用：解析启动参数、环境变量和默认值。

支持两种参数形式：

```powershell
node drop.js --server tianshu
node drop.js --server=tianshu
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

- `maxTokens = 128`
- `strictMaxTokens = 48`
- `temperature = 0`
- `limit = 100`
- `cooldownMs = 300`
- `timeoutMs = 300000`

这里的 `maxTokens` 指输出 token 上限，不影响长文章作为输入传入模型。

### Utilities

位置：`sleep`、`ensureDir`、`clearCurrentLine`、`printProgress`、`resolveDataPath`、`shorten`

作用：提供通用辅助能力，比如等待、创建目录、刷新进度行、定位 DROP 数据文件、缩短日志显示文本。

默认数据路径：

```text
../data_sets/DROP/train.jsonl
```

### Dataset Module

位置：`hasNumberType`、`loadDataset`

作用：读取 DROP JSONL 数据，并根据 `answers_spans.types` 判断当前题是数字题还是文本 span 题。

DROP 每条样本通常包含：

```json
{
  "passage": "...",
  "question": "...",
  "answers_spans": {
    "spans": ["..."],
    "types": ["number"]
  }
}
```

### Prompt Module

位置：`buildPrimaryPrompt`、`buildStrictPrompt`

作用：构造统一 DROP prompt。

主请求 prompt：

- 要求只回答当前问题。
- 禁止输出多个候选答案。
- 禁止复述文章、问题、说明或示例。
- 数字题要求只输出数字，不带单位。
- 文本题要求输出短 span，不输出完整解释。
- 最后一行必须是 `Answer: <final answer>`。

严格重试 prompt：

- 只有主输出结构异常时才触发。
- 数字题只要求返回最终数字。
- 文本题只要求返回最短答案短语。

### Network Module

位置：`fetchWithTimeout`、`attachStop`、`buildPayload`、`extractModelText`、`readSseText`、`requestModel`

作用：把统一 prompt 转换成不同服务器需要的请求格式，并把不同响应结构统一成纯文本输出。

支持的 `apiType`：

- `prompt`：请求体使用 `prompt` 和 `max_tokens`，适配 `tianshu` 风格接口。
- `chat`：请求体使用 `messages` 和 `max_tokens`，适配 `/chat/completions`。
- `completion`：请求体使用 `prompt` 和 `n_predict`，适配本地 completion 接口。

### Parsing Module

位置：`cleanModelOutput`、`extractAnswerCandidates`、`selectPrediction`、`needsRetry` 等函数。

作用：清洗模型输出并提取最终答案。

提取逻辑：

1. 清理控制 token，比如 `<|im_end|>`、`<|endoftext|>`。
2. 如果存在 `</think>`，优先使用其后的答案区域。
3. 提取所有显式答案标记，例如 `Answer:`、`The answer is:`、`The final answer is:`。
4. 如果有显式答案标记，优先选择最后一个有效答案。
5. 如果没有显式答案标记，优先选择第一条短候选，适配严格重试直接输出答案的情况。
6. 数字题会从候选中解析数字。
7. 文本题会过滤过长答案和明显无效答案。

### Retry Strategy Module

位置：`askDrop`

作用：统一执行 DROP 请求策略。

流程：

```text
主请求 -> 提取答案 -> 判断输出结构是否异常 -> 必要时严格重试 -> 返回最终预测
```

会触发严格重试的情况：

- 没有提取到答案。
- 没有 `Answer:` 标记。
- 出现多个 `Answer:`。
- 输出包含 `Example:` 或 `... thinking ...` 这类模板污染。
- 数字题提取结果不是数字。
- 文本题答案过长或包含 prompt 痕迹。

### Evaluation Module

位置：`normalizeTextAnswer`、`matchesExpected`

作用：将预测答案和标准答案比较。

判题规则：

- 数字题：解析数字后做严格数值相等。
- 文本题：标准化后完全相等，或预测答案包含标准答案。

注意：数字题不会使用字符串包含匹配，避免把 `10` 错误匹配成 `1`。

### Result Module

位置：`appendJsonl`、`updateDatasetSummary`、`logResult`

作用：输出进度日志，将每题结果写入 JSONL，并在测试结束后更新跨服务器汇总 JSON。

每题记录包含：

- `id`
- `server`
- `api_url`
- `api_type`
- `question`
- `type`
- `expected`
- `prediction`
- `correct`
- `inferenceTimeMs`
- `primaryInferenceTimeMs`
- `error`
- `strategy`
- `output`
- `primaryOutput`

### Main Pipeline

位置：`main`

完整流程：

```text
读取参数 -> 定位 DROP 数据 -> 截取 limit -> 逐题请求模型 -> 提取答案 -> 判题 -> 写 JSONL -> 写 summary
```

## 运行示例

进入目录：

```powershell
cd "C:\Users\zy\Desktop\0420\InfiniBenchmark 0420\InfiniBenchmark\jiuge_uniform"
```

测试 `tianshu`：

```powershell
node drop.js --server tianshu --limit 100
```

测试 `muxi`：

```powershell
node drop.js --server muxi --limit 100
```

测试 `moer`：

```powershell
node drop.js --server moer --limit 100
```

测试 `nvda`：

```powershell
node drop.js --server nvda --limit 100
```

临时指定接口：

```powershell
node drop.js --server moer --api-url http://127.0.0.1:9501/chat/completions --limit 100
```

自定义 completion 接口：

```powershell
node drop.js --server custom --api-url http://127.0.0.1:1145/completion --api-type completion --limit 100
```

如果服务端不支持 `stop`：

```powershell
node drop.js --server tianshu --no-stop --limit 100
```

关闭严格重试：

```powershell
node drop.js --server tianshu --no-retry --limit 100
```

查看帮助：

```powershell
node drop.js --help
```

## 常用参数

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `--server` | 服务器 profile | `tianshu` |
| `--api-url` | 覆盖接口地址 | profile 默认值 |
| `--api-type` | 请求格式：`prompt`、`chat`、`completion` | profile 默认值或按 URL 推断 |
| `--model` | 模型名 | profile 默认值 |
| `--limit` | 测试样本数 | `100` |
| `--max-tokens` | 主请求最大生成 token | `128` |
| `--strict-max-tokens` | 严格重试最大生成 token | `48` |
| `--temperature` | 温度 | `0` |
| `--cooldown-ms` | 样本间隔 | `300` |
| `--timeout-ms` | 单题超时 | `300000` |
| `--data-file` | DROP 数据文件 | `../data_sets/DROP/train.jsonl` |
| `--result-file` | 结果文件路径 | `result/drop_<server>.jsonl` |
| `--stream` | 是否启用 SSE 流式读取 | `false` |
| `--no-retry` | 关闭严格重试 | 默认启用重试 |
| `--no-stop` | 不发送 stop 参数 | 默认发送 stop |

## 结果文件

默认写入：

```text
jiuge_uniform/result/drop_<server>.jsonl
```

示例单题记录：

```json
{
  "id": 1,
  "server": "tianshu",
  "api_url": "http://localhost:9000/chat",
  "api_type": "prompt",
  "question": "...",
  "type": "number",
  "expected": ["3"],
  "prediction": "3",
  "correct": true,
  "inferenceTimeMs": 1234,
  "primaryInferenceTimeMs": 0,
  "error": "",
  "strategy": "primary",
  "output": "...",
  "primaryOutput": ""
}
```

最后一行是 summary：

```json
{
  "summary": true,
  "server": "tianshu",
  "total": 100,
  "correct": 58,
  "accuracy": 58,
  "avgLatencyMs": 1234,
  "errors": 0,
  "retries": 20,
  "number": {
    "total": 75,
    "correct": 39,
    "accuracy": 52
  },
  "span": {
    "total": 25,
    "correct": 19,
    "accuracy": 76
  }
}
```

同时会更新一个数据集级别的跨服务器汇总文件：

```text
jiuge_uniform/result/drop_summary.json
```

这个文件按 server 保存最近一次运行结果，方便横向比较不同服务器的准确率和平均推理时延；DROP 还会额外保留 number/span 分类型准确率和重试次数：

```json
{
  "dataset": "DROP",
  "updatedAt": "2026-04-23T00:00:00.000Z",
  "servers": {
    "nvda": {
      "server": "nvda",
      "api_url": "http://127.0.0.1:1145/completion",
      "api_type": "completion",
      "model": "9g_8b_thinking",
      "total": 100,
      "correct": 58,
      "accuracy": 58,
      "avgLatencyMs": 1234,
      "errors": 0,
      "retries": 20,
      "number": { "total": 75, "correct": 39, "accuracy": 52 },
      "span": { "total": 25, "correct": 19, "accuracy": 76 },
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
node drop.js --server custom --api-url http://host:port/chat/completions --api-type chat
```

## 可靠性注意点

- 不要为了某个服务器单独改 prompt，否则准确率对比会失真。
- 不要为了某个服务器单独改 `maxTokens`、严格重试或温度，否则平均时延和准确率都不可比。
- `apiType` 可以不同，因为它只影响请求格式，不改变测试语义。
- 数字题必须用数值比较，不要用字符串包含匹配。
- 如果某个服务器不支持 `stop` 参数，先用 `--no-stop` 验证接口适配，不要先改提取规则。
