import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Session } from './session.js';
import { providerFor, exportManualRequest } from './providers.js';
import { parseReply } from './protocol.js';
import { Tools } from './tools.js';
import { run } from './runner.js';
import { validateBudget } from './context.js';
import { DEFAULT_BUDGET } from './types.js';
import type { ProviderKind, Strategy } from './types.js';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
// dist/src/cli.js → 仓库根（源码入口未直接运行）。
const args = process.argv.slice(2), command = args[0] ?? 'help';
const value = (name: string, fallback?: string): string | undefined => {
  const i = args.indexOf('--' + name); return i < 0 ? fallback : args[i + 1];
};
const required = (name: string): string => { const v = value(name); if (!v) throw new Error(`缺少 --${name}`); return v; };
const numberArg = (name: string, fallback: number): number => {
  const v = Number(value(name, String(fallback))); if (!Number.isSafeInteger(v)) throw new Error(`--${name} 必须是整数`); return v;
};
async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) { console.log('无交互终端，默认不批准。'); return false; }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(message + ' 输入 yes 批准，其他拒绝：')).trim() === 'yes'; }
  finally { rl.close(); }
}
async function locked<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  const path = resolve(session.dir, 'writer.lock');
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); }
  catch { throw new Error('会话有单写者锁；可能已有进程或上次崩溃。不要并发运行；先人工确认进程已退出和副作用状态。'); }
  writeFileSync(fd, String(process.pid));
  try { return await fn(); } finally { closeSync(fd); unlinkSync(path); }
}
function toolsFor(session: Session): Tools {
  return new Tools(session, () => confirm('将执行所选工作区的 test.test.mjs。测试代码可访问本机，不是 OS 沙箱。'));
}
function showState(session: Session, state: string): void {
  console.log(`\n状态：${state}\n会话目录：${session.dir}`);
  if (state === 'awaiting-model') console.log(`打开 ${resolve(session.dir, 'request.md')}，在 Trae 新对话中提交；把纯 JSON 回复保存为 reply.json，然后运行 import。`);
  if (state === 'awaiting-approval') console.log('运行 approve --session <上述会话目录>，查看提案并决定。');
}
function exampleWorkspace(): string {
  const path = resolve(ROOT, 'labs', 'sum-' + randomUUID().slice(0, 8));
  mkdirSync(path, { recursive: true });
  for (const name of ['sum.mjs', 'test.test.mjs']) copyFileSync(resolve(ROOT, 'fixtures', name), resolve(path, name));
  return path;
}
async function main(): Promise<void> {
  if (command === 'help') {
    console.log([
      'Harness Lab · 学习型 Code Agent（非 Trae API）',
      'npm run demo                             创建 fixture 并运行 Mock 到编辑审批',
      'npm run lab -- start --provider manual --example',
      'npm run lab -- start --provider openai --workspace /path/to/disposable/repo --task "任务"',
      'npm run lab -- continue --session /absolute/session/path',
      'npm run lab -- import --session /absolute/session/path --reply /absolute/reply.json',
      'npm run lab -- approve --session /absolute/session/path',
      'npm run lab -- inspect --session /absolute/session/path',
      'npm run lab -- doctor',
      '选项：--strategy full|tail|checkpoint --window 16000 --max-steps 30',
      '第一版只编辑已有文件；测试固定为 node --test test.test.mjs。先在 fixture 学习，不要直接跑业务仓库。',
    ].join('\n')); return;
  }
  if (command === 'doctor') {
    let baseUrlHost: string | null = null, baseUrlLooksInternalArk = false;
    try {
      const url = new URL(process.env.HARNESS_BASE_URL ?? '');
      baseUrlHost = url.host;
      baseUrlLooksInternalArk = url.host.endsWith('bytedance.net') && url.pathname.includes('/api/v3');
    } catch { /* 未配置或非法 URL 时只显示 null。 */ }
    console.log(JSON.stringify({ node: process.version, project: ROOT, traeDirectAPI: 'not-configured-or-confirmed',
      manualRelay: 'available; not API-equivalent', independentAPI: {
        baseUrlSet: !!process.env.HARNESS_BASE_URL, baseUrlHost, baseUrlLooksInternalArk,
        modelSet: !!process.env.HARNESS_MODEL, apiKeySet: !!process.env.HARNESS_API_KEY,
      } }, null, 2)); return;
  }
  if (command === 'start' || command === 'demo') {
    const p = value('provider', command === 'demo' ? 'mock' : 'manual');
    if (!['mock', 'manual', 'openai', 'ark'].includes(p ?? '')) throw new Error('provider 应为 mock/manual/openai/ark');
    if (p === 'openai' || p === 'ark') {
      if (!process.env.HARNESS_BASE_URL || !process.env.HARNESS_MODEL || !process.env.HARNESS_API_KEY) {
        throw new Error(`${p} 适配器需要 HARNESS_BASE_URL／HARNESS_MODEL／HARNESS_API_KEY；未创建会话，也不会使用 Trae 账号凭据`);
      }
    }
    const strategy = value('strategy', 'checkpoint');
    if (!['full', 'tail', 'checkpoint'].includes(strategy ?? '')) throw new Error('未知上下文策略');
    const maxSteps = numberArg('max-steps', 30);
    if (maxSteps < 1 || maxSteps > 100) throw new Error('max-steps 范围 1..100');
    const budget = { ...DEFAULT_BUDGET, window: numberArg('window', DEFAULT_BUDGET.window) };
    validateBudget(budget);
    const workspace = command === 'demo' || args.includes('--example') ? exampleWorkspace() : resolve(required('workspace'));
    if (!existsSync(workspace)) throw new Error('workspace 不存在');
    const sessionDir = resolve(ROOT, '.harness', 'sessions', randomUUID());
    const session = Session.create(sessionDir, {
      workspace, task: value('task', '修复 sum.mjs，使 sum(a,b) 返回加法结果，并运行测试证明。')!,
      provider: p as ProviderKind, strategy: strategy as Strategy, budget, maxSteps,
    });
    const state = await locked(session, () => run(session, providerFor(session), toolsFor(session)));
    showState(session, state); return;
  }
  const session = new Session(resolve(required('session')));
  if (command === 'inspect') {
    console.log(JSON.stringify({ config: session.config, timeline: session.events.map(e => e.type === 'request'
      ? { seq: e.seq, type: e.type, metrics: e.data.metrics }
      : e.type === 'proposal' ? { seq: e.seq, type: e.type, path: e.data.path, preview: e.data.preview }
      : e.type === 'stop' ? e : { seq: e.seq, type: e.type }), log: resolve(session.dir, 'events.jsonl') }, null, 2)); return;
  }
  await locked(session, async () => {
    if (command === 'import') {
      if (session.config.provider !== 'manual') throw new Error('import 仅用于 manual 会话');
      const request = session.pendingRequest(); if (!request) throw new Error('没有等待模型回复的请求');
      if (session.events.some(e => e.type === 'manual_reply' && e.data.requestId === request.id)) throw new Error('这次回复已导入；不重复导入');
      const reply = parseReply(readFileSync(resolve(required('reply')), 'utf8'), request.id);
      session.append('manual_reply', reply);
    } else if (command === 'approve') {
      const proposal = session.events.filter(e => e.type === 'proposal' && !session.events.some(a => a.type === 'approval' && a.data.requestId === e.data.requestId)).at(-1);
      if (!proposal || proposal.type !== 'proposal') throw new Error('没有待批准的提案');
      console.log(proposal.data.preview);
      const granted = await confirm('是否将这份提案应用到工作区？');
      console.log(toolsFor(session).approve(proposal.data.requestId, granted));
    } else if (command !== 'continue') throw new Error('未知命令');
    const state = await run(session, providerFor(session), toolsFor(session));
    if (state === 'awaiting-model') {
      const req = session.pendingRequest(); if (req) exportManualRequest(session, req);
    }
    showState(session, state);
  });
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
