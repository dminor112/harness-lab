/**
 * 核心行为测试。
 *
 * 这些测试不追求覆盖率，而是锁住学习项目最容易被改坏的不变量：
 * - 协议严格性；
 * - 日志恢复与 seq 稳定；
 * - Unicode 裁剪；
 * - 工具调用/结果不拆开；
 * - checkpoint 的“丢历史但保留笔记/原日志/稳定前缀”；
 * - 超预算 fail closed；
 * - 路径边界与符号链接；
 * - 编辑提案不落盘、拒绝后不改、陈旧覆盖被拒；
 * - Mock 真实闭环；
 * - manual 的暂停/旧回复拒绝；
 * - 未知工具与默认拒绝测试；
 * - 独立 API 的请求形状、usage 解析、不泄露 key；
 * - URL 安全边界。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Session } from '../src/session.js';
import { compileContext, historyUnits, prune, estimateTokens } from '../src/context.js';
import { DEFAULT_BUDGET, ContextOverflow, AwaitingManualReply } from '../src/types.js';
import { parseReply } from '../src/protocol.js';
import { Tools, TOOL_SPECS, safePath, hash } from '../src/tools.js';
import { MockProvider, ManualProvider, OpenAIProvider } from '../src/providers.js';
import { run } from '../src/runner.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SessionConfig } from '../src/types.js';

/**
 * 创建独立临时 workspace + session。
 *
 * 注意：Session.create 的 workspace 必须已存在，因此先 mkdir workspace；
 * 这里用 mkdtemp 保证每个测试互不影响，也不会碰仓库 fixtures。
 */
function setup(overrides: Partial<SessionConfig> = {}): { session: Session; workspace: string } {
  const base = mkdtempSync(resolve(tmpdir(), 'harness-test-'));
  const workspace = resolve(base, 'workspace');
  const s = new Session(workspace);
  writeFileSync(resolve(s.dir, 'sum.mjs'), 'export function sum(a,b) { return a - b; }\n');
  writeFileSync(resolve(s.dir, 'test.test.mjs'), "import {sum} from './sum.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2,3),5);\n");
  return {
    workspace,
    session: Session.create(resolve(base, 'session'), {
      workspace,
      task: '修复加法',
      provider: 'mock',
      strategy: 'checkpoint',
      budget: DEFAULT_BUDGET,
      maxSteps: 30,
      ...overrides,
    }),
  };
}

/** 追加一对“读取调用 + 成功结果”，作为后续上下文/提案测试的最小历史单元。 */
function unit(s: Session, id: string, text: string): void {
  s.append('assistant', { requestId: id, action: { kind: 'tool', name: 'read_file', args: { path: 'sum.mjs' } }, latencyMs: 1 });
  s.append('tool_result', { requestId: id, name: 'read_file', result: { ok: true, text } });
}

test('协议拒绝旧请求、自然语言与未知字段', () => {
  // requestId 不匹配 = 旧回复/串会话，必须拒绝。
  assert.throws(() => parseReply('{"requestId":"old","action":{"kind":"final","text":"ok"}}', 'new'));

  // Markdown 围栏不是 JSON，不能“帮忙剥掉”。
  assert.throws(() => parseReply('```json\n{}\n```', 'new'));

  // 未知字段不兼容，避免未定义语义悄悄进入执行层。
  assert.throws(() => parseReply('{"requestId":"new","action":{"kind":"final","text":"ok","extra":1}}', 'new'));

  // 合法 final 正常通过。
  assert.equal(parseReply('{"requestId":"new","action":{"kind":"final","text":"ok"}}', 'new').action.kind, 'final');
});

test('事件重开可恢复，序号稳定，拒绝半行', () => {
  const { session } = setup();
  unit(session, 'a', 'evidence');

  // 新 Session 从 events.jsonl 重放，内存视图应与原 session 完全一致。
  assert.deepEqual(new Session(session.dir).events, session.events);

  // 手工制造半行，模拟崩溃时最后一次 append 未完整落盘。
  writeFileSync(resolve(session.dir, 'events.jsonl'), '{broken');

  // 不自动修复、不猜测最后一条事件，直接拒绝继续。
  assert.throws(() => new Session(session.dir), /末行不完整/);
});

test('Unicode 裁剪留头尾并提供原始 seq', () => {
  // 用 emoji 验证按码点切分，而不是按 UTF-16 code unit。
  const result = prune('头😀' + '中'.repeat(2000) + '😀尾', 200, 42);

  assert.ok(result.startsWith('头😀'));
  assert.ok(result.endsWith('😀尾'));
  assert.ok(result.includes('seq=42'));
  assert.ok(Array.from(result).length <= 200);

  // 中文至少 1 码点 1 token；这里只验证估算不会把中文算成 0。
  assert.ok(estimateTokens('中文') >= 2);
});

