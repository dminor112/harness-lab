/** 协议刻意只允许一轮一个动作，先让状态机和轨迹容易读懂。 */
export type Strategy = 'full' | 'tail' | 'checkpoint';
export type ProviderKind = 'mock' | 'manual' | 'openai' | 'ark';
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export type Action =
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'final'; text: string };
export interface Reply { requestId: string; action: Action }
export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export interface Budget {
  window: number; outputReserve: number; safetyMargin: number;
  toolResultChars: number; recentUnits: number;
}
export const DEFAULT_BUDGET: Budget = {
  window: 16000, outputReserve: 2000, safetyMargin: 1000,
  toolResultChars: 6000, recentUnits: 4,
};
export interface SessionConfig {
  workspace: string; task: string; provider: ProviderKind; strategy: Strategy;
  budget: Budget; maxSteps: number;
}
export interface ContextMetrics {
  estimator: 'heuristic-not-billing'; originalTokens: number; selectedTokens: number;
  inputLimit: number; omittedUnits: number; prunedResults: number;
  selectedEventSeqs: number[]; omittedEventSeqs: number[]; prefixHash: string;
}
export interface ModelRequest {
  id: string; messages: Message[]; metrics: ContextMetrics;
  maxOutputTokens: number; protocol: 'harness-json-action-v1';
}
export interface Usage { inputTokens?: number; outputTokens?: number }
export interface ProviderResult { reply: Reply; usage?: Usage }
export interface ModelProvider {
  name: string;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ProviderResult>;
  /**
   * 可选流式接口：每收到一个文本增量调用一次 onToken。
   * runner 只有在调用方要求实时输出、且 provider 提供该能力时才使用它；
   * 没有该方法的 mock/manual provider 继续走 complete。
   */
  stream?(request: ModelRequest, onToken: (token: string) => void, signal?: AbortSignal): Promise<ProviderResult>;
}
export interface ToolResult { ok: boolean; text: string }
export interface EventData {
  config: SessionConfig;
  /** REPL 中用户追加的一轮输入；首轮任务存在 config.task，不重复写 user。 */
  user: { text: string };
  request: ModelRequest;
  assistant: { requestId: string; action: Action; usage?: Usage; latencyMs: number };
  tool_result: { name: string; requestId: string; result: ToolResult };
  note: { text: string; sourceRequestId: string };
  proposal: { requestId: string; path: string; beforeHash: string; after: string; preview: string };
  approval: { requestId: string; granted: boolean };
  manual_reply: Reply;
  stop: { reason: string; text: string };
  error: { code: string; message: string };
}
export type EventType = keyof EventData;
export type LogEvent = { [K in EventType]: { seq: number; at: string; type: K; data: EventData[K] } }[EventType];
export interface HistoryUnit { seqs: number[]; messages: Message[] }
export class AwaitingManualReply extends Error {
  constructor(public readonly request: ModelRequest) { super('等待手动模型回复'); }
}
export class ContextOverflow extends Error {
  constructor(message: string) { super(message); this.name = 'ContextOverflow'; }
}
