/**
 * Harness Agent · 常驻 REPL 入口。
 *
 * 目标是把学习项目用起来像常见 coding agent：
 * - 启动后保持一个进程，连续输入任务；
 * - 同一个会话保留之前的 user / assistant / tool_result 历史；
 * - 模型支持 SSE 时逐 token 打印，流结束后仍然做严格 JSON 校验；
 * - 编辑和测试继续人工确认，不因为“流式”而绕过门禁。
 *
 * 它不是生产级 Codex：没有通用 shell、没有 OS 沙箱，测试入口固定为
 * `node --test test.test.mjs`，只适合公开练习代码。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Session } from '../src/session.js';
import { providerFor } from '../src/providers.js';
import { Tools } from '../src/tools.js';
import { runTurn, continueTurn } from '../src/runner.js';
import { validateBudget } from '../src/context.js';
import { DEFAULT_BUDGET } from '../src/types.js';
import type { ModelProvider, ProviderKind, Strategy } from '../src/types.js';

// dist/scripts/agent.js → 仓库根。
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * 极简参数解析：
 * - `--key value` 进入 flags；
 * - 没有值的 `--flag` 记为 true；
 * - 其余参数按空格拼成首轮任务。
 */
function parseArgv(argv: string[]): { flags: Map<string, string | true>; task: string } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }

  return { flags, task: positional.join(' ').trim() };
}

const { flags, task: positionalTask } = parseArgv(process.argv.slice(2));

if (flags.has('help')) {
  console.log([
    'Harness Agent · 常驻 REPL',
    '',
    '用法：',
    '  npm run agent                          # 进入 REPL，提示首轮任务',
    '  npm run agent -- "修复 sum.mjs"         # 跑首轮后继续 REPL',
    '  npm run agent -- --example             # 一次性 fixture + 默认任务',
    '  npm run agent -- --oneshot "任务"        # 只跑一轮后退出',
    '',
    '选项：',
    '  --workspace  工作区，默认当前目录',
    '  --provider   openai | ark | mock，默认 openai',
    '  --strategy   full | tail | checkpoint，默认 checkpoint',
    '  --window     上下文窗口粗估，默认 16000',
    '  --max-steps  每轮最大动作次数，默认 30',
    '  --task       首轮任务文本（也可用位置参数）',
    '  --example    创建一次性 sum fixture 工作区',
    '  --oneshot    跑完首轮后退出，不进入后续对话',
    '',
    'REPL 命令：/help  /status  /new  /exit',
    '编辑和测试都会在终端里单独确认；非 TTY 默认拒绝。',
  ].join('\n'));
  process.exit(0);
}

const providerName = String(flags.get('provider') ?? 'openai');
if (!['openai', 'ark', 'mock'].includes(providerName)) {
  throw new Error('--provider 支持 openai | ark | mock；manual 请继续用 npm run lab');
}

const strategy = String(flags.get('strategy') ?? 'checkpoint');
if (!['full', 'tail', 'checkpoint'].includes(strategy)) throw new Error('--strategy 支持 full | tail | checkpoint');

const maxSteps = Number(flags.get('max-steps') ?? 30);
if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 100) throw new Error('--max-steps 范围 1..100');

const window = Number(flags.get('window') ?? DEFAULT_BUDGET.window);
const budget = { ...DEFAULT_BUDGET, window };
validateBudget(budget);

// 真实 provider 的凭据只从环境变量读取；缺失时在创建会话前失败。
if (providerName !== 'mock' && (!process.env.HARNESS_BASE_URL || !process.env.HARNESS_MODEL || !process.env.HARNESS_API_KEY)) {
  throw new Error(`${providerName} 需要 HARNESS_BASE_URL／HARNESS_MODEL／HARNESS_API_KEY；请先 source .env`);
}

/** 创建一次性 sum fixture；每个 /new 会话都拿一个干净目录。 */
function exampleWorkspace(): string {
  const path = resolve(ROOT, 'labs', 'sum-' + randomUUID().slice(0, 8));
  mkdirSync(path, { recursive: true });
  for (const name of ['sum.mjs', 'test.test.mjs']) {
    copyFileSync(resolve(ROOT, 'fixtures', name), resolve(path, name));
  }
  return path;
}

const useExample = flags.get('example') === true;
const baseWorkspace = useExample ? exampleWorkspace() : resolve(String(flags.get('workspace') ?? process.cwd()));
if (!existsSync(baseWorkspace) || !statSync(baseWorkspace).isDirectory()) {
  throw new Error(`workspace 不存在或不是目录：${baseWorkspace}`);
}

