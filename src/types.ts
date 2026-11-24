/**
 * Harness Lab 的公共类型定义。
 *
 * 设计原则：
 * 1. 模型只能“提议”一个动作，真正执行动作的是本地 harness；
 * 2. 会话状态由追加式事件日志表达，而不是由可变的对象快照表达；
 * 3. 上下文只是对事件日志的一次投影，删减投影不能修改原始历史；
 * 4. 所有跨模块契约都集中在这里，避免 runner、context、provider 各自解释字段。
 */

/** 上下文策略。三者的差异只在“把哪些历史动作放进本次请求”。 */
export type Strategy =
  /** 不裁剪、不丢弃，按完整历史发送；超预算就失败，适合做基线。 */
  | 'full'
  /** 只保留最近若干个完整动作单元；早期事实会离开上下文。 */
  | 'tail'
  /** 保留最近动作单元，并额外注入模型笔记；原日志仍可检索。 */
  | 'checkpoint';

/** 模型提供方类型。mock/manual 用于离线学习，openai/ark 才可能产生真实远端请求。 */
export type ProviderKind = 'mock' | 'manual' | 'openai' | 'ark';

/** 暴露给模型的工具声明。parameters 使用 JSON Schema 子集，仅用于描述，不承担执行期校验。 */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * 模型每轮只能返回一个动作。
 *
 * - tool：请求本地执行一个工具；必须等 tool_result 写入后才能进入下一轮；
 * - final：模型认为任务结束；是否“已验证”由 runner 根据测试事件另行判断。
 */
export type Action =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'final'; text: string };

/** 模型回复的外层信封。requestId 用来拒绝旧回复、串会话回复和重放。 */
export interface Reply {
  requestId: string;
  action: Action;
}

/**
 * 发送给模型的消息。
 *
 * 这里刻意不使用 OpenAI 原生 tool/function 消息，而是把工具调用与结果都编码成
 * assistant/user 文本。这样协议在 mock、manual、真实 API 三条通路上完全一致，
 * 也方便把“模型看到的上下文”原样写入事件日志。
 */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * 上下文预算，单位是“启发式 token”，不是账单 token。
 *
 * window：模型上下文窗口的粗估上限；
 * outputReserve：预留给模型输出的 token；
 * safetyMargin：独立安全余量，抵消 estimator 与真实 tokenizer 的偏差；
 * toolResultChars：单个工具结果在进入上下文前允许保留的字符数；
 * recentUnits：tail/checkpoint 保留的最近完整动作单元数。
 */
export interface Budget {
  window: number;
  outputReserve: number;
  safetyMargin: number;
  toolResultChars: number;
  recentUnits: number;
}

/** 学习项目的默认预算。真实模型接入后应按模型窗口和实测偏差调整。 */
export const DEFAULT_BUDGET: Budget = {
  window: 16000,
  outputReserve: 2000,
  safetyMargin: 1000,
  toolResultChars: 6000,
  recentUnits: 4,
};

/** 创建一个会话时写入首条 config 事件的不可变配置。 */
export interface SessionConfig {
  workspace: string;
  task: string;
  provider: ProviderKind;
  strategy: Strategy;
  budget: Budget;
  maxSteps: number;
}

/**
 * 本次上下文编译的观测指标。
 *
 * estimator 固定标记为 heuristic-not-billing，提醒读者：
 * 这些数字不能直接对账，也不能当作模型真实 token 用量。
 */
export interface ContextMetrics {
  /** 估算方法标识；目前只有启发式估算。 */
  estimator: 'heuristic-not-billing';
  /** 未裁剪完整历史 + 系统规则 + 任务的估算 token。 */
  originalTokens: number;
  /** 实际选中并发送的消息估算 token。 */
  selectedTokens: number;
  /** window - outputReserve - safetyMargin 后的输入上限。 */
  inputLimit: number;
  /** 因策略或预算被丢弃的完整动作单元数。 */
  omittedUnits: number;
  /** 被头尾裁剪过的工具结果数。 */
  prunedResults: number;
  /** 本次实际进入上下文的原始事件 seq，用于审计“模型到底看到了什么”。 */
  selectedEventSeqs: number[];
  /** 被投影丢弃的事件 seq；原始日志仍在，可用 history_read 恢复。 */
  omittedEventSeqs: number[];
  /** 稳定系统提示的哈希，用于观察前缀是否变化。 */
  prefixHash: string;
}

