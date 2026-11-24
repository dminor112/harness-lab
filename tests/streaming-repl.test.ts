import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Session } from '../src/session.js';
import { compileContext } from '../src/context.js';
import { DEFAULT_BUDGET } from '../src/types.js';
import { OpenAIProvider, MockProvider } from '../src/providers.js';
import { continueTurn, runTurn } from '../src/runner.js';
import { TOOL_SPECS, Tools, hash } from '../src/tools.js';
import type { SessionConfig } from '../src/types.js';

function setup(overrides: Partial<SessionConfig> = {}): { session: Session; workspace: string } {
  const base = mkdtempSync(resolve(tmpdir(), 'harness-repl-')), workspace = resolve(base, 'workspace');
  new Session(workspace);
  writeFileSync(resolve(workspace, 'sum.mjs'), 'export function sum(a,b) { return a - b; }\n');
  writeFileSync(resolve(workspace, 'test.test.mjs'), "import {sum} from './sum.mjs'; import assert from 'node:assert/strict'; assert.equal(sum(2,3),5);\n");
  return { workspace, session: Session.create(resolve(base, 'session'), {
    workspace, task: '修复加法', provider: 'mock', strategy: 'checkpoint', budget: DEFAULT_BUDGET, maxSteps: 30, ...overrides,
  }) };
}

test('流式 provider 逐 token 输出，流结束后才解析完整 JSON', async () => {
  const { session } = setup();
  const request = compileContext(session, TOOL_SPECS);
  const content = JSON.stringify({ requestId: request.id, action: { kind: 'final', text: '流式完成' } });
  const first = content.slice(0, Math.ceil(content.length / 2));
  const second = content.slice(first.length);

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      assert.equal(req.url, '/v1/chat/completions');
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.stream, true);
      assert.ok(body.max_tokens >= 4096);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: first } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: second } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));

  try {
    const port = (server.address() as AddressInfo).port;
    const provider = new OpenAIProvider(`http://127.0.0.1:${port}/v1`, 'fixture', 'fixture-key');
    const tokens: string[] = [];
    const result = await provider.stream(request, token => tokens.push(token));
    assert.equal(tokens.join(''), content);
    assert.equal(result.reply.action.kind, 'final');
    assert.equal(result.usage?.inputTokens, 10);
    assert.equal(result.usage?.outputTokens, 5);
  } finally {
    await new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r()));
  }
});

test('REPL 多轮：第二轮可继续，当前任务不在历史中重复', async () => {
  const { session } = setup();
  const tools = new Tools(session, async () => true);
  const provider = new MockProvider(session);
  const hooks = { onStep: () => {} };

  // 首轮由 config.task 承担，不额外写 user 事件。
  assert.equal(await runTurn(session, provider, tools, '修复加法', hooks, { appendUser: false }), 'awaiting-approval');
  const proposal = session.events.find(e => e.type === 'proposal');
  assert.ok(proposal && proposal.type === 'proposal');
  assert.equal(tools.approve(proposal.data.requestId, true).ok, true);
  assert.equal(await continueTurn(session, provider, tools, hooks), 'stopped');
  assert.equal(session.events.filter(e => e.type === 'stop').length, 1);

  // 第二轮追加 user；Mock 在第二轮只发 final，用来验证 stop 之后仍可继续。
  assert.equal(await runTurn(session, provider, tools, '第二轮：解释刚才的改动', hooks), 'stopped');
  assert.equal(session.events.filter(e => e.type === 'stop').length, 2);
  assert.equal(session.currentTask(), '第二轮：解释刚才的改动');

  const request = compileContext(session, TOOL_SPECS, 'checkpoint', session.currentTask(), session.currentTurnStartSeq());
  const duplicate = request.messages.filter(m => m.role === 'user' && m.content.includes('第二轮：解释刚才的改动'));
  assert.equal(duplicate.length, 1, '当前任务只应出现在 taskMessage 中，不应再重复历史 user 事件');

  // 首轮读取证据仍保留在日志；第二轮 context 没有把它丢掉导致文件不可读。
  assert.ok(session.events.some(e => e.type === 'tool_result' && e.data.name === 'read_file'));
  assert.equal(hash(readFileSync(resolve(session.config.workspace, 'sum.mjs'), 'utf8')).length, 64);
});
