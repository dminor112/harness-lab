import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session } from './session.js';
import { parseReply, record } from './protocol.js';
import { AwaitingManualReply } from './types.js';
import type { ModelProvider, ModelRequest, ProviderResult, Usage } from './types.js';

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

  /**
   * 统一构造请求。stream=true 时设置 OpenAI SSE 的 stream 字段；
   * 不发送 stream_options，避免部分兼容端点直接拒绝未知字段。
   */
  private async post(request: ModelRequest, signal: AbortSignal | undefined, stream: boolean): Promise<Response> {
    const timeout = AbortSignal.timeout(120000);
    // 实测 GLM 在 2000 max_tokens 下会把较长的工具 JSON 截断（finish_reason=length）。
    // 给 4096 地板，但不超过“输入预算 + 输出预留 - 已选上下文”的剩余空间，
    // 避免在接近窗口上限时把请求推过模型总上下文。
    const available = request.metrics.inputLimit + request.maxOutputTokens - request.metrics.selectedTokens;
    const maxTokens = Math.max(request.maxOutputTokens, Math.min(4096, available));
    return fetch(this.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        max_tokens: maxTokens,
        temperature: 0,
        ...(stream ? { stream: true } : {}),
      }),
    });
  }

  /** 非流式完整回复；保留给测试、mock 对照和不支持流式的调用路径。 */
  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ProviderResult> {
    const res = await this.post(request, signal, false);
    // 不记录提供商完整错误响应，避免日志泄露 key/header；也不重试未知执行结果。
    if (!res.ok) throw new Error(`模型 HTTP ${res.status}，未自动重试；请检查正式接口与配额`);
    const data = record(await res.json(), 'model response');
    const choices = data.choices;
    if (!Array.isArray(choices) || !choices[0]) throw new Error('模型没有返回 choices');
    const content = record(record(choices[0]).message).content;
    if (typeof content !== 'string') throw new Error('第一版要求文本 JSON 回复，尚不支持原生 tool_calls');
    const usage = this.usage(data.usage);
    return { reply: parseReply(content, request.id), usage };
  }

  /**
   * 流式回复。
   *
   * 模型仍然必须输出完整的 JSON 动作；这里只把 content 增量立刻交给终端，
   * 等流结束后再用 parseReply 做严格校验。这样“看得到 token”与“协议安全”
   * 不会互相替代：中途出现非法 JSON 仍然整轮失败，不会边流边执行工具。
   */
  async stream(request: ModelRequest, onToken: (token: string) => void, signal?: AbortSignal): Promise<ProviderResult> {
    const res = await this.post(request, signal, true);
    if (!res.ok) throw new Error(`模型 HTTP ${res.status}，未自动重试；请检查正式接口与配额`);
    if (!res.body) throw new Error('模型流式响应没有 body');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let usage: Usage = {};
    let finishReason: string | undefined;

    const consume = (block: string): void => {
      for (const line of block.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        let parsed: Record<string, unknown>;
        try { parsed = record(JSON.parse(data), 'stream chunk'); }
        catch { throw new Error('流式响应不是合法 JSON 事件'); }

        const choices = parsed.choices;
        if (Array.isArray(choices) && choices[0]) {
          const choice = record(choices[0], 'stream choice');
          if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
          const delta = record(choice.delta, 'stream delta');
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            content += delta.content;
            onToken(delta.content);
          }
          // reasoning_content 等字段故意不进入协议文本，避免把思考过程拼进 JSON 动作。
        }
        const nextUsage = this.usage(parsed.usage);
        usage = { ...usage, ...nextUsage };
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE 事件以空行分隔；兼容 \n\n 与 \r\n\r\n，允许网络分片任意切开。
        let match: RegExpMatchArray | null;
        while ((match = buffer.match(/\r?\n\r?\n/)) !== null && match.index !== undefined) {
          consume(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match[0].length);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consume(buffer);
    } finally {
      reader.releaseLock();
    }

    if (finishReason === 'length') {
      throw new Error(`模型输出被 max_tokens 截断（内容 ${content.length} 字符）；请缩短本轮任务或提高输出预算`);
    }
    if (!content) throw new Error(`流式响应没有 content${finishReason ? `（finish_reason=${finishReason}）` : ''}；不要用 reasoning 字段冒充最终 JSON`);
    try {
      return { reply: parseReply(content, request.id), usage };
    } catch (error) {
      // 只带内容尾部，方便定位被截断的 JSON；不把整段模型输出塞进错误事件。
      const tail = JSON.stringify(content.slice(-160));
      throw new Error(`${error instanceof Error ? error.message : '流式 JSON 无效'}；流式内容尾部：${tail}`);
    }
  }

  /** 只读取协议允许的 usage 字段，其他提供商私有字段不进入事件日志。 */
  private usage(value: unknown): Usage {
    if (typeof value !== 'object' || value === null) return {};
    const raw = record(value);
    const usage: Usage = {};
    if (Number.isSafeInteger(raw.prompt_tokens) && (raw.prompt_tokens as number) >= 0) usage.inputTokens = raw.prompt_tokens as number;
    if (Number.isSafeInteger(raw.completion_tokens) && (raw.completion_tokens as number) >= 0) usage.outputTokens = raw.completion_tokens as number;
    return usage;
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
