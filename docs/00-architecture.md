# 架构与设计取舍

## 设计前提

一个 Code Agent 可以暂时写成：

    Agent = 模型 + Harness

模型负责提出下一步；Harness 负责决定它“看得见什么”、允许它“做什么”、把什么“记成事实”，以及最终“凭什么说完成”。本项目把这几件事拆成可观察、可替换的小组件，而不是先堆功能。

学习重点不是复刻官方全部插件，而是建立以下因果链：

    原始事件 → 当前可见上下文 → 模型动作 → 门禁／工具 → 新事实 → 下一轮上下文

## 组件

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| src/session.ts | 追加事件、序号、恢复、历史检索 | 不决定模型看见多少 |
| src/context.ts | 从事件派生可见历史、裁剪、预算、指标 | 不调用模型，不执行工具 |
| src/protocol.ts | 严格动作格式与请求身份 | 不做语义纠错 |
| src/runner.ts | 请求 → 回复 → 门禁 → 工具 → 下一轮 | 不做 OS 隔离 |
| src/tools.ts | 文件边界、提案、审批、固定测试、笔记 | 不提供通用 shell |
| src/providers.ts | Mock、人工搬运、独立 API 适配 | 不读取 Trae 私有状态 |
| src/cli.ts | 命令、锁、人工确认入口 | 不做多用户服务 |

依赖方向是单向的：tools 依赖 session 与 protocol；runner 依赖 context、session、tools 和 provider；context 只读 session。provider 不知道工具实现的内部细节，只接收已经编译好的请求。

## 事件与请求分离

整个会话只追加一种日志：events.jsonl。事件类型包括 config、request、assistant、tool_result、note、proposal、approval、manual_reply、stop、error。

其中 request 保存当轮真实发送的 messages 与 metrics；它不是一个“可随时重算的视图”，而是模型实际看到了什么的证据。原始 assistant 动作、工具结果和审批也永久保留。

上下文裁剪只影响“下一次由日志派生的 messages”，不会删除原始事件。因此：

- 旧工具结果可以被从当前视图移出，但仍能按 seq 恢复。
- 原始日志不是模型上下文，二者不能混为一谈。
- 恢复原日志是数据投影，不等于安全重放文件写入或测试。

## 一轮的时序

以一次工具动作为例：

1. runner 读取日志，发现没有 pending request，调用 compileContext。
2. compileContext 把 assistant 动作和对应 tool_result 配成不可拆单元，裁剪／选择／注入 checkpoint，检查预算。
3. runner 先 append request，再调用 provider。
4. provider 返回严格 JSON；requestId 必须匹配。
5. runner append assistant 动作。
6. 如果是 final，检查最近一次成功编辑之后是否有通过的测试，记录 stop 与验证标签。
7. 如果是 tool，执行门禁与工具；成功或失败的 tool_result 都 append。
8. 下一轮再从日志编译，而不是在内存里手工拼消息。

这个顺序保证“模型看到的”有持久证据，且中断后能从日志判断停在哪里。

## 上下文编译算法

当前实现是刻意简单的四步：

### 1. 成对化

遍历 assistant 动作：

- final 单独成一个单元。
- tool 动作必须找到同 requestId 的 tool_result，二者成一个单元。
- 找不到结果就拒绝编译；不能在调用和结果之间插入压缩，也不能把未完成副作用当成历史。

### 2. 工具结果裁剪

仅对 tail／checkpoint 策略，把超过 toolResultChars 的工具结果文本按 Unicode 码点保留头 65% 与尾部，插入可恢复的 seq 标记。原始事件不变。

这不是官方 pruner 的等价实现；官方还涉及 surface replacement 与 shadow-price 事件。

### 3. 选择

- full：保留全部单元，不裁剪；超出预算就报错。它是基线。
- tail：只保留最近 recentUnits 个单元；大结果已裁剪。
- checkpoint：同 tail，但当历史被移出时，注入最近 8 条笔记与“笔记可能过期”的警告；原始历史仍可检索。

如果仍超预算，从最旧单元开始移除，但至少保留一个最新完整单元。若一个单元本身过大，或系统／任务本身过大，直接抛 ContextOverflow，不静默截断系统规则、当前任务或最新动作。

### 4. 预算检查

