import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Session } from '../src/session.js';
import { MockProvider, OpenAIProvider } from '../src/providers.js';
import { Tools } from '../src/tools.js';
import { run } from '../src/runner.js';
import { DEFAULT_BUDGET } from '../src/types.js';
import type { ModelProvider, Strategy } from '../src/types.js';

/** 在线评测只允许在明确授权的一次性 fixture 内自动应用提案及运行测试。 */
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => { const i = argv.indexOf('--' + name); return i < 0 ? fallback : argv[i + 1] ?? fallback; };
const mode = arg('provider', 'mock');
const repeats = Number(arg('repeats', '1'));
if (!['mock', 'openai'].includes(mode) || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('provider=mock|openai; repeats=1..10');
if (mode === 'openai' && !argv.includes('--approve-disposable-fixtures')) throw new Error('在线评测会调用收费 API、自动应用 fixture 内提案并运行模型可改的测试文件（不是沙箱）。请先阅读文档；明确同意后传 --approve-disposable-fixtures。不能在业务仓库使用。');
const suite = [
  { id: 'sum', source: 'export function sum(a,b) { return a - b; }', test: "import {sum} from './sum.mjs'; assert.equal(sum(2,3),5); assert.equal(sum(-3,1),-2);", task: '修复 sum.mjs 中 sum 的加法错误，不修改测试。读取、修改、跑测试后再结束。' },
  { id: 'sum-boundaries', source: 'export function sum(a,b) { return a - b; }', test: "import {sum} from './sum.mjs'; assert.equal(sum(0,4),4); assert.equal(sum(-2,-3),-5);", task: 'sum 的负数和零边界出错，修复 sum.mjs，不修改测试；跑测试后交付。' },
  { id: 'clamp', source: 'export function clamp(x,min,max) { return Math.max(max, Math.min(min,x)); }', test: "import {clamp} from './sum.mjs'; assert.equal(clamp(5,0,10),5); assert.equal(clamp(-1,0,10),0); assert.equal(clamp(11,0,10),10);", task: '修复 sum.mjs 中 clamp(x,min,max)，不改签名，不修改测试，满足上下限与区间内数字并验证。' },
];
const runDir = resolve(root, 'labs', 'eval-' + randomUUID().slice(0, 8)); mkdirSync(runDir, { recursive: true });
const results: unknown[] = [];
for (const strategy of ['full', 'tail', 'checkpoint'] as Strategy[]) {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const task of mode === 'mock' ? suite.slice(0, 2) : suite) {
      const dir = resolve(runDir, `${strategy}-${task.id}-${repeat}`); mkdirSync(dir, { recursive: true });
      const source = resolve(dir, 'sum.mjs'), test = resolve(dir, 'test.test.mjs');
      writeFileSync(source, task.source + '\n');
      const tests = "import assert from 'node:assert/strict';\n" + task.test + '\n'; writeFileSync(test, tests);
      // 独立持有验收测试文本；模型改动测试文件不能伪装为通过。
      const session = Session.create(resolve(dir, '.harness'), { workspace: dir, task: task.task, provider: mode === 'mock' ? 'mock' : 'openai', strategy,
        budget: DEFAULT_BUDGET, maxSteps: 25 });
      const provider: ModelProvider = mode === 'mock' ? new MockProvider(session) : new OpenAIProvider(process.env.HARNESS_BASE_URL ?? '', process.env.HARNESS_MODEL ?? '', process.env.HARNESS_API_KEY ?? '');
      const tools = new Tools(session, async () => true);
      const started = performance.now(); let error: string | undefined;
      try {
        let state = await run(session, provider, tools, () => {});
        while (state === 'awaiting-approval') {
          const proposal = session.events.filter(e => e.type === 'proposal').at(-1);
          if (!proposal || proposal.type !== 'proposal') throw new Error('缺少提案');
          // 实验只自动批准实现文件，不能改测试／其他文件。
          tools.approve(proposal.data.requestId, proposal.data.path === 'sum.mjs');
          state = await run(session, provider, tools, () => {});
        }
      } catch (e) { error = 'runner-or-provider-error'; }
      const testUnchanged = readFileSync(test, 'utf8') === tests;
      const verification = await tools.execute('run_tests', {}, 'independent-eval');
      const actions = session.events.filter(e => e.type === 'assistant');
      const requests = session.events.filter(e => e.type === 'request');
      const inputKnown = actions.every(e => e.data.usage?.inputTokens !== undefined);
      const outputKnown = actions.every(e => e.data.usage?.outputTokens !== undefined);
      const entry = { task: task.id, strategy, repeat, passed: verification.ok && testUnchanged, testUnchanged,
        steps: actions.length, toolErrors: session.events.filter(e => e.type === 'tool_result' && !e.data.result.ok).length,
        inputTokens: inputKnown ? actions.reduce((n, e) => n + (e.data.usage?.inputTokens ?? 0), 0) : null,
        outputTokens: outputKnown ? actions.reduce((n, e) => n + (e.data.usage?.outputTokens ?? 0), 0) : null,
        inputEstimateSum: requests.reduce((n, e) => n + e.data.metrics.selectedTokens, 0), elapsedMs: Math.round(performance.now() - started), error: error ?? null };
      results.push(entry); console.log(JSON.stringify(entry));
    }
  }
}
const summary = { mode, evidence: mode === 'mock' ? 'Scripted mock validates runtime only, not real model performance. Null token counts mean unavailable, NOT zero.' : 'Real model calls; small local suite only, not SWE-bench; compare identical model and repeats.',
  providerModel: mode === 'openai' ? process.env.HARNESS_MODEL : null, repeats, results };
writeFileSync(resolve(runDir, 'results.json'), JSON.stringify(summary, null, 2));
if (mode === 'mock') { mkdirSync(resolve(root, 'examples'), { recursive: true }); copyFileSync(resolve(runDir, 'results.json'), resolve(root, 'examples', 'mock-eval.json')); }
console.log(`结果已保存 ${resolve(runDir, 'results.json')}`);