test('调用／结果不拆开，未完成工具拒绝上下文编译', () => {
  const { session } = setup();
  unit(session, 'a', 'read');

  // 一个工具单元必须同时包含 assistant 与 tool_result 两条 seq。
  assert.equal(historyUnits(session.events, 300).units[0]?.seqs.length, 2);

  // 只有 assistant 调用、没有 tool_result：上下文编译器必须拒绝，
  // 否则模型会基于“不知道结果”的状态继续行动。
  session.append('assistant', { requestId: 'pending', action: { kind: 'tool', name: 'run_tests', args: {} }, latencyMs: 1 });
  assert.throws(() => compileContext(session, TOOL_SPECS), /未完成工具调用/);
});

test('checkpoint 丢历史但保留笔记、原日志与稳定前缀', () => {
  const { session } = setup({ budget: { ...DEFAULT_BUDGET, recentUnits: 2 } });
  session.append('note', { text: '必须保留：不要修改 API', sourceRequestId: 'a' });

  // 5 个长工具结果，制造“必须丢历史”的压力。
  for (let i = 0; i < 5; i++) unit(session, 'r' + i, 'noise'.repeat(2000));

  const before = JSON.stringify(session.events);
  const cp = compileContext(session, TOOL_SPECS, 'checkpoint');
  const tail = compileContext(session, TOOL_SPECS, 'tail');

  // checkpoint 注入最近笔记；tail 不注入。
  assert.ok(cp.messages.some(m => m.content.includes('必须保留')));
  assert.ok(!tail.messages.some(m => m.content.includes('必须保留')));

  // 5 个单元只保留最近 2 个，因此丢 3 个；每个单元 2 条 seq，共保留 4 条 seq。
  assert.equal(cp.metrics.omittedUnits, 3);
  assert.equal(cp.metrics.selectedEventSeqs.length, 4);

  // 上下文编译不能修改原日志。
  assert.equal(before, JSON.stringify(session.events));

  // system 内容不变，prefixHash 应一致（用于观察前缀缓存）。
  assert.equal(cp.metrics.prefixHash, tail.metrics.prefixHash);

  // 被移出上下文的历史仍可从原日志检索。
  assert.ok(session.search('noise').length > 0);
});

test('full 超预算失败，不静默截断系统、任务或最新单元', () => {
  const { session } = setup();
  unit(session, 'a', 'x'.repeat(100000));

  // full 不裁剪工具结果，直接超预算，必须显式失败。
  assert.throws(() => compileContext(session, TOOL_SPECS, 'full'), ContextOverflow);

  // checkpoint 可以裁剪/丢弃旧单元，装进预算。
  const bounded = compileContext(session, TOOL_SPECS, 'checkpoint');
  assert.ok(bounded.metrics.selectedTokens <= bounded.metrics.inputLimit);

  // 即使只有一个任务、没有历史，任务本身过大也不能被静默截断。
  const big = setup({ task: '中'.repeat(30000) }).session;
  assert.throws(() => compileContext(big, TOOL_SPECS), ContextOverflow);
});

test('路径边界拒绝越界、绝对路径、密钥及符号链接', () => {
  const { workspace } = setup();
  writeFileSync(resolve(workspace, '.env'), 'secret');
  symlinkSync(resolve(workspace, 'sum.mjs'), resolve(workspace, 'link.mjs'));

  for (const path of ['../secret', '/etc/passwd', '.env', 'link.mjs']) {
    assert.throws(() => safePath(workspace, path));
  }

  // 正常相对路径仍可用。
  assert.ok(safePath(workspace, 'sum.mjs').endsWith('sum.mjs'));
});

