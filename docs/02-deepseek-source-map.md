# DeepSeek 官方源码对照：证据边界明确的阅读起点

参考对象：DeepSeek-AI 官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，锁定 revision：4b399c39a6d1479cd84ca591b4d7c88e24d38a96。

**范围：精选文档与三个压缩入口源码的只读调查，不是官方运行时完整审计。** Git 的 partial clone 在 checkout 时网络报错，upstream 目录不是完整可用 checkout。可用的版本锁定资料在 reference/；sources.json 记录每个原路径与下载 URL。不要从不完整 upstream 运行官方项目。本学习项目不依赖它。

## 证据矩阵

| 阶段 | literal locator | 观察内容 | 主张范围与裁决 |
| --- | --- | --- | --- |
| 架构文档 | docs/architecture.md:55–65,132–138 | 列出 Session、SystemPrompt、Tools、AgentLoop、LLM seam；说明日志与 deriveMessages | confirmed（官方文档描述）；未独立运行官方循环 |
| 预算预留 | packages/compaction/compaction-basic/src/index.ts:68–69 | reservedCompletionTokens 使用 header cap 或 adapter 默认 | confirmed（此局部函数） |
| 可选注册 | 同文件:145–149,162–189 | config.auto 才注册；pre-step 调用 compactIfNeeded | conditional（源码分支）；当前产品配置是否启用 unknown |
| 压力触发 | 同文件:333–388 | resolveModelInfo、resolveCompactSpec；超过阈值后可先 prune、重测，再 selectCompactableRange、compactRegion | confirmed（入口调用关系）；callee 的具体边界语义未全读 |
| 溢出错误分类 | 同文件:228–271 | 只匹配 CONTEXT_WINDOW_EXCEEDED_CODE；检查恢复次数与 replaceGeneration | confirmed（条件和返回分支）；端到端 retry 的执行效果 unknown |
| 裁剪文本 | packages/compaction/compaction-tool-result-pruner/src/index.ts:83–121 | Unicode 码点 head/marker/tail；检查结果缩小且低于阈值 | confirmed（局部变换） |
| 裁剪写入 | 同文件:136–181 | 快照候选；调用 session.append 写 prune 与 replacement，附 sourceEventSeqs | confirmed（调用）；持久化／重放结果 unknown，未读实际 Session.append callee |
| 压缩事务 | docs/subsystems/compaction.md:9–21,99–103 | 文档描述 start/summary/replacement/end、成对边界、错误类 | confirmed（文档契约）；region.ts 和 summarizer.ts 实现未审计 |
| token meter | packages/llm/token-meter/README.md:28–49,143–146 | 文档说明确定性估计、route 和相同 envelope usage 锚定 | confirmed（文档）；未审计真实估算器及所有 adapter |

原始 locator 对应 reference/ 中双下划线命名文件。最重要的判断：**文档、实现存在、当前装配选中、真实运行效果是四类不同证据。**

## 最短阅读链

架构文档 → Session 可见历史 → 请求组装 → token meter → compaction-basic 的触发入口 → region／summarizer 的实际实现 → pruner → 官方真实测试／应用装配。

本次只到“明确定位入口和精选局部变换”的层次，没有把 region／summarizer／Session 的实现审计伪装成已经完成。

## 与本学习项目的对应

| 主题 | 官方参考起点 | Harness Lab |
| --- | --- | --- |
| 完整事实与可见历史分离 | Session 与 deriveMessages 文档 | src/session.ts 追加原日志；context.ts 编译派生请求 |
| 稳定系统规则与 tool schema | system-prompt／agent-loop 文档 | context.ts 的稳定头部；无动态插件装配 |
| 工具大结果治理 | compaction-tool-result-pruner | context.ts 的纯请求视图裁剪；原日志不改 |
| 调用／结果完整性 | compaction seam pairing 文档 | historyUnits 一个动作／结果成对，未完成直接拒绝 |
| 压缩及路由 | compaction-basic + region + summarizer | 当前只做 notes + recent tail；自动摘要未实现 |
| token 计量 | token-meter | 当前独立启发式，不是官方公式复制，也不沿用 provider 锚定 |
| 多插件替换 | Cordis services/events | 简单接口＋依赖注入；暂不复刻 Cordis |

### 效果责任闭合卡（学习项目特定测试范围）

对象／范围：src/context.ts 在 tests/core.test.ts 所列 fixture 的编译。

触发者：runner.ts 调用 compileContext。

当前选择：session.config.strategy；full、tail 或 checkpoint。

执行者：historyUnits、prune、compileContext。

观察点：request.metrics、实际 messages；测试核对预算、工具对和笔记标记。

失败检查：未完成工具或超预算抛错；不静默丢最新单元。runner／CLI 返回错误，不将失败写成成功。

重试／重放：本项目不自动重放工具；原日志重开是数据恢复，不是副作用重放。

不能覆盖：真实模型理解、API 序列化精确 token、缓存命中、并发恶意文件替换、崩溃原子性、官方生产运行。

status：confirmed（已运行本项目测试范围）；其他效果 unknown／未实现。

## 未知与下一验证

1. 官方实际 preset 是否启用哪种 compaction backend：读取 bundle／preset 当前配置，再在一次性环境 dump-config；不能从包存在推断。
2. region.ts 如何处理摘要失败、取消与范围变化：下载同 revision 的实际 callee 与单测，追到 Session.append 和 flush 的实现。
3. token meter 如何复用 provider usage：读 estimate／measurement projection／adapter dispatch，并与真实 provider reported counts 比对。
4. 自建策略是否改善模型：完成统一任务集和真实模型对照；当前 Mock 和标记实验都不能回答。

## 原始来源

- [官方产品说明](https://deepseek.com/harness/en/)
- [官方仓库](https://github.com/deepseek-ai/deepseek-harness)
- [锁定架构文档](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/architecture.md)
- [锁定压缩文档](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/docs/subsystems/compaction.md)
- [锁定压缩入口](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/compaction/compaction-basic/src/index.ts)
- [锁定裁剪实现](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/4b399c39a6d1479cd84ca591b4d7c88e24d38a96/packages/compaction/compaction-tool-result-pruner/src/index.ts)

以上资料作为源码学习参考；reference/LICENSE 保留官方 MIT 许可证。本项目的实现不是复制这些源码。
