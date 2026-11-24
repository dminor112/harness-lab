/**
 * 一次性 fixture 评测。
 *
 * 两种模式：
 * - mock：固定脚本跑 2 个 sum 任务 × 3 种策略，验证运行时和记账，不代表模型能力；
 * - openai：真实模型跑 3 个任务 × 3 种策略 × N 次重复，必须显式授权。
 *
 * 在线模式只允许在新建的 labs/eval-* 下运行，不接受业务仓库路径；
 * 自动批准只允许 sum.mjs，测试文件由评测脚本独立持有并事后核对未改变。
 *
 * 这仍不是沙箱：测试会执行模型改写的实现代码，模型也可能通过其他工具读到本机内容。
 */
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

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const argv = process.argv.slice(2);

/** 读取 `--name value`，缺省时返回 fallback。 */
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf('--' + name);
  return i < 0 ? fallback : argv[i + 1] ?? fallback;
};

const mode = arg('provider', 'mock');
const repeats = Number(arg('repeats', '1'));

if (!['mock', 'openai'].includes(mode) || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 10) {
  throw new Error('provider=mock|openai; repeats=1..10');
}

/**
 * 在线评测的显式授权门禁。
 *
 * 这个开关不是“免确认”，而是要求调用者先读文档、接受：
 * - 真实 API 计费；
 * - 自动应用 fixture 内提案；
 * - 运行模型可改的测试文件（不是沙箱）。
 */
if (mode === 'openai' && !argv.includes('--approve-disposable-fixtures')) {
  throw new Error('在线评测会调用收费 API、自动应用 fixture 内提案并运行模型可改的测试文件（不是沙箱）。请先阅读文档；明确同意后传 --approve-disposable-fixtures。不能在业务仓库使用。');
}

/**
 * 评测任务集。
 *
 * 每个任务都包含：初始实现、独立验收测试、自然语言任务。
 * mock 只跑前两个 sum 任务；openai 跑全部三个（含 clamp）。
 */
const suite = [
  {
    id: 'sum',
    source: 'export function sum(a,b) { return a - b; }',
    test: "import {sum} from './sum.mjs'; assert.equal(sum(2,3),5); assert.equal(sum(-3,1),-2);",
    task: '修复 sum.mjs 中 sum 的加法错误，不修改测试。读取、修改、跑测试后再结束。',
  },
  {
    id: 'sum-boundaries',
    source: 'export function sum(a,b) { return a - b; }',
    test: "import {sum} from './sum.mjs'; assert.equal(sum(0,4),4); assert.equal(sum(-2,-3),-5);",
    task: 'sum 的负数和零边界出错，修复 sum.mjs，不修改测试；跑测试后交付。',
  },
  {
    id: 'clamp',
    source: 'export function clamp(x,min,max) { return Math.max(max, Math.min(min,x)); }',
    test: "import {clamp} from './sum.mjs'; assert.equal(clamp(5,0,10),5); assert.equal(clamp(-1,0,10),0); assert.equal(clamp(11,0,10),10);",
    task: '修复 sum.mjs 中 clamp(x,min,max)，不改签名，不修改测试，满足上下限与区间内数字并验证。',
  },
];

// 每个评测批次一个独立目录，避免不同 repeat/策略互相污染。
const runDir = resolve(root, 'labs', 'eval-' + randomUUID().slice(0, 8));
mkdirSync(runDir, { recursive: true });
const results: unknown[] = [];

