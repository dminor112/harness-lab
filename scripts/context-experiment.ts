import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Session } from '../src/session.js';
import { compileContext } from '../src/context.js';
import { DEFAULT_BUDGET } from '../src/types.js';
import { TOOL_SPECS } from '../src/tools.js';
import type { Strategy } from '../src/types.js';
const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const temp = mkdtempSync(resolve(tmpdir(), 'harness-context-'));
const s = Session.create(resolve(temp, 'session'), {
  workspace: temp, task: '修改实现但不修改公开 API。每次改动后要验证。', provider: 'mock', strategy: 'checkpoint',
  budget: { ...DEFAULT_BUDGET, window: 12000, recentUnits: 3 }, maxSteps: 30,
});
const marker = 'FACT_KEEP_API_V1';
for (let i = 0; i < 12; i++) {
  const requestId = 'fixture-' + i;
  s.append('assistant', { requestId, action: { kind: 'tool', name: 'read_file', args: { path: 'old-source.mjs' } }, latencyMs: 0 });
  s.append('tool_result', { requestId, name: 'read_file', result: { ok: true, text: (i === 0 ? marker + '\n' : '') + 'irrelevant source noise\n'.repeat(1200) } });
  if (i === 0) s.append('note', { text: `${marker}：public API v1 不可修改。来源 seq=3；本实验预置此笔记，不代表模型会正确总结。`, sourceRequestId: requestId });
}
const results = (['full', 'tail', 'checkpoint'] as Strategy[]).map(strategy => {
  try {
    const r = compileContext(s, TOOL_SPECS, strategy);
    return { strategy, fits: true, markerPresent: r.messages.some(m => m.content.includes(marker)), ...r.metrics };
  } catch (e) { return { strategy, fits: false, markerPresent: null, error: (e as Error).message }; }
});
const out = resolve(root, 'examples'); mkdirSync(out, { recursive: true });
const report = {
  scope: 'Deterministic context compiler experiment ONLY. No model call, no coding-ability claim, no billing token counts.',
  caveat: 'Checkpoint marker is pre-written by fixture; this only tests plumbing. Real notes need fidelity and stale-state tests.',
  results,
};
writeFileSync(resolve(out, 'context-experiment.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
