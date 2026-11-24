/**
 * 离线上下文实验。
 *
 * 目的：在完全不调用模型的情况下，观察三种策略在同一份“长工具结果”历史里
 * 分别能不能装进预算、早期事实标记是否还在输入中。
 *
 * 注意：这不是模型效果实验。marker 由 fixture 预先写入 note，证明的是
 * checkpoint 管道会把笔记注入；不证明模型能自己写出正确摘要，也不证明模型
 * 真的会使用这条事实。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Session } from '../src/session.js';
import { compileContext } from '../src/context.js';
import { DEFAULT_BUDGET } from '../src/types.js';
import { TOOL_SPECS } from '../src/tools.js';
import type { Strategy } from '../src/types.js';

// scripts 在 dist/scripts 下运行时，../../ 指向仓库根。
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const temp = mkdtempSync(resolve(tmpdir(), 'harness-context-'));

// 固定任务与较小窗口，让 full 必然超预算、tail/checkpoint 需要丢历史。
const s = Session.create(resolve(temp, 'session'), {
  workspace: temp,
  task: '修改实现但不修改公开 API。每次改动后要验证。',
  provider: 'mock',
  strategy: 'checkpoint',
  budget: { ...DEFAULT_BUDGET, window: 12000, recentUnits: 3 },
  maxSteps: 30,
});

// 早期事实标记：只写进第 0 个工具结果和一条 note，用来检测“被丢历史后是否还能看到”。
const marker = 'FACT_KEEP_API_V1';

for (let i = 0; i < 12; i++) {
  const requestId = 'fixture-' + i;

  // 每个单元都是 read_file 调用 + 一大段无关噪声；第 0 个单元头部带 marker。
  s.append('assistant', {
    requestId,
    action: { kind: 'tool', name: 'read_file', args: { path: 'old-source.mjs' } },
    latencyMs: 0,
  });
  s.append('tool_result', {
    requestId,
    name: 'read_file',
    result: { ok: true, text: (i === 0 ? marker + '\n' : '') + 'irrelevant source noise\n'.repeat(1200) },
  });

  // 只在第 0 轮写 note；这条 note 是 fixture 预置，不是模型生成的。
  if (i === 0) {
    s.append('note', {
      text: `${marker}：public API v1 不可修改。来源 seq=3；本实验预置此笔记，不代表模型会正确总结。`,
      sourceRequestId: requestId,
    });
  }
}

// 对三种策略分别编译；失败也记录为一条结果，而不是让脚本崩掉。
const results = (['full', 'tail', 'checkpoint'] as Strategy[]).map(strategy => {
  try {
    const r = compileContext(s, TOOL_SPECS, strategy);
    return {
      strategy,
      fits: true,
      markerPresent: r.messages.some(m => m.content.includes(marker)),
      ...r.metrics,
    };
  } catch (e) {
    return { strategy, fits: false, markerPresent: null, error: (e as Error).message };
  }
});

// 输出到 examples/ 供文档引用；scope/caveat 明确禁止把它说成模型能力证据。
const out = resolve(root, 'examples');
mkdirSync(out, { recursive: true });
const report = {
  scope: 'Deterministic context compiler experiment ONLY. No model call, no coding-ability claim, no billing token counts.',
  caveat: 'Checkpoint marker is pre-written by fixture; this only tests plumbing. Real notes need fidelity and stale-state tests.',
  results,
};

writeFileSync(resolve(out, 'context-experiment.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
