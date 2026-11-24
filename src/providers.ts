/**
 * 模型适配层。
 *
 * 三条通路共享同一个 ModelProvider 接口：
 * - MockProvider：固定脚本，验证工具循环/审批/测试标签，不证明模型能力；
 * - ManualProvider：把请求导出成 request.md，由人复制到 Trae，再导入 reply.json；
 * - OpenAIProvider：正式授权的 OpenAI-compatible HTTP endpoint（含公司内部 Ark）。
 *
 * 这里的原则是“适配器只做传输和协议解析，不偷偷重试、不猜工具调用、不记录密钥”。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Session } from './session.js';
import { parseReply, record } from './protocol.js';
import { AwaitingManualReply } from './types.js';
import type { ModelProvider, ModelRequest, ProviderResult } from './types.js';

/**
 * 固定脚本 provider。
 *
 * 它按“已产生多少个 assistant 事件”决定下一步动作，因此可以反复 continue：
 * list → read → propose_edit（暂停）→ run_tests → save_note → final。
 *
 * 注意：Mock 的 note 和 final 文本只是 fixture 行为，不能拿来证明代码正确；
 * 是否通过只以 run_tests 的真实 tool_result 为准。
 */
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

    // 用 assistant 事件数作为脚本游标；request 事件不参与，避免重试时错位。
    const index = this.session.events.filter(e => e.type === 'assistant').length;
    const result = this.session.events.filter(e => e.type === 'tool_result' && e.data.name === 'run_tests').at(-1);

    const action = actions[index] ?? {
      kind: 'final',
      text: result?.type === 'tool_result' && result.data.result.ok
        ? 'fixture 已完成，run_tests 返回通过。'
        : 'fixture 未验证通过，请检查测试或审批结果。',
    };

    // 仍然走 parseReply，确保 Mock 和真实 provider 遵守同一套严格协议。
    return { reply: parseReply(JSON.stringify({ requestId: request.id, action }), request.id) };
  }
}

/**
 * 人工接力 provider。
 *
 * 它不读取 Trae 的 Cookie/token/钥匙串，也不调用私有端点。complete() 第一次调用时：
 * 1. 把编译好的请求写成 request.md；
 * 2. 抛出 AwaitingManualReply，让 runner 停在 awaiting-model；
 * 3. 用户导入 reply.json 后，下一次 complete() 从 manual_reply 事件读取。
 *
 * 这条通路能学上下文编译/暂停恢复/门禁，但不能测干净 API 的前缀缓存或真实延迟。
 */
export class ManualProvider implements ModelProvider {
  name = 'manual-human-relay-not-trae-api';
  constructor(private session: Session) {}

  async complete(request: ModelRequest): Promise<ProviderResult> {
    // 先查是否已导入本次请求的回复；导入事件按 requestId 精确匹配。
    const imported = this.session.events.find(e => e.type === 'manual_reply' && e.data.requestId === request.id);
    if (imported?.type === 'manual_reply') return { reply: imported.data };

    exportManualRequest(this.session, request);
    throw new AwaitingManualReply(request);
  }
}

/**
 * 生成 request.md 和空的 reply.json。
 *
 * request.md 是派生视图，随时可由日志重建；完整请求已经作为 request 事件持久化。
 * 文件权限 0600，因为里面可能包含代码片段和任务内容。
 */
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

  writeFileSync(resolve(session.dir, 'request.md'), prompt, { mode: 0o600 });
  // 只在不存在时创建空模板，避免覆盖用户已经写好的回复。
  if (!existsSync(resolve(session.dir, 'reply.json'))) {
    writeFileSync(resolve(session.dir, 'reply.json'), '{}\n', { mode: 0o600 });
  }
}

/**
 * 正式授权的 OpenAI-compatible endpoint。
 *
 * 支持：非流式 /chat/completions、Bearer API Key、文本 JSON 动作、reported usage。
 * 不支持：原生 tool_calls、streaming、reasoning 字段、自动重试、代理签名（AK/SK）。
 *
 * 安全边界：
 * - 非本机 endpoint 必须 HTTPS；
 * - Base URL 不能带用户名/密码/query/fragment，避免把凭据写进日志；
 * - 不记录完整远端错误响应，避免 header/key 泄露；
 * - 请求失败不自动重试，因为无法确认服务端是否已经执行/计费。
 */
export class OpenAIProvider implements ModelProvider {
  readonly name: string;

  constructor(private baseUrl: string, private model: string, private apiKey: string, name = 'authorized-openai-compatible') {
    this.name = name;
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('Base URL 不应包含凭据、query 或 fragment');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('非本机 endpoint 需要 HTTPS');
    }
    if (!model || !apiKey) throw new Error('缺少模型名或独立 API key');
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ProviderResult> {
    const messages = request.messages;
    // 60 秒是传输层超时；它不等于模型已经取消计费/停止生成。
    const timeout = AbortSignal.timeout(60000);

    const res = await fetch(this.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      // 禁止重定向，避免 Authorization 被带到未授权主机。
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { Authorization: 'Bearer ' + this.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        max_tokens: request.maxOutputTokens,
        temperature: 0,
      }),
    });

    // 不读取并记录远端错误 body：它可能包含请求片段、key 或内部路由信息。
    if (!res.ok) throw new Error(`模型 HTTP ${res.status}，未自动重试；请检查正式接口与配额`);

    const data = record(await res.json(), 'model response');
    const choices = data.choices;
    if (!Array.isArray(choices) || !choices[0]) throw new Error('模型没有返回 choices');

    const content = record(record(choices[0]).message).content;
    if (typeof content !== 'string') throw new Error('第一版要求文本 JSON 回复，尚不支持原生 tool_calls／流式');

    // usage 字段可能缺失；缺失表示“未知”，不是 0。
    const usageRaw = typeof data.usage === 'object' && data.usage !== null ? record(data.usage) : {};
    const usage: { inputTokens?: number; outputTokens?: number } = {};
    if (Number.isSafeInteger(usageRaw.prompt_tokens) && (usageRaw.prompt_tokens as number) >= 0) {
      usage.inputTokens = usageRaw.prompt_tokens as number;
    }
    if (Number.isSafeInteger(usageRaw.completion_tokens) && (usageRaw.completion_tokens as number) >= 0) {
      usage.outputTokens = usageRaw.completion_tokens as number;
    }

    // 协议解析与 Mock/Manual 共用，确保三条通路行为一致。
    return { reply: parseReply(content, request.id), usage };
  }
}

/** 根据会话配置构造 provider；真实 provider 的凭据只从进程环境变量读取。 */
export function providerFor(session: Session): ModelProvider {
  switch (session.config.provider) {
    case 'mock':
      return new MockProvider(session);
    case 'manual':
      return new ManualProvider(session);
    case 'openai':
      return new OpenAIProvider(
        process.env.HARNESS_BASE_URL ?? '',
        process.env.HARNESS_MODEL ?? '',
        process.env.HARNESS_API_KEY ?? '',
      );
    case 'ark':
      // Ark 复用 OpenAI-compatible 适配器，只换一个可观测的 name，便于日志区分。
      return new OpenAIProvider(
        process.env.HARNESS_BASE_URL ?? '',
        process.env.HARNESS_MODEL ?? '',
        process.env.HARNESS_API_KEY ?? '',
        'ark-internal-openai-compatible',
      );
  }
}
