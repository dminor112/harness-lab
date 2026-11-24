/**
 * Codex 风格的交互入口（学习版）。
 *
 * 与 src/cli.ts 的区别：
 * - 一条命令直接接收任务，自动跑完整 Agent 循环；
 * - 工具输出会打印到终端，不再只显示 “read_file → ok”；
 * - 编辑与测试仍保留人工确认，不自动批准；
 * - 一次运行只处理一个任务，结束后可用 inspect 查看轨迹。
 *
 * 它没有做 Codex 的全部事情：没有 token streaming、没有通用 shell、没有 OS 沙箱，
 * 测试入口固定为 test.test.mjs。这里的目标是让“下任务 → 看动作 → 看结果”顺手，
 * 而不是把学习项目包装成生产级编码助手。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Session } from '../src/session.js';
import { providerFor } from '../src/providers.js';
import { Tools } from '../src/tools.js';
import { run } from '../src/runner.js';
import { validateBudget } from '../src/context.js';
import { DEFAULT_BUDGET } from '../src/types.js';
import type { ProviderKind, Strategy } from '../src/types.js';

// dist/scripts/agent.js → 仓库根。
const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * 极简参数解析：
 * - `--key value` 进入 flags；
 * - 没有值的 `--flag` 记为 true；
 * - 其余参数按空格拼成任务文本。
 *
 * 不做完整 shell 解析，避免引号/转义带来的隐式行为。
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
    'Harness Agent · Codex 风格学习入口',
    '',
    '用法：',
    '  npm run agent -- "修复 sum.mjs 的加法错误并跑测试"',
    '  npm run agent -- --workspace /path/to/disposable/repo "任务"',
    '  npm run agent -- --example',
    '  npm run agent -- --provider mock --example',
    '',
    '选项：',
    '  --workspace  工作区，默认当前目录',
    '  --provider   openai | ark | mock，默认 openai',
    '  --strategy   full | tail | checkpoint，默认 checkpoint',
    '  --window     上下文窗口粗估，默认 16000',
    '  --max-steps  最大动作轮次，默认 30',
    '  --task       任务文本（也可用位置参数）',
    '  --example    创建一次性 sum fixture 工作区',
    '',
    '说明：编辑和测试都会在终端里单独确认；不会自动 yes。',
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

/**
 * 创建一次性 sum fixture。
 * 只复制两个固定文件，避免默认把当前仓库当实验对象。
 */
function exampleWorkspace(): string {
  const path = resolve(ROOT, 'labs', 'sum-' + randomUUID().slice(0, 8));
  mkdirSync(path, { recursive: true });
  for (const name of ['sum.mjs', 'test.test.mjs']) {
    copyFileSync(resolve(ROOT, 'fixtures', name), resolve(path, name));
  }
  return path;
}

const useExample = flags.get('example') === true;
const workspace = useExample
  ? exampleWorkspace()
  : resolve(String(flags.get('workspace') ?? process.cwd()));

if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
  throw new Error(`workspace 不存在或不是目录：${workspace}`);
}

// 交互式确认只在 TTY 下启用；非 TTY 一律拒绝，避免 CI 自动批准。
const rl = process.stdin.isTTY
  ? createInterface({ input: process.stdin, output: process.stdout })
  : undefined;

/** 读取一个 yes/no；只有 y/yes 才算批准。 */
async function confirm(question: string): Promise<boolean> {
  if (!rl) {
    console.log('非交互终端，默认不批准。');
    return false;
  }
  const answer = (await rl.question(question + ' [y/N] ')).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * 打印最近一次工具结果。
 *
 * run() 的 onStep 在工具结果 append 后调用，因此这里读 last event 刚好是 tool_result。
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

async function main(): Promise<void> {
  let task = String(flags.get('task') ?? positionalTask).trim();

  if (!task) {
    if (useExample) {
      // --example 的默认任务与 fixture 匹配；这样 `npm run agent -- --example` 可直接演示。
      task = '修复 sum.mjs，使 sum(a,b) 返回加法结果，并运行测试证明。';
    } else if (!rl) {
      throw new Error('缺少任务文本；非交互终端请用 npm run agent -- "任务"');
    } else {
      task = (await rl.question('任务> ')).trim();
      if (!task) throw new Error('任务为空');
    }
  }

  const sessionDir = resolve(ROOT, '.harness', 'sessions', randomUUID());
  const session = Session.create(sessionDir, {
    workspace,
    task,
    provider: providerName as ProviderKind,
    strategy: strategy as Strategy,
    budget,
    maxSteps,
  });

  console.log(`\n工作区: ${workspace}`);
  console.log(`任务: ${task}`);
  console.log(`provider: ${providerName} · strategy: ${strategy} · maxSteps: ${maxSteps}`);
  console.log(`会话: ${session.dir}\n`);

  // 测试确认单独走一次交互；默认拒绝，不继承任何自动批准。
  const tools = new Tools(session, () => confirm('将执行工作区的 test.test.mjs（测试代码不是沙箱）。'));

  let state = await run(session, providerFor(session), tools, line => {
    console.log(`\n[step] ${line}`);
    printToolResult(session);
  });

  // 编辑提案循环：每次只处理一个提案，批准后继续跑。
  while (state === 'awaiting-approval') {
    const proposal = pendingProposal(session);
    if (!proposal || proposal.type !== 'proposal') throw new Error('状态是 awaiting-approval，但找不到待审批提案');

    console.log('\n--- 编辑提案 ---');
    console.log(proposal.data.preview);

    const granted = await confirm('应用这个编辑提案？');
    const result = tools.approve(proposal.data.requestId, granted);
    console.log(result.ok ? '编辑已应用。' : `未应用：${result.text}`);

    state = await run(session, providerFor(session), tools, line => {
      console.log(`\n[step] ${line}`);
      printToolResult(session);
    });
  }

  if (state === 'awaiting-model') {
    console.log('\n当前会话需要人工模型回复，请改用 npm run lab -- continue --session ' + session.dir);
  }

  const stop = session.events.filter(e => e.type === 'stop').at(-1);
  if (stop?.type === 'stop') {
    console.log('\n=== 最终结果 ===');
    console.log(stop.data.text);
    console.log(`验证状态: ${stop.data.reason === 'final-test-verified' ? '最近改动后有成功的测试证据' : '未验证，不能声称测试通过'}`);
  }

  console.log(`\n轨迹: npm run lab -- inspect --session ${session.dir}`);
  console.log(`原始日志: ${resolve(session.dir, 'events.jsonl')}`);
}

try {
  await main();
} catch (error) {
  console.error(`\n运行失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rl?.close();
}
