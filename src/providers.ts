import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session } from './session.js';
import { parseReply, record } from './protocol.js';
import { AwaitingManualReply } from './types.js';
import type { ModelProvider, ModelRequest, ProviderResult } from './types.js';

/** 固定脚本，仅验证 harness 的闭环。它不证明任何模型编码能力。 */
export class MockProvider implements ModelProvider {
  name = 'scripted-fixture-mock';
  constructor(private session: Session) {}
  async complete(request: ModelRequest): Promise<ProviderResult> {
    const actions = [
      { kind: 'tool', name: 'list_files', args: {} },
      { kind: 'tool', name: 'read_file', args: { path: 'sum.mjs' } },
      { kind: 'tool', name: 'propose_edit', args: { path: 'sum.mjs', old: 'return a - b;', replacement: 'return a + b;' } },
      { kind: 'tool', name: 'run_tests', args: {} },
      { kind: 'tool', name: 'save_note', args: { text: '本 fixture 目标：sum 做加法。已提出改动，需根据 run_tests 的实际结果判定完成，不能由这条 Mock 笔记证明通过。' } },
    ];
    const index = this.session.events.filter(e => e.type === 'assistant').length;
    const result = this.session.events.filter(e => e.type === 'tool_result' && e.data.name === 'run_tests').at(-1);
    const action = actions[index] ?? { kind: 'final', text: result?.type === 'tool_result' && result.data.result.ok ? 'fixture 已完成，run_tests 返回通过。' : 'fixture 未验证通过，请检查测试或审批结果。' };
    return { reply: parseReply(JSON.stringify({ requestId: request.id, action }), request.id) };
  }
}
/** 不读取 Trae 存储、不提取 token、不调用私有端点。由人显式搬运一次模型请求。 */
export class ManualProvider implements ModelProvider {
  name = 'manual-human-relay-not-trae-api';
  constructor(private session: Session) {}
  async complete(request: ModelRequest): Promise<ProviderResult> {
    const imported = this.session.events.find(e => e.type === 'manual_reply' && e.data.requestId === request.id);
    if (imported?.type === 'manual_reply') return { reply: imported.data };
    exportManualRequest(this.session, request);
    throw new AwaitingManualReply(request);
  }
}
export function exportManualRequest(session: Session, request: ModelRequest): void {
  const prompt = [
    '# 手动模型请求（不是 Trae API 接入）',
    '',
    '请新开一个 Trae 对话（建议纯问答、不要允许它运行工具），粘贴本文件内容。',
    '只模拟下面请求中的模型响应。不要用 Trae 的文件工具、终端或内置上下文改写项目。只返回严格 JSON，不要 Markdown 围栏。',
    '这是手动实验：Trae 会额外附加它的系统规则／上下文，所以并非原生 API 等价测试，不能测真实缓存命中与精确 token 成本。',
    '', `当前 requestId：${request.id}`,
    '', ...request.messages.map(m => `## ${m.role}\n${m.content}`),
    '', '## 本次回复格式',
    JSON.stringify({ requestId: request.id, action: { kind: 'tool', name: 'read_file', args: { path: 'sum.mjs' } } }, null, 2),
    '或把 action 改为 {"kind":"final","text":"你的结果"}。只返回一个动作。',
  ].join('\n');
  // 派生视图，可重建；完整 request 在不可变事件中保存。
  writeFileSync(resolve(session.dir, 'request.md'), prompt, { mode: 0o600 });
  if (!existsSync(resolve(session.dir, 'reply.json'))) writeFileSync(resolve(session.dir, 'reply.json'), '{}\n', { mode: 0o600 });
}
/** 独立、正式授权的 OpenAI-compatible endpoint；不是 Trae 订阅复用。 */
export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  constructor(private baseUrl: string, private model: string, private apiKey: string, name = 'authorized-openai-compatible') {
    this.name = name;
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Base URL 不应包含凭据、query 或 fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('非本机 endpoint 需要 HTTPS');
    if (!model || !apiKey) throw new Error('缺少模型名或独立 API key');
  }
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ProviderResult> {
    const messages = request.messages;
    const timeout = AbortSignal.timeout(60000);
    const res = await fetch(this.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, max_tokens: request.maxOutputTokens, temperature: 0 }),
    });
    // 不记录提供商完整错误响应，避免日志泄露 key/header；也不重试未知执行结果。
    if (!res.ok) throw new Error(`模型 HTTP ${res.status}，未自动重试；请检查正式接口与配额`);
    const data = record(await res.json(), 'model response');
    const choices = data.choices;
    if (!Array.isArray(choices) || !choices[0]) throw new Error('模型没有返回 choices');
    const content = record(record(choices[0]).message).content;
    if (typeof content !== 'string') throw new Error('第一版要求文本 JSON 回复，尚不支持原生 tool_calls／流式');
    const usageRaw = typeof data.usage === 'object' && data.usage !== null ? record(data.usage) : {};
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (Number.isSafeInteger(usageRaw.prompt_tokens) && (usageRaw.prompt_tokens as number) >= 0) usage.inputTokens = usageRaw.prompt_tokens as number;
    if (Number.isSafeInteger(usageRaw.completion_tokens) && (usageRaw.completion_tokens as number) >= 0) usage.outputTokens = usageRaw.completion_tokens as number;
    return { reply: parseReply(content, request.id), usage };
  }
}
export function providerFor(session: Session): ModelProvider {
  switch (session.config.provider) {
    case 'mock': return new MockProvider(session);
    case 'manual': return new ManualProvider(session);
    case 'openai': return new OpenAIProvider(process.env.HARNESS_BASE_URL ?? '', process.env.HARNESS_MODEL ?? '', process.env.HARNESS_API_KEY ?? '');
    case 'ark': return new OpenAIProvider(process.env.HARNESS_BASE_URL ?? '', process.env.HARNESS_MODEL ?? '', process.env.HARNESS_API_KEY ?? '', 'ark-internal-openai-compatible');
  }
}