// 交互式确认只在 TTY 下启用；非 TTY 一律拒绝，避免 CI 自动批准。
const rl = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;

/** 读取一行；EOF/关闭返回 undefined，调用方自行退出。 */
async function ask(prompt: string): Promise<string | undefined> {
  if (!rl) return undefined;
  try { return (await rl.question(prompt)).trim(); }
  catch { return undefined; }
}

/** 读取一个 yes/no；只有 y/yes 才算批准。 */
async function confirm(question: string): Promise<boolean> {
  if (!rl) {
    console.log('非交互终端，默认不批准。');
    return false;
  }
  const answer = (await ask(question + ' [y/N] '))?.toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * 打印最近一次工具结果。
 *
 * run 的 onStep 在工具结果 append 后调用，因此 last event 刚好是 tool_result。
 * 输出截断到 1200 字符：学习时要看内容，但不能让一次搜索结果刷屏。
 */
function printToolResult(session: Session): void {
  const last = session.events.at(-1);
  if (last?.type !== 'tool_result') return;

  const text = last.data.result.text;
  const shown = text.length > 1200 ? text.slice(0, 1200) + '\n…（已截断，完整内容见 events.jsonl）' : text;
  console.log(`  ${last.data.name} ${last.data.result.ok ? 'ok' : 'error'}:`);
  console.log(shown.split('\n').map(line => '    ' + line).join('\n'));
}

/** 取最后一条尚未审批的 proposal；没有则返回 undefined。 */
function pendingProposal(session: Session) {
  return session.events.filter(e =>
    e.type === 'proposal' &&
    !session.events.some(a => a.type === 'approval' && a.data.requestId === e.data.requestId),
  ).at(-1);
}

interface Runtime {
  session: Session;
  provider: ModelProvider;
  tools: Tools;
  broken: boolean;
}

function createRuntime(task: string, workspace: string): Runtime {
  const session = Session.create(resolve(ROOT, '.harness', 'sessions', randomUUID()), {
    workspace,
    task,
    provider: providerName as ProviderKind,
    strategy: strategy as Strategy,
    budget,
    maxSteps,
  });
  return {
    session,
    provider: providerFor(session),
    // 测试确认单独走一次交互；不继承任何自动批准。
    tools: new Tools(session, () => confirm('将执行工作区的 test.test.mjs（测试代码不是沙箱）。')),
    broken: false,
  };
}

/**
 * 跑一轮并处理编辑审批。
 *
 * 流式 token 直接 write 到 stdout；onStreamEnd 只负责补换行，
 * 真正的协议解析和工具执行仍由 runner 在流结束后完成。
 */
async function executeTurn(runtime: Runtime, text: string, appendUser: boolean): Promise<void> {
  let streamed = false;
  const hooks = {
    onStep: (line: string): void => {
      console.log(`\n[step] ${line}`);
      printToolResult(runtime.session);
    },
    onToken: (token: string): void => {
      streamed = true;
      process.stdout.write(token);
    },
    onStreamEnd: (): void => {
      if (streamed) process.stdout.write('\n');
      streamed = false;
    },
  };

  try {
    let state = await runTurn(runtime.session, runtime.provider, runtime.tools, text, hooks, { appendUser });

    // 每次编辑提案单独确认；批准后用 continueTurn，避免把同一轮 user 再写一遍。
    while (state === 'awaiting-approval') {
      const proposal = pendingProposal(runtime.session);
      if (!proposal || proposal.type !== 'proposal') throw new Error('状态是 awaiting-approval，但找不到待审批提案');

      console.log('\n--- 编辑提案 ---');
      console.log(proposal.data.preview);
      const granted = await confirm('应用这个编辑提案？');
      const result = runtime.tools.approve(proposal.data.requestId, granted);
      console.log(result.ok ? '编辑已应用。' : `未应用：${result.text}`);

      state = await continueTurn(runtime.session, runtime.provider, runtime.tools, hooks);
    }

    if (state === 'awaiting-model') {
      console.log('\n当前会话需要人工模型回复，请改用 npm run lab -- continue --session ' + runtime.session.dir);
    }

    const stop = runtime.session.events.filter(e => e.type === 'stop').at(-1);
    if (stop?.type === 'stop') {
      console.log('\n=== 本轮结果 ===');
      console.log(stop.data.text);
      console.log(`验证状态: ${stop.data.reason === 'final-test-verified' ? '最近改动后有成功的测试证据' : '未验证，不能声称测试通过'}`);
      console.log(`会话: ${runtime.session.dir}`);
    }
  } catch (error) {
    // 协议/HTTP 错误通常没有写入 assistant，可以下一轮重试；
    // 若是工具动作没有对应 tool_result，则必须 /new，禁止盲目重放副作用。
    const lastAssistant = runtime.session.events.filter(e => e.type === 'assistant').at(-1);
    runtime.broken = lastAssistant?.type === 'assistant'
      && lastAssistant.data.action.kind === 'tool'
      && !runtime.session.events.some(e => e.type === 'tool_result' && e.data.requestId === lastAssistant.data.requestId);

    console.error(`\n本轮失败: ${error instanceof Error ? error.message : String(error)}`);
    // 失败后补一个 stop，避免下一次输入复用未完成的 request。
    if (runtime.session.events.at(-1)?.type !== 'stop') {
      runtime.session.append('stop', { reason: 'turn-error', text: '本轮失败，未声称任务完成；请检查轨迹后继续或使用 /new 开始新会话。' });
    }
    if (runtime.broken) console.log('检测到未完成的工具动作；请用 /new，不要直接重试。');
  }
}

function printStatus(runtime: Runtime): void {
  const stop = runtime.session.events.filter(e => e.type === 'stop').at(-1);
  console.log(`\n会话: ${runtime.session.dir}`);
  console.log(`事件数: ${runtime.session.events.length}`);
  console.log(`工作区: ${runtime.session.config.workspace}`);
  console.log(`当前轮任务: ${runtime.session.currentTask()}`);
  console.log(`状态: ${runtime.broken ? '本轮失败，需 /new' : stop?.type === 'stop' ? stop.data.reason : '可继续'}`);
}

async function main(): Promise<void> {
  let task = String(flags.get('task') ?? positionalTask).trim();

  if (!task) {
    if (useExample) {
      // --example 的默认任务与 fixture 匹配；这样 `npm run agent -- --example` 可直接演示。
      task = '修复 sum.mjs，使 sum(a,b) 返回加法结果，并运行测试证明。';
    } else if (!rl) {
      throw new Error('缺少任务文本；非交互终端请用 npm run agent -- "任务" 或 --task');
    } else {
      task = (await ask('首轮任务> ')) ?? '';
      if (!task) throw new Error('任务为空');
    }
  }

  let runtime = createRuntime(task, baseWorkspace);
  console.log('\nHarness Agent · REPL');
  console.log(`工作区: ${runtime.session.config.workspace}`);
  console.log(`首轮任务: ${task}`);
  console.log(`provider: ${providerName} · strategy: ${strategy} · maxSteps: ${maxSteps}`);
  console.log(`会话: ${runtime.session.dir}`);
  console.log('命令: /help  /status  /new  /exit；编辑和测试需要单独确认。');

  const oneshot = flags.get('oneshot') === true;
  let input = task;
  let appendUser = false;

  while (true) {
    await executeTurn(runtime, input, appendUser);

    // 非 TTY 或 --oneshot 时没有后续输入；跑完这一轮就结束。
    if (oneshot || !rl) break;

    const line = await ask('\n你> ');
    if (line === undefined) break;
    if (!line) continue;

    if (line === '/exit' || line === '/quit') break;
    if (line === '/help') {
      console.log('命令: /status 查看会话；/new 开新会话；/exit 退出。直接输入文本继续当前会话。');
      continue;
    }
    if (line === '/status') {
      printStatus(runtime);
      continue;
    }
    if (line === '/new') {
      const nextTask = await ask('新会话首轮任务> ');
      if (!nextTask) { console.log('未输入任务，已取消 /new。'); continue; }
      const workspace = useExample ? exampleWorkspace() : baseWorkspace;
      runtime = createRuntime(nextTask, workspace);
      input = nextTask;
      appendUser = false;
      continue;
    }
    if (runtime.broken) {
      console.log('当前会话本轮已失败；请用 /new 开始新会话，或 /exit。');
      continue;
    }

    input = line;
    appendUser = true;
  }

  console.log(`\n轨迹: npm run lab -- inspect --session ${runtime.session.dir}`);
  console.log(`原始日志: ${resolve(runtime.session.dir, 'events.jsonl')}`);
}

try {
  await main();
} catch (error) {
  console.error(`\n运行失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
