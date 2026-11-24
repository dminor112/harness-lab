# Codex 风格 CLI 用法

`npm run agent` 是给日常练习用的入口：一条命令接收任务，自动跑 Agent 循环，并把每一步的动作、工具结果和最终结果打印到终端。它不是 Codex 的复刻，但把“下任务 → 看过程 → 看结果”的路径做顺了。

## 与 npm run lab 的区别

| 入口 | 适合做什么 |
| --- | --- |
| `npm run lab -- start ...` | 学习状态机：创建会话、暂停、导入、审批、继续 |
| `npm run agent -- "任务"` | 像普通 CLI 一样直接下任务，自动循环到结束或等你审批 |
| `npm run lab -- inspect ...` | 事后看轨迹和上下文指标 |

`agent` 仍然沿用同一套安全门禁：编辑只提案、人工确认后落盘；测试单独确认；最终结果必须区分“有测试证据”和“未验证”。

## 快速开始

先加载模型环境变量；程序不会自动读取 `.env`：

```bash
cd /Users/bytedance/workspace/harness-lab
set -a; source .env; set +a
```

在一次性 fixture 上跑，不会碰你的项目：

```bash
npm run agent -- --provider openai --example
```

指定工作区和任务：

```bash
npm run agent -- --provider openai \
  --workspace /path/to/disposable/repo \
  "修复 sum.mjs 的加法错误，运行测试并说明结果"
```

也可以把任务作为位置参数，默认工作区是当前目录：

```bash
npm run agent -- "先阅读 README，再修复测试失败"
```

不带任务运行时，会进入交互提示：

```bash
npm run agent --
# 任务> ...
```

## 终端里会看到什么

- 每一步的上下文粗估、被丢弃单元数、provider 名称；
- 工具名与 `ok/error`，随后打印工具结果（截断到 1200 字符）；
- 编辑提案的旧/新片段，等待你输入 `y`；
- 测试执行的单独确认，等待你输入 `y`；
- 最终回复，以及 `final-test-verified` / `final-unverified` 的验证状态；
- 会话目录和 `events.jsonl` 路径，方便事后 `inspect`。

示例流程：

```text
[step] step 1 · input≈1044/13000 · omitted=0 · provider=...
  list_files ok: {...}
[step] step 2 ...
  read_file ok: {...}
--- 编辑提案 ---
文件 sum.mjs
--- 旧片段
  return a - b;
+++ 新片段
  return a + b;
应用这个编辑提案？ [y/N] y
...
=== 最终结果 ===
...
验证状态: 最近改动后有成功的测试证据
```

## 参数

| 参数 | 说明 |
| --- | --- |
| `--workspace` | 工作区，默认当前目录 |
| `--provider` | `openai`、`ark`、`mock`；默认 `openai` |
| `--strategy` | `full`、`tail`、`checkpoint`；默认 `checkpoint` |
| `--window` | 上下文窗口粗估，默认 16000 |
| `--max-steps` | 最大动作轮次，默认 30 |
| `--task` | 任务文本；也可用位置参数 |
| `--example` | 创建一次性 sum fixture 工作区 |

`manual` 仍走 `npm run lab` 的人工接力，因为 `agent` 没有实现“导出 request.md → 导入 reply.json”的交互。

## 当前限制

- 没有 token streaming：模型返回完整动作后才打印下一步，不是逐字输出。
- 没有通用 shell：只有文件读取/搜索/提案编辑、固定测试、笔记和历史恢复。
- 测试固定为 `node --test test.test.mjs`，不适合任意 npm 项目。
- 没有 OS 沙箱、DLP 或通用秘密扫描；测试代码仍可能读本机、联网。
- 只适合公开练习代码；当前若接的是公网智谱，不要把公司内部代码发过去。

## 失败后怎么办

先看终端里的会话路径，再运行：

```bash
npm run lab -- inspect --session /absolute/session/path
```

如果是编辑/测试还没决定，可以继续原会话：

```bash
npm run lab -- continue --session /absolute/session/path
```

不要自动重放已中断的工具；项目会在日志里保留“审批已记录但缺少结果”等状态，要求人工核查。