test('编辑提案不落盘；拒绝后不改；之后文件变化拒绝陈旧覆盖', async () => {
  const { session, workspace } = setup();
  const tools = new Tools(session);

  // 先伪造一条成功读取证据，满足“先读后改”。
  unit(session, 'read', JSON.stringify({ path: 'sum.mjs', hash: hash(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8')) }));

  // propose_edit 只写 proposal 事件并抛出审批控制流，不写文件。
  await assert.rejects(tools.execute('propose_edit', { path: 'sum.mjs', old: 'a - b', replacement: 'a + b' }, 'edit'));
  assert.ok(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8').includes('a - b'));

  // 拒绝审批：不写文件。
  assert.equal(tools.approve('edit', false).ok, false);
  assert.ok(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8').includes('a - b'));

  // 第二个提案后，外部修改文件；批准时必须因 beforeHash 不一致而拒绝覆盖。
  await assert.rejects(tools.execute('propose_edit', { path: 'sum.mjs', old: 'a - b', replacement: 'a + b' }, 'edit2'));
  writeFileSync(resolve(workspace, 'sum.mjs'), 'externally changed');
  assert.equal(tools.approve('edit2', true).ok, false);
  assert.equal(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8'), 'externally changed');
});

test('Mock 实际闭环：读 → 提案 → 批准 → 真测试 → 最终证据', async () => {
  const { session } = setup();
  const tools = new Tools(session, async () => true);
  const provider = new MockProvider(session);

  // 第一次 run 会在 propose_edit 后停住等审批。
  assert.equal(await run(session, provider, tools, () => {}), 'awaiting-approval');

  const proposal = session.events.find(e => e.type === 'proposal');
  assert.ok(proposal && proposal.type === 'proposal');
  assert.equal(tools.approve(proposal.data.requestId, true).ok, true);

  // 审批后继续：run_tests → save_note → final。
  assert.equal(await run(session, provider, tools, () => {}), 'stopped');
  assert.equal(session.events.at(-1)?.type, 'stop');

  const stop = session.events.at(-1);
  assert.ok(stop?.type === 'stop');

  // 只有最近一次成功编辑之后有成功测试，才允许 final-test-verified。
  assert.equal(stop.data.reason, 'final-test-verified');
});

test('手动请求暂停、持久化，旧回复不能导入，新回复可继续', async () => {
  const { session } = setup({ provider: 'manual' });
  const provider = new ManualProvider(session);
  const tools = new Tools(session);

  // 第一次 complete 导出 request.md 并抛 AwaitingManualReply。
  assert.equal(await run(session, provider, tools, () => {}), 'awaiting-model');
  const request = session.pendingRequest();
  assert.ok(request);
  assert.ok(readFileSync(resolve(session.dir, 'request.md'), 'utf8').includes(request.id));

  // 已有 pendingRequest 时再次 complete 仍走人工通路。
  await assert.rejects(provider.complete(request), AwaitingManualReply);

  // 导入一个“没有验证”的 final；runner 必须标记 final-unverified。
  session.append('manual_reply', parseReply(JSON.stringify({ requestId: request.id, action: { kind: 'final', text: '还没有验证' } }), request.id));
  assert.equal(await run(session, provider, tools, () => {}), 'stopped');
  const stop = session.events.at(-1);
  assert.ok(stop?.type === 'stop');
  assert.equal(stop.data.reason, 'final-unverified');
});

test('未知 shell 工具不可执行，测试默认拒绝', async () => {
  const { session } = setup();
  const tools = new Tools(session);

  // 没有通用 bash；未知工具返回 ok=false。
  assert.equal((await tools.execute('bash', { command: 'anything' }, 'x')).ok, false);

  // confirmTests 默认返回 false，所以 run_tests 不会执行。
  assert.equal((await tools.execute('run_tests', {}, 'x')).ok, false);
});

test('独立 API 本地 mock HTTP：发送日志中的消息并读取 reported usage', async () => {
  const { session } = setup();
  const request = compileContext(session, TOOL_SPECS);

  // 用本机 HTTP server 验证 OpenAIProvider 的请求形状，不发真实外网请求。
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer fixture-key');

      const body = JSON.parse(Buffer.concat(chunks).toString());
      // 必须原样发送日志/编译结果中的 messages，不能偷偷改上下文。
      assert.deepEqual(body.messages, request.messages);

      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ requestId: request.id, action: { kind: 'final', text: 'fixture' } }) } }],
        usage: { prompt_tokens: 120, completion_tokens: 20 },
      }));
    });
  });

  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await new OpenAIProvider(`http://127.0.0.1:${port}/v1`, 'fixture', 'fixture-key').complete(request);

    assert.equal(result.reply.action.kind, 'final');
    assert.equal(result.usage?.inputTokens, 120);
    assert.equal(result.usage?.outputTokens, 20);

    // 日志里不能出现 API key。
    assert.ok(!JSON.stringify(session.events).includes('fixture-key'));
  } finally {
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
  }
});

test('独立 API 限 HTTPS、无 URL 凭据，不把 Trae 账号当 key', () => {
  // 非本机 endpoint 必须 HTTPS。
  assert.throws(() => new OpenAIProvider('http://remote.example/v1', 'm', 'k'));

  // Base URL 不能内嵌用户名/密码。
  assert.throws(() => new OpenAIProvider('https://user:pass@remote.example/v1', 'm', 'k'));

  // 空 key 直接失败；不存在“回退到 Trae 账号”的路径。
  assert.throws(() => new OpenAIProvider('https://remote.example/v1', 'm', ''));
});