for (const strategy of ['full', 'tail', 'checkpoint'] as Strategy[]) {
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const task of mode === 'mock' ? suite.slice(0, 2) : suite) {
      const dir = resolve(runDir, `${strategy}-${task.id}-${repeat}`);
      mkdirSync(dir, { recursive: true });

      const source = resolve(dir, 'sum.mjs');
      const test = resolve(dir, 'test.test.mjs');
      writeFileSync(source, task.source + '\n');

      // 测试文本先保存在评测脚本内存中；后面用它核对模型没有改测试。
      const tests = "import assert from 'node:assert/strict';\n" + task.test + '\n';
      writeFileSync(test, tests);

      const session = Session.create(resolve(dir, '.harness'), {
        workspace: dir,
        task: task.task,
        provider: mode === 'mock' ? 'mock' : 'openai',
        strategy,
        budget: DEFAULT_BUDGET,
        maxSteps: 25,
      });

      const provider: ModelProvider = mode === 'mock'
        ? new MockProvider(session)
        : new OpenAIProvider(process.env.HARNESS_BASE_URL ?? '', process.env.HARNESS_MODEL ?? '', process.env.HARNESS_API_KEY ?? '');

      // 评测场景自动批准测试执行与实现文件提案；这是“一次性 fixture 授权”，不是通用默认。
      const tools = new Tools(session, async () => true);

      const started = performance.now();
      let error: string | undefined;

      try {
        let state = await run(session, provider, tools, () => {});

        // 编辑提案循环：只自动批准 sum.mjs，其他路径一律拒绝。
        while (state === 'awaiting-approval') {
          const proposal = session.events.filter(e => e.type === 'proposal').at(-1);
          if (!proposal || proposal.type !== 'proposal') throw new Error('缺少提案');
          tools.approve(proposal.data.requestId, proposal.data.path === 'sum.mjs');
          state = await run(session, provider, tools, () => {});
        }
      } catch {
        // 只记录分类，不把可能含密钥/内部路径的完整异常写进结果。
        error = 'runner-or-provider-error';
      }

      // 独立验收：测试文件必须与最初写入的文本完全一致。
      const testUnchanged = readFileSync(test, 'utf8') === tests;

      // 评测自己再跑一次测试，作为独立验证；即使模型没有跑测试也能拿到结果。
      const verification = await tools.execute('run_tests', {}, 'independent-eval');

      const actions = session.events.filter(e => e.type === 'assistant');
      const requests = session.events.filter(e => e.type === 'request');

      // usage 只有所有动作都有值才算 known；缺任何一次就是 null（未知），不是 0。
      const inputKnown = actions.every(e => e.data.usage?.inputTokens !== undefined);
      const outputKnown = actions.every(e => e.data.usage?.outputTokens !== undefined);

      const entry = {
        task: task.id,
        strategy,
        repeat,
        passed: verification.ok && testUnchanged,
        testUnchanged,
        steps: actions.length,
        toolErrors: session.events.filter(e => e.type === 'tool_result' && !e.data.result.ok).length,
        inputTokens: inputKnown ? actions.reduce((n, e) => n + (e.data.usage?.inputTokens ?? 0), 0) : null,
        outputTokens: outputKnown ? actions.reduce((n, e) => n + (e.data.usage?.outputTokens ?? 0), 0) : null,
        inputEstimateSum: requests.reduce((n, e) => n + e.data.metrics.selectedTokens, 0),
        elapsedMs: Math.round(performance.now() - started),
        error: error ?? null,
      };

      results.push(entry);
      console.log(JSON.stringify(entry));
    }
  }
}

// 汇总时明确证据边界：mock 只验证运行时；真实模型也只是小任务集，不是 SWE-bench。
const summary = {
  mode,
  evidence: mode === 'mock'
    ? 'Scripted mock validates runtime only, not real model performance. Null token counts mean unavailable, NOT zero.'
    : 'Real model calls; small local suite only, not SWE-bench; compare identical model and repeats.',
  providerModel: mode === 'openai' ? process.env.HARNESS_MODEL : null,
  repeats,
  results,
};

writeFileSync(resolve(runDir, 'results.json'), JSON.stringify(summary, null, 2));

// mock 结果复制到 examples/ 作为稳定样例；真实模型结果只留在 labs，避免误当基线。
if (mode === 'mock') {
  mkdirSync(resolve(root, 'examples'), { recursive: true });
  copyFileSync(resolve(runDir, 'results.json'), resolve(root, 'examples', 'mock-eval.json'));
}

console.log(`结果已保存 ${resolve(runDir, 'results.json')}`);