输入上限为：

    inputLimit = window - outputReserve - safetyMargin

所有消息（包括系统规则、工具 schema、当前任务、checkpoint、requestId 提示）都计入粗估。粗估公式是 ASCII 每 3 字符 1 token、非 ASCII 每码点 1 token，再加固定结构开销；它不是 provider tokenizer，也不是账单。

选择结果与 metrics 一起写入 request。这样事后能回答：这一轮原有多大、选了多少、移除了哪些 seq、裁剪了几个结果、前缀哈希是什么。

## 安全与正确性不变量

- 原始日志只追加；上下文裁剪不删除历史。
- 模型可见的内容必须能从日志重建；request 保存实际 messages。
- 工具调用与结果必须成对；未完成时 fail closed。
- 路径必须是已存在的工作区相对路径；拒绝越界、绝对路径、符号链接和明确敏感文件名。
- 编辑只作为提案；批准时校验提案时的 hash；文件被外部改变则拒绝覆盖。
- 提案前必须有一次成功的读取，且读取时的 hash 必须仍匹配当前文件。
- 测试执行单独确认；固定入口，不经过 shell，有超时和输出上限。
- 模型 final 不等于验证成功；只有最近编辑之后的 run_tests 通过，才标记 final-test-verified。**normal CLI 的 verified 只表示固定入口返回 0，不保证测试文件本身未被批准修改；scripts/evaluate.ts 另做 testUnchanged 检查，生产级验证应使用 Agent 不可修改的独立测试与隔离环境。**
- 单写者锁；崩溃留下的锁、审批记录或未完成工具不自动重放。
- provider 错误不记录完整远端响应；不把 API key 写进日志。

## 已知边界

这不是生产级 harness：

- 没有 OS 沙箱、网络隔离、资源配额或多用户隔离。
- 日志没有 fsync／事务／跨文件原子提交，不能承诺 exactly-once。
- 测试超时只杀直接子进程，未清理整个进程组。
- 路径检查不能对抗所有并发文件系统攻击。
- 没有通用秘密扫描、提示注入防护证明或企业 DLP。
- 固定测试入口只适用于本项目 fixture，不是任意仓库 runner。
- 没有原生 tool_calls、streaming、自动摘要、向量检索、多 Agent。
- 没有真实缓存命中测量；prefixHash 只是输入前缀的哈希。

这些边界是下一阶段的学习对象，不应该在演示中被省略。

## 与官方 DeepSeek Harness 的概念映射

| 本项目 | 官方概念（文档层面） |
| --- | --- |
| events.jsonl + 派生 messages | Session 日志与 deriveMessages |
| request.metrics | token meter／context pressure 的简化观测 |
| historyUnits 成对 | tool-call/result pairing 边界 |
| 工具结果头尾裁剪 | tool-result pruner |
| checkpoint 笔记 | 模型维护的 durable notes／handoff |
| compileContext | prompt assembly + runtime context 的极简版 |
| runner | agent loop 的顺序版 |
| provider | LLM adapter seam |
| 人工审批与固定测试 | approval policy + tool execution pipeline 的学习版 |

映射只说明概念对应，不代表行为等价。官方实现的装配、事务、缓存和失败语义需要读实际源码和测试，本项目没有完整审计。

## 为什么先不做自动摘要

自动摘要会引入新的信息损失和新的失败模式：摘要可能漏约束、把旧状态写成当前事实、在工具批次中间切断、失败后留下半个替换。当前先做确定性的 checkpoint 与可恢复历史，让你先能观察“丢了什么、怎么找回”。等到阶段 5 再实现压缩后端，并用失败反例测试它。

## 为什么先不做多 Agent

多 Agent 会放大上下文隔离、消息传递、权限和成本问题。没有单 Agent 的基线和失败分类时，多 Agent 很容易只是把不确定性藏到另一个上下文里。阶段 7 先建立评测，阶段 8 再比较只读子 Agent 的真实收益。

## 下一步演进顺序

1. 原生 tool_calls／streaming／取消传播。
2. 更细的检索与按需文件加载，记录信息增益。
3. 压缩后端与事务式日志。
4. 容器化工具执行与网络白名单。
5. 更大任务集、重复实验、成本与缓存指标。
6. 最后再映射到 Cordis 插件与官方 harness 扩展点。
