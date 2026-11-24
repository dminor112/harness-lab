# 公司内部方舟 Ark 接入

## 结论

可行。公司内部方舟 Ark 提供 OpenAI-compatible 的 `/chat/completions`，当前项目的 `OpenAIProvider` 可以复用；`ark` 只是同一个适配器的显式入口，不引入 Trae 凭据。真正的前置条件不是代码，而是 Ark 项目、模型开通、在线推理接入点和 API Key。

两条内部路径：

1. **Ark 直连**：在 [字节云方舟控制台](https://cloud.bytedance.net/ark) 创建／加入项目，开通模型，创建在线推理接入点，拿 Endpoint ID 和 API Key。最适合本项目。
2. **ModelHub**：在 [GPT-OpenAPI](https://gpt.bytedance.net/gpt_openapi/model) 先申请“公司内部模型”场景，再接入模型。适合需要统一模型目录／场景审批的情况，但 Base URL 和模型标识与 Ark 不同，不能混用。

## 申请与配置

### 1. 项目与权限

进入 Ark 控制台，确认自己已有可用项目；没有就创建项目并等待审批，或请项目负责人把你加入已有项目。正式项目通常要绑定部门服务树用于结算；体验项目的数据保留期和用途有限，不适合作为长期实验环境。

### 2. 开通模型并创建接入点

在“开通管理”确认目标模型已开通；在“模型推理／在线推理”创建接入点，选择支持 Chat Completions 的模型。创建后确认状态为“健康”，复制接入点 ID（形如 `ep-2026xxxxxxxxxx-xxxxx`）。

### 3. 创建 API Key

在“API Key 管理”创建 Key，立即保存。**Key 与 Endpoint 必须属于同一项目／账户**，否则常见结果是 403。

### 4. 取 Base URL

不要凭公网地址猜。打开该接入点的“API 接入／示例代码”，复制其中的 Base URL。CN 区域内部地址常见为：

    https://ark-cn-beijing.bytedance.net/api/v3

其他区域可能不同。不要混用：

- 公网火山方舟：`https://ark.cn-beijing.volces.com/api/v3`
- Coding Plan：`https://ark.cn-beijing.volces.com/api/coding/v3`

当前适配器会在 Base URL 末尾拼 `/chat/completions`，所以只填到 `/api/v3`。

### 5. 设置环境变量

程序只读进程环境变量，不自动加载 `.env`：

    export HARNESS_BASE_URL="https://ark-cn-beijing.bytedance.net/api/v3"
    export HARNESS_MODEL="ep-你的接入点ID"
    export HARNESS_API_KEY="你的 Ark API Key"

    npm run lab -- doctor
    npm run lab -- start --provider ark --example

`doctor` 会显示 Base URL 的主机名以及 `baseUrlLooksInternalArk`，不会显示 Key。确认三个值都存在后再创建会话；缺值时命令会直接失败，不会创建半配置会话。

## 请求形状

当前适配器发送：

- `POST {HARNESS_BASE_URL}/chat/completions`
- `Authorization: Bearer {HARNESS_API_KEY}`
- `model: {HARNESS_MODEL}`，可填 Endpoint ID 或模型名；建议用 Endpoint ID
- 非流式、`temperature: 0`、`max_tokens` 使用输出预留
- 要求模型返回纯文本 JSON 动作，不使用原生 `tool_calls`

因此，选择模型时优先选指令跟随稳定、支持标准 Chat Completions 的版本；推理模型若把答案放在 `reasoning_content` 而 `content` 为空，当前适配器会失败。这不是 Ark 的问题，是适配器只接受 `message.content` 的边界。

## 常见错误

| 现象 | 优先检查 |
| --- | --- |
| 401 | Key 是否完整、是否有多余空格、是否被禁用 |
| 403 | Key 与 Endpoint 是否同一项目；模型是否开通；接入点是否启用 |
| 404 | Base URL 是否少了 `/api/v3`；Endpoint ID 是否写错；是否误用公网／Coding Plan 地址 |
| 超时 | 内网／VPN 连通性；请求体是否过大；先缩短 messages 重试 |
| 返回不是 JSON | 模型未遵守协议；先换模型或改提示，不要放松 `protocol.ts` 的严格解析 |

## 合规与数据边界

公司 AI 安全 FAQ 的口径是：工作场景调用内部／外部模型接口，应通过 ModelHub 或 Ark 创建使用场景并申请；办公设备上的三方 Agent Harness 使用公司提供的内外部模型（通过 Ark／ModelHub），从制度角度是合规的。这为“自建 Harness 接内部 Ark”提供了政策依据，但不等于可以跳过项目权限、数据分级和沙箱要求。

实践上：

- 只用 L1／已获许可的练习代码；不要把 L4 代码、密钥、个人信息或未脱敏日志发给模型。
- 本项目没有 OS 沙箱、网络隔离、DLP 或通用秘密扫描；模型改写的代码仍会在本机执行测试。
- 日志 `events.jsonl` 和 `request.md` 会包含任务、代码片段与工具输出，按内部数据等级保管，不随意分享。
- 不要把 API Key 写进代码、README、聊天或 Git。

## 什么时候需要新适配器

当前 `ark` 路径足够跑通学习闭环。如果实际接入发现以下情况，再单独加适配器，而不是改坏现有严格协议：

- 必须走字节云多云代理、服务账号 AK/SK 签名（当前只支持 Bearer API Key）；
- 需要流式输出、原生 tool calls、reasoning 字段或自定义网关 headers；
- 需要使用 ModelHub 的非 Ark 风格 Base URL／模型标识。

这些都属于“真实接入后再做”的适配工作，不应在拿到实际接口前预先猜测。

## 参考

- ModelHub—Doubao 模型／字节云方舟模型接入：<https://bytedance.larkoffice.com/wiki/T3GvwdlXqiX5VwksFAcclVQTnqc>
- 火山方舟 API 调用指南（Endpoint ID、API Key、Base URL、错误码）：<https://bytedance.larkoffice.com/docx/BRLhdpcB6oLRdixileBchcA4nPq>
- 内部 CN Base URL 与 Bearer 鉴权：<https://bytedance.larkoffice.com/docx/LBF5dvUZVoo66lxinQOcgP5znAf>
- 方舟 Ark 模型申请指南（个人可创建项目等待审批、20 RPM／200,000 TPM）：<https://bytedance.larkoffice.com/wiki/Z5Jqw2u7uicURAk8cLbc0jdTn5e>
- AI 模型与 AI 应用安全管理规范 FAQ：<https://bytedance.larkoffice.com/docx/HiY3dS6HPoDvCFxzCrvcDIwHnkh>
