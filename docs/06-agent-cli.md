# 常驻 REPL 与流式输出

`npm run agent` 现在是常驻入口：启动后保持一个进程，连续输入任务，同一个会话保留之前的对话和工具轨迹。模型支持 SSE 时，回复会逐 token 打印；流结束后仍然做严格 JSON 校验，再执行工具。

## 快速开始

先加载模型环境变量；程序不会自动读取 `.env`：

```bash
cd /Users/bytedance/workspace/harness-lab
set -a; source .env; set +a
```

一次性 fixture 上启动 REPL：

```bash
npm run agent -- --provider openai --example
```

会看到首轮任务、每一步上下文指标、流式 JSON、工具结果和最终结果。之后出现：

```text
你>
```

直接输入下一轮任务即可。首轮任务来自 `--example` 的默认任务，也可以自己传：

```bash
npm run agent -- --provider openai "\
  先阅读 sum.mjs 和测试，再修复加法错误；\
  修改前说明根因，修改后运行测试"
```

指定工作区：

```bash
npm run agent -- --provider openai \
  --workspace /path/to/disposable/repo
```

不带任务启动时，会先提示 `首轮任务>`。

## 首轮之外：REPL 命令

| 输入 | 行为 |
| --- | --- |
| 普通文本 | 追加为一轮 `user` 事件，继续当前会话 |
| `/status` | 查看会话路径、事件数、当前轮任务和状态 |
| `/new` | 结束当前会话，提示新会话首轮任务；`--example` 会新建干净 fixture |
| `/help` | 显示 REPL 命令 |
| `/exit`、`/quit` | 退出 |

同一个会话中，之前的 `user`、`assistant`、`tool_result` 会进入下一次上下文编译；`checkpoint` 策略仍然只保留近期完整单元和模型笔记，旧原文可用 `history_search` / `history_read` 恢复。当前轮任务只放在 `currentTask` 消息里，不会在历史中重复出现。

`/new` 是干净上下文，不复用旧会话的事件日志；需要保留旧轨迹时不要用 `/new`。

## 流式是怎么工作的

- OpenAI-compatible provider 发送 `stream: true`，读取 SSE 的 `delta.content`；
- 每来一段文本就写到 stdout，看起来像模型正在逐字输出；
- 流结束后把完整 content 交给 `parseReply` 做严格 JSON 校验；
- 校验通过后才追加 `assistant` 事件、执行工具；
- 中途断流、`finish_reason=length` 或 JSON 不完整都会失败，不会边流边执行副作用。

终端里看到的原始 JSON 是模型动作；后面的 `[step] read_file → ok` 和工具结果才是本地 harness 真正执行的部分。

GLM 实测在 `max_tokens=2000` 时会把较长的工具 JSON 截断；provider 会在剩余上下文允许时把 `max_tokens` 提到最多 4096，同时不超过输入预算与输出预留之和。上下文上限仍由 `--window` 和 `budget` 控制。

## 编辑与测试确认

流式不会绕过安全门禁：

- 模型提出 `propose_edit` 时，终端打印旧/新片段，输入 `y` 才落盘；
- 批准后如果文件 hash 已变化，拒绝覆盖，要求重新读取和提案；
- `run_tests` 单独确认，测试代码不是 OS 沙箱；
- 非 TTY 环境默认拒绝批准，避免 CI 自动执行。

输入 `y` 或 `yes` 批准；其他输入（包括直接回车）都是拒绝。

## 单轮模式

只想跑一轮、不进入后续对话：

```bash
npm run agent -- --provider openai --example --oneshot
npm run agent -- --provider openai --oneshot --workspace /path --task "任务"
```

`--oneshot` 仍会跑完整的“模型动作 → 工具 → 编辑审批 → 测试审批 → 最终结果”，只是结束后退出。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--workspace` | 工作区，默认当前目录 |
| `--provider` | `openai`、`ark`、`mock`；默认 `openai` |
| `--strategy` | `full`、`tail`、`checkpoint`；默认 `checkpoint` |
| `--window` | 上下文窗口粗估，默认 16000 |
| `--max-steps` | 每轮最大动作次数，默认 30 |
| `--task` | 首轮任务文本；也可用位置参数 |
| `--example` | 创建一次性 sum fixture 工作区 |
| `--oneshot` | 跑完首轮退出 |

公网智谱 GLM 用 `--provider openai`。`--provider ark` 是内部 Ark 的标签，不要把公网 endpoint 标成内部 Ark。

## 失败后怎么办

先看终端里的会话路径：

```bash
npm run lab -- inspect --session /absolute/session/path
```

- HTTP/协议错误没有写入 assistant 时，通常可以直接输入下一轮重试；
- 如果提示“检测到未完成的工具动作”，不要重试，使用 `/new` 或人工核查文件/测试状态；
- 需要接着原会话的审批状态，仍可用：

```bash
npm run lab -- continue --session /absolute/session/path
```

## 当前限制

- 没有原生 `tool_calls`，模型仍输出文本 JSON；
- 没有通用 shell，测试固定为 `node --test test.test.mjs`；
- 没有 OS 沙箱、DLP 或通用秘密扫描；
- 流式只打印 `content`，不展示 `reasoning_content`；
- 只适合公开练习代码；公网模型不要把公司内部代码发过去。