/** 一次待发送的模型请求。它本身也会作为 request 事件写入日志。 */
export interface ModelRequest {
  id: string;
  messages: Message[];
  metrics: ContextMetrics;
  maxOutputTokens: number;
  /** 协议版本；目前只支持严格 JSON 动作协议。 */
  protocol: 'harness-json-action-v1';
}

/**
 * 模型返回的用量。字段可选：
 * - 没返回 usage 不等于 0，而是“未知”；
 * - provider 只在字段是非负安全整数时才采纳。
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
}

/** provider 的统一返回：已解析的动作 + 可选用量。 */
export interface ProviderResult {
  reply: Reply;
  usage?: Usage;
}

/** 模型适配器接口。所有 provider 都必须返回同一套 Reply，runner 不关心底层是 mock 还是 HTTP。 */
export interface ModelProvider {
  name: string;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ProviderResult>;
}

/** 工具执行结果。失败也作为正常结果回灌模型，而不是让进程崩溃。 */
export interface ToolResult {
  ok: boolean;
  text: string;
}

/**
 * 事件日志的 data 负载表。
 *
 * 每个 key 对应一种事件类型，value 是该类型的事件数据形状。
 * 事件类型只增不改，恢复时按 seq 重放/投影。
 */
export interface EventData {
  /** 会话第一条事件，保存不可变配置。 */
  config: SessionConfig;
  /** 本次发送给模型的完整请求与上下文指标。 */
  request: ModelRequest;
  /** 模型返回的动作；latencyMs 是本机观测到的耗时。 */
  assistant: { requestId: string; action: Action; usage?: Usage; latencyMs: number };
  /** 工具执行结果；requestId 必须对应一次 assistant 工具动作。 */
  tool_result: { name: string; requestId: string; result: ToolResult };
  /** 模型维护的阶段笔记，checkpoint 策略会注入最近若干条。 */
  note: { text: string; sourceRequestId: string };
  /** 编辑提案：只记录 beforeHash/after，不立即写文件。 */
  proposal: { requestId: string; path: string; beforeHash: string; after: string; preview: string };
  /** 人工审批结果；每个 requestId 只允许一条。 */
  approval: { requestId: string; granted: boolean };
  /** manual 通路导入的模型回复。 */
  manual_reply: Reply;
  /** 终止事件；reason 说明是正常结束、未验证结束还是异常停止。 */
  stop: { reason: string; text: string };
  /** 可恢复/不可恢复错误的摘要；不记录密钥和完整远端响应。 */
  error: { code: string; message: string };
}

/** 所有事件类型名的联合。 */
export type EventType = keyof EventData;

/**
 * 日志中的一条事件。
 *
 * 用映射类型把 type 与 data 绑定，避免出现 type=note 却写 proposal 数据的错误。
 */
export type LogEvent = {
  [K in EventType]: { seq: number; at: string; type: K; data: EventData[K] }
}[EventType];

/**
 * 一个“完整动作单元”：
 * - tool 动作：assistant 调用 + 对应 tool_result，两条 seq 必须成对；
 * - final 动作：只有 assistant 一条。
 *
 * 压缩时只能按单元丢弃，不能把调用和结果拆开，否则模型会看到悬空调用。
 */
export interface HistoryUnit {
  seqs: number[];
  messages: Message[];
}

/** manual provider 在导出请求后抛出，runner 据此把会话停在 awaiting-model。 */
export class AwaitingManualReply extends Error {
  constructor(public readonly request: ModelRequest) {
    super('等待手动模型回复');
  }
}

/** 上下文装不下时抛出。runner/CLI 不静默截断，而是让调用方显式处理。 */
export class ContextOverflow extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContextOverflow';
  }
}
