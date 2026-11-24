# Harness Lab：从零学习 Code Agent

这是一个**学习用的小型 TypeScript 项目**，不是完整 DeepSeek Harness 的复刻，也不是生产级编码助手。主要目标是能解释和验证：每次请求为什么带这些上下文、哪些信息被移出、如何恢复、改策略后效果有没有变化。

## 当前接入状态

- 只有 Trae 账号／订阅；尚未确认可供第三方程序直接调用该额度的官方推理接口。
- 已实现 **manual**：导出一次请求 → 你在 Trae 新对话提交 → 保存 JSON 回复 → 导入 → 本地 Agent 执行。这是人参与的模型适配器，**不是直连 Trae，也不等价于干净的 API 请求**。
- 已实现 **mock**：固定脚本用于跑通工具与状态机，不代表模型能力。
- 已实现 **ark**：公司内部方舟 Ark 的 OpenAI-compatible 入口；需要你自己的 Ark 项目、在线推理接入点、Endpoint ID 和 API Key。**尚未实跑**，配置步骤见 [公司内部 Ark 接入](docs/05-ark-internal.md)。
- 已实现独立 OpenAI-compatible 文本 JSON 适配器；只在拿到正式许可的 Base URL、模型名和 API Key 后使用。**目前未做真实远端连通验证**。
- 不提取 Trae Cookie、登录 token、钥匙串或应用配置；不复用私有接口。

公司内部 Ark 是比“直连 Trae 账号”更明确的合规路径：按公司 AI 安全 FAQ，办公设备上的三方 Agent Harness 使用方舟／ModelHub 提供的模型，从制度角度是合规的；但仍要遵守项目权限、数据分级和沙箱要求。

