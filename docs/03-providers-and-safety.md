# 模型接入与安全边界

## 现有 Trae 账号能做什么

你当前只有 Trae 账号／订阅。公开资料尚未确认供自建程序调用账号推理额度的正式 API。项目明确使用 manual 人工接力通路，不访问 Trae 私有接口，不要求你提交登录凭据。

Trae 官方 [模型文档](https://docs.trae.cn/solo_models)讲的是将独立 API 服务接入 Trae；[企业鉴权文档](https://docs.trae.cn/enterprise_authentication)列举了管理权限。二者不能当作独立推理 API 的接入合同。

manual 能学上下文编译、工具循环、暂停／继续、门禁、原始日志。不能做无需人参与的自动 Agent；不能准确归因 Trae 额外上下文、隐藏系统规则、真实缓存及 token 账单。要继续做严谨效果优化，下一步需你取得正式允许的独立模型 API，或给出官方授权 SDK／CLI／网关说明。不要在聊天中提供密钥。

## 以后拿到独立 API

如果是公司内部方舟 Ark，优先看 [公司内部 Ark 接入](05-ark-internal.md)；`--provider ark` 与 `--provider openai` 共用同一个 OpenAI-compatible 适配器。

程序读取进程环境变量，不自动加载 .env。

    export HARNESS_BASE_URL="https://your-authorized-provider.example/v1"
    export HARNESS_MODEL="your-model-id"
    export HARNESS_API_KEY="仅在你自己的终端设置"
    npm run lab -- doctor
    npm run lab -- start --provider openai --example

此适配器的 endpoint 是 Base URL 末尾加 /chat/completions，协议是文本 JSON 动作。使用非流式 request，temperature=0，max_tokens 来自输出预留。需提供方支持相应字段；第一版不偷偷 fallback、不自动重试、不支持原生 tool_calls／reasoning 字段／streaming。你实际选择的模型可能需要后续单独 adapter。

当前只验证了适配器构造边界及本地 HTTP 模拟响应，未验证真实远端模型服务。不要将“适配器代码存在”说成“Trae 已接通”。

独立 API 会发送当前任务、选中的代码片段、模型历史与工具输出。仅用可公开的练习项目，不要把公司内部代码或个人数据发到未获许可的服务。文件名屏蔽不是全面防泄密：普通代码里可能包含硬编码凭据，需你先检查。项目日志同样可能含代码与任务内容，适合本机私有保存，不自动分享。

## 在线评测的明确授权

    npm run eval -- --provider openai --repeats 3 --approve-disposable-fixtures

只有你明确接受 API 计费、fixture 自动改动及测试执行风险后才运行。此命令在新建的一次性 labs/eval-* 下运行，不接受业务仓库路径；只自动批准 sum.mjs 的编辑提案。独立验收重新检查 test.test.mjs 未改变，并再运行测试。

这个开关不是沙箱、不是对未知代码无限授权。测试可能导入模型改写的实现代码，这依然是本机代码执行。更严谨的大规模在线评测必须先实现容器／虚拟机隔离、网络控制和资源限制；本次没有运行在线评测。

## 已有门禁

- 文件只能是已存在的工作区相对路径；拒绝越界、绝对路径、已有 symlink 与明确敏感文件名。
- 无任意 bash／shell；read_file 按行限量，search/list 有数量与深度上限。
- 先成功读文件才允许提案；旧字符串必须唯一精确匹配。
- 模型只能提案，CLI 展示旧／新片段后由你输入 yes；批准时检查文件 hash，陈旧提案不覆盖。
- run_tests 单独人工确认；固定 node --test test.test.mjs，不经过 shell，15 秒超时，不继承 API key 的环境变量。
- maxSteps 与重复动作 guard 约束循环；模型 final 有独立“测试证据”标签。
- 回复 requestId 必须匹配，严格 JSON，拒绝未知字段和旧回复。
- 会话单写者锁；崩溃留下锁或未完成工具时停止，不盲目重放。

## 不能夸大的保证

没有 OS 沙箱。路径检查不能对抗恶意并发替换、硬链接等所有文件系统攻击；用户代码执行仍可能读本机、联网、创建子进程。默认测试入口不适用于任意 npm 项目，需要后续设计被允许的验证命令。

日志 append 不是事务性数据库，没有 fsync／跨文件原子提交／exactly-once。编辑审批、文件写入与 tool_result 在崩溃时可能部分完成；恢复必须先核查，不自动重试。测试超时只处理直接子进程，尚无完整进程组清理。日志中的原文恢复是数据投影，不代表副作用可安全重放。

没有通用的秘密扫描、DLP、提示注入防护证明或多用户隔离。当前工具限制与非可信数据提示只是学习起点。不要把“用得起来”当成“能安全跑生产仓库”。
