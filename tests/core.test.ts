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

function setup(overrides: Partial<SessionConfig> = {}): { session: Session; workspace: string } {
  const base = mkdtempSync(resolve(tmpdir(), 'harness-test-')), workspace = resolve(base, 'workspace');
  // session 初始化会创建目录，workspace 由 test 独立创建。
  const s = new Session(workspace);
  writeFileSync(resolve(s.dir, 'sum.mjs'), 'export function sum(a,b) { return a - b; }\n');
  writeFileSync(resolve(s.dir, 'test.test.mjs'), "import {sum} from './sum.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2,3),5);\n");
  return { workspace, session: Session.create(resolve(base, 'session'), {
    workspace, task: '修复加法', provider: 'mock', strategy: 'checkpoint', budget: DEFAULT_BUDGET, maxSteps: 30, ...overrides,
  }) };
}
function unit(s: Session, id: string, text: string): void {
  s.append('assistant', { requestId: id, action: { kind: 'tool', name: 'read_file', args: { path: 'sum.mjs' } }, latencyMs: 1 });
  s.append('tool_result', { requestId: id, name: 'read_file', result: { ok: true, text } });
}
test('协议拒绝旧请求、自然语言与未知字段', () => {
  assert.throws(() => parseReply('{"requestId":"old","action":{"kind":"final","text":"ok"}}', 'new'));
  assert.throws(() => parseReply('```json\n{}\n```', 'new'));
  assert.throws(() => parseReply('{"requestId":"new","action":{"kind":"final","text":"ok","extra":1}}', 'new'));
  assert.equal(parseReply('{"requestId":"new","action":{"kind":"final","text":"ok"}}', 'new').action.kind, 'final');
});
test('事件重开可恢复，序号稳定，拒绝半行', () => {
  const { session } = setup(); unit(session, 'a', 'evidence');
  assert.deepEqual(new Session(session.dir).events, session.events);
  writeFileSync(resolve(session.dir, 'events.jsonl'), '{broken');
  assert.throws(() => new Session(session.dir), /末行不完整/);
});
test('Unicode 裁剪留头尾并提供原始 seq', () => {
  const result = prune('头😀' + '中'.repeat(2000) + '😀尾', 200, 42);
  assert.ok(result.startsWith('头😀')); assert.ok(result.endsWith('😀尾'));
  assert.ok(result.includes('seq=42')); assert.ok(Array.from(result).length <= 200);
  assert.ok(estimateTokens('中文') >= 2);
});
test('调用／结果不拆开，未完成工具拒绝上下文编译', () => {
  const { session } = setup(); unit(session, 'a', 'read');
  assert.equal(historyUnits(session.events, 300).units[0]?.seqs.length, 2);
  session.append('assistant', { requestId: 'pending', action: { kind: 'tool', name: 'run_tests', args: {} }, latencyMs: 1 });
  assert.throws(() => compileContext(session, TOOL_SPECS), /未完成工具调用/);
});
test('checkpoint 丢历史但保留笔记、原日志与稳定前缀', () => {
  const { session } = setup({ budget: { ...DEFAULT_BUDGET, recentUnits: 2 } });
  session.append('note', { text: '必须保留：不要修改 API', sourceRequestId: 'a' });
  for (let i = 0; i < 5; i++) unit(session, 'r' + i, 'noise'.repeat(2000));
  const before = JSON.stringify(session.events);
  const cp = compileContext(session, TOOL_SPECS, 'checkpoint');
  const tail = compileContext(session, TOOL_SPECS, 'tail');
  assert.ok(cp.messages.some(m => m.content.includes('必须保留')));
  assert.ok(!tail.messages.some(m => m.content.includes('必须保留')));
  assert.equal(cp.metrics.omittedUnits, 3);
  assert.equal(cp.metrics.selectedEventSeqs.length, 4);
  assert.equal(before, JSON.stringify(session.events));
  assert.equal(cp.metrics.prefixHash, tail.metrics.prefixHash);
  assert.ok(session.search('noise').length > 0);
});
test('full 超预算失败，不静默截断系统、任务或最新单元', () => {
  const { session } = setup(); unit(session, 'a', 'x'.repeat(100000));
  assert.throws(() => compileContext(session, TOOL_SPECS, 'full'), ContextOverflow);
  const bounded = compileContext(session, TOOL_SPECS, 'checkpoint');
  assert.ok(bounded.metrics.selectedTokens <= bounded.metrics.inputLimit);
  const big = setup({ task: '中'.repeat(30000) }).session;
  assert.throws(() => compileContext(big, TOOL_SPECS), ContextOverflow);
});
test('路径边界拒绝越界、绝对路径、密钥及符号链接', () => {
  const { workspace } = setup();
  writeFileSync(resolve(workspace, '.env'), 'secret');
  symlinkSync(resolve(workspace, 'sum.mjs'), resolve(workspace, 'link.mjs'));
  for (const path of ['../secret', '/etc/passwd', '.env', 'link.mjs']) assert.throws(() => safePath(workspace, path));
  assert.ok(safePath(workspace, 'sum.mjs').endsWith('sum.mjs'));
});
test('编辑提案不落盘；拒绝后不改；之后文件变化拒绝陈旧覆盖', async () => {
  const { session, workspace } = setup(); const tools = new Tools(session);
  unit(session, 'read', JSON.stringify({ path: 'sum.mjs', hash: hash(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8')) }));
  await assert.rejects(tools.execute('propose_edit', { path: 'sum.mjs', old: 'a - b', replacement: 'a + b' }, 'edit'));
  assert.ok(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8').includes('a - b'));
  assert.equal(tools.approve('edit', false).ok, false);
  assert.ok(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8').includes('a - b'));
  await assert.rejects(tools.execute('propose_edit', { path: 'sum.mjs', old: 'a - b', replacement: 'a + b' }, 'edit2'));
  writeFileSync(resolve(workspace, 'sum.mjs'), 'externally changed');
  assert.equal(tools.approve('edit2', true).ok, false);
  assert.equal(readFileSync(resolve(workspace, 'sum.mjs'), 'utf8'), 'externally changed');
});
test('Mock 实际闭环：读 → 提案 → 批准 → 真测试 → 最终证据', async () => {
  const { session } = setup(); const tools = new Tools(session, async () => true), provider = new MockProvider(session);
  assert.equal(await run(session, provider, tools, () => {}), 'awaiting-approval');
  const proposal = session.events.find(e => e.type === 'proposal'); assert.ok(proposal && proposal.type === 'proposal');
  assert.equal(tools.approve(proposal.data.requestId, true).ok, true);
  assert.equal(await run(session, provider, tools, () => {}), 'stopped');
  assert.equal(session.events.at(-1)?.type, 'stop');
  const stop = session.events.at(-1); assert.ok(stop?.type === 'stop');
  assert.equal(stop.data.reason, 'final-test-verified');
});
test('手动请求暂停、持久化，旧回复不能导入，新回复可继续', async () => {
  const { session } = setup({ provider: 'manual' });
  const provider = new ManualProvider(session), tools = new Tools(session);
  assert.equal(await run(session, provider, tools, () => {}), 'awaiting-model');
  const request = session.pendingRequest(); assert.ok(request);
  assert.ok(readFileSync(resolve(session.dir, 'request.md'), 'utf8').includes(request.id));
  await assert.rejects(provider.complete(request), AwaitingManualReply);
  session.append('manual_reply', parseReply(JSON.stringify({ requestId: request.id, action: { kind: 'final', text: '还没有验证' } }), request.id));
  assert.equal(await run(session, provider, tools, () => {}), 'stopped');
  const stop = session.events.at(-1); assert.ok(stop?.type === 'stop'); assert.equal(stop.data.reason, 'final-unverified');
});
test('未知 shell 工具不可执行，测试默认拒绝', async () => {
  const { session } = setup(); const tools = new Tools(session);
  assert.equal((await tools.execute('bash', { command: 'anything' }, 'x')).ok, false);
  assert.equal((await tools.execute('run_tests', {}, 'x')).ok, false);
});
test('独立 API 本地 mock HTTP：发送日志中的消息并读取 reported usage', async () => {
  const { session } = setup(); const request = compileContext(session, TOOL_SPECS);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      assert.equal(req.url, '/v1/chat/completions');
      assert.equal(req.headers.authorization, 'Bearer fixture-key');
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.deepEqual(body.messages, request.messages);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ requestId: request.id, action: { kind: 'final', text: 'fixture' } }) } }], usage: { prompt_tokens: 120, completion_tokens: 20 } }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const port = (server.address() as AddressInfo).port;
    const result = await new OpenAIProvider(`http://127.0.0.1:${port}/v1`, 'fixture', 'fixture-key').complete(request);
    assert.equal(result.reply.action.kind, 'final');
    assert.equal(result.usage?.inputTokens, 120);
    assert.equal(result.usage?.outputTokens, 20);
    assert.ok(!JSON.stringify(session.events).includes('fixture-key'));
  } finally { await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())); }
});

test('独立 API 限 HTTPS、无 URL 凭据，不把 Trae 账号当 key', () => {
  assert.throws(() => new OpenAIProvider('http://remote.example/v1', 'm', 'k'));
  assert.throws(() => new OpenAIProvider('https://user:pass@remote.example/v1', 'm', 'k'));
  assert.throws(() => new OpenAIProvider('https://remote.example/v1', 'm', ''));
});