Trae 官方文档介绍的是“向 Trae 添加自定义模型”，不是向第三方程序导出账号推理额度：[模型文档](https://docs.trae.cn/solo_models)。现有企业 [鉴权文档](https://docs.trae.cn/enterprise_authentication)列举管理权限，不能据此推导存在个人订阅推理 API。这里是“尚未确认”，不是断言全球不存在。

## 5 分钟开始

在终端进入本项目目录，执行：

    npm ci --ignore-scripts
    npm test
    npm run demo

本机已安装依赖并构建。换机器后先运行 npm ci --ignore-scripts。demo 会创建一个新的一次性 sum 练习目录，运行到“编辑审批”暂停。它不会修改 fixtures 原件或其他业务仓库。

当前离线验证结果：strict TypeScript 检查通过；13 项测试全部通过；Mock 的 6 次任务／策略闭环都通过；上下文实验中 full 因预算失败，tail／checkpoint 能装下，checkpoint 保留了预置的早期事实标记。**这些都不是真实模型能力或效果提升的证据**，详见 examples/README.md。

继续用输出的会话路径：

    npm run lab -- approve --session /absolute/path/to/session

查看旧／新片段，输入 yes 才落盘。随后运行测试还会单独要求确认。完成后用 inspect 看轨迹：

    npm run lab -- inspect --session /absolute/path/to/session

如果在非交互终端执行，默认不批准。没有自动 yes 选项。

## 用你现有 Trae 账号练习

    npm run lab -- start --provider manual --example

程序创建独立练习目录并暂停。按输出位置打开 request.md：

1. 在 Trae 新开一个对话，尽量选择纯问答，禁用自动文件／终端工具，不让 Trae 直接修改练习目录。
2. 复制 request.md 的完整内容。让它只返回一个严格 JSON 动作，不带 Markdown 围栏。
3. 将回复保存到该会话的 reply.json（不要改 requestId）。
4. 导入回复：

       npm run lab -- import --session /absolute/session/path --reply /absolute/session/path/reply.json

5. 程序会执行一个动作，然后再导出下一份 request.md；重复新开 Trae 对话与导入。遇到编辑提案用 approve，直到模型 final。

**为什么每次新开对话？** 避免 Trae 自己的旧对话历史叠加在我们编译的上下文上。但 Trae 仍有自己的系统规则、工具 schema 和额外注入，因此这条通路只能做定性学习，不能测干净 API 的上下文占用、前缀缓存或真实自动循环性能。若你不愿意搬运，离线 Mock 也能先学核心机制；完整自主推理闭环仍待正式 API。

不在聊天里发密钥。独立 API 接入、限制与评测授权说明见 [接入与边界](docs/03-providers-and-safety.md)。

## 接公司内部方舟 Ark

先拿到四个值：项目、在线推理接入点、Endpoint ID（`ep-...`）、API Key。Base URL 从接入点的 API 示例复制；CN 区域内部地址常见为 `https://ark-cn-beijing.bytedance.net/api/v3`，不要填公网 `ark.cn-beijing.volces.com` 或 Coding Plan 的 `/api/coding/v3`。

    export HARNESS_BASE_URL="https://ark-cn-beijing.bytedance.net/api/v3"
    export HARNESS_MODEL="ep-你的接入点ID"
    export HARNESS_API_KEY="你的 Ark API Key"

    npm run lab -- doctor
    npm run lab -- start --provider ark --example

`doctor` 会显示 Base URL 主机名，并标记它是否像内部 Ark 地址；不会显示 Key。若返回 401／403／404，先核对 Key 与 Endpoint 是否同一项目、接入点是否“健康”、模型是否已开通、Base URL 是否少了 `/api/v3`。完整步骤见 [公司内部 Ark 接入](docs/05-ark-internal.md)。

## 学什么、怎么验收

推荐阅读顺序：README → docs/00-architecture.md → docs/04-first-lab.md → docs/01-learning-roadmap.md → docs/02-deepseek-source-map.md → docs/03-providers-and-safety.md。第一讲是 [动手练习 01](docs/04-first-lab.md)。建议每次只改一个策略，读少量源码 → 做一个改动 → 看轨迹 → 做一个反例测试 → 写结论。

推荐 8 个小阶段：

1. 最小模型／工具循环与停止条件。
2. 事件日志与恢复：历史事实不等于当前上下文。
3. 上下文预算、工具输出裁剪、完整动作单元。
4. checkpoint、笔记保真、旧历史定向恢复。
5. 模型生成的结构化摘要与失败回退（练习任务，**尚未实现**）。
6. 代码检索、按需加载、前缀稳定性。
7. 统一任务集、独立测试和消融评测。
8. 重试／验证／权限／多 Agent 的必要性实验，再考虑官方插件迁移。

## 运行实验

    npm run experiment
    npm run eval

experiment 用长工具结果模拟上下文压力，对照 full／tail／checkpoint。它检查“早期事实标记是否仍在输入里”，**不调用模型、不验证模型真的使用了事实**。checkpoint 笔记由 fixture 预先写入，不证明模型能可靠写摘要。

eval 默认只有 Mock：两种 sum 任务 × 三种策略。它使用真实文件编辑和 Node 测试，但动作由固定脚本提供。结果中未知 API token 数是 null，不是 0；成功率不能对外表述为真实模型能力。

真实效果优化至少要：同一模型、同一任务与代码起点、相同动作预算、多次重复、独立测试、记录失败；详细方案见学习路线第 7 阶段。此小任务集不是 SWE-bench，短任务不能证明长程上下文策略的收益。

## 文件地图

| 文件 | 职责 |
| --- | --- |
| src/types.ts | 协议、事件类型、预算、适配器边界 |
| src/protocol.ts | 严格 JSON 动作验证，拒绝旧请求与未知字段 |
| src/session.ts | 单写者追加日志、恢复、历史检索 |
| src/context.ts | 日志 → 成对单元 → 裁剪／选择 → 请求与预算指标 |
| src/providers.ts | Mock、人工搬运、独立 API 的模型适配层 |
| src/tools.ts | 受限文件工具、提案审批、固定测试、笔记与历史恢复 |
| src/runner.ts | 顺序 Agent 循环、暂停、重复动作停止、验证证据标签 |
| src/cli.ts | 命令入口、单写者锁、人工确认 |
| tests/core.test.ts | 协议、上下文、门禁与端到端反例测试 |
| scripts/context-experiment.ts | 不依赖模型的上下文机制实验 |
| scripts/evaluate.ts | 一次性 fixture 内的对照评测 |
| reference/ | 锁定版本的官方文档／精选源码、MIT 原许可证 |
| examples/ | 本次离线实验结果及读法，可重跑更新 |
| docs/ | 架构、学习路线、源码对照、接入边界、第一讲、公司内部 Ark |

运行时数据在 .harness/sessions，练习工作区在 labs。request.md 可重建，reply.json 是你填写的模型回复，events.jsonl 保留原始事件及实际发送的 messages。

## 第一版刻意不做

无通用 shell、无 Web UI、无并行工具、无自动摘要、无原生 tool_calls／streaming、无向量库、无多 Agent、无可靠分布式日志、无自动崩溃副作用重放、无 OS 沙箱。只对已存在且已读的普通文本文件做唯一精确替换；固定测试入口是 test.test.mjs。

normal CLI 的 final-test-verified 只表示固定测试入口返回 0，不保证测试文件未被批准修改；scripts/evaluate.ts 另做 testUnchanged 检查。严谨验证应使用 Agent 不可修改的独立测试与隔离环境。

这是学习时的范围控制，不是终点。先理解和测量，再引入复杂性。
