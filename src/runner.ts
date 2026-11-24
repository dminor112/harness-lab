import { compileContext } from './context.js';
import { Session } from './session.js';
import { TOOL_SPECS, Tools, AwaitingEditApproval } from './tools.js';
import { AwaitingManualReply } from './types.js';
import type { LogEvent, ModelProvider } from './types.js';

export type RunState = 'stopped' | 'awaiting-model' | 'awaiting-approval';

/**
 * 一次 Agent 循环的观察钩子。
 *
 * onStep 用于打印步骤/工具状态；onToken 仅在 provider 支持流式时使用；
 * onStreamEnd 在流结束（成功或中途失败）时调用一次，让终端补换行。
 */
export interface RunHooks {
  onStep: (line: string) => void;
  onToken?: (token: string) => void;
  onStreamEnd?: () => void;
  signal?: AbortSignal;
}

/**
 * 所有运行路径共用的循环。
 *
 * turnStartSeq 是“本轮”的起点：首轮为 0，REPL 后续轮为最后一条 user 事件的 seq。
 * checkStopped 只给旧的单任务 run 使用；REPL 的会话会保留上一轮 stop，
 * 但新一轮必须继续，因此 runTurn/continueTurn 传 false。
 */
async function runLoop(
  session: Session,
  provider: ModelProvider,
  tools: Tools,
  hooks: RunHooks,
  turnStartSeq: number,
  checkStopped: boolean,
): Promise<RunState> {
  if (checkStopped && session.stopped()) return 'stopped';

  // 不对中断的工具自动重放；每一轮先持久化模型动作，再执行。
  const lastAction = session.events.filter(e => e.type === 'assistant').at(-1);
  if (lastAction?.type === 'assistant' && lastAction.data.action.kind === 'tool'
    && !session.events.some(e => e.type === 'tool_result' && e.data.requestId === lastAction.data.requestId)) {
    if (session.events.some(e => e.type === 'approval' && e.data.requestId === lastAction.data.requestId)) {
      throw new Error('审批已记录但缺少工具结果：可能上次进程在写入／记账之间崩溃。禁止自动重放；请人工核查文件与应用状态。');
    }
    if (session.events.some(e => e.type === 'proposal' && e.data.requestId === lastAction.data.requestId)) return 'awaiting-approval';
    throw new Error('发现未完成工具动作，可能上次进程中断。禁止盲目重放；请人工检查文件／测试状态并使用新会话');
  }

  while (true) {
    // 轮次计数只算本轮 assistant；否则 REPL 第二轮会继承第一轮步数而提前触顶。
    const steps = session.events.filter(e => e.type === 'assistant' && e.seq > turnStartSeq).length;
    if (steps >= session.config.maxSteps) {
      session.append('stop', { reason: 'step-limit', text: '达到最大动作轮次，未声称任务完成。' });
      return 'stopped';
    }

    // 当前轮任务由 taskMessage 表达；历史中的同一条 user 事件通过 excludeUserSeq 跳过。
    const currentTask = session.currentTask();
    const request = session.pendingRequest() ?? compileContext(session, TOOL_SPECS, session.config.strategy, currentTask, turnStartSeq);
    if (!session.pendingRequest()) session.append('request', request);
    hooks.onStep(`step ${steps + 1} · input≈${request.metrics.selectedTokens}/${request.metrics.inputLimit} · omitted=${request.metrics.omittedUnits} · provider=${provider.name}`);

    let result;
    let streamed = false;
    const started = performance.now();
    try {
      if (hooks.onToken !== undefined && typeof provider.stream === 'function') {
        // 先打印增量 token；整段 JSON 仍然要等流结束后做严格解析，不能边流边执行。
        streamed = true;
        result = await provider.stream(request, hooks.onToken, hooks.signal);
      } else {
        result = await provider.complete(request, hooks.signal);
      }
    } catch (error) {
      if (streamed) hooks.onStreamEnd?.();
      if (error instanceof AwaitingManualReply) return 'awaiting-model';
      session.append('error', { code: 'provider-or-protocol', message: '模型请求失败或 JSON 协议无效。未保存凭据或完整远端错误，未自动重试。' });
      throw error;
    }
    if (streamed) hooks.onStreamEnd?.();

    const { reply, usage } = result;
    if (reply.requestId !== request.id) throw new Error('Provider 回复请求号不匹配');
    session.append('assistant', { requestId: request.id, action: reply.action, latencyMs: Math.round(performance.now() - started), ...usage === undefined ? {} : { usage } });

    if (reply.action.kind === 'final') {
      // 验证只看本轮：上一轮的测试不能替本轮的新改动背书。
      const results = session.events.filter(
        (e): e is Extract<LogEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.seq > turnStartSeq,
      );
      const editSeq = results.filter(e => e.data.name === 'propose_edit' && e.data.result.ok).at(-1)?.seq ?? 0;
      const test = results.filter(e => e.data.name === 'run_tests').at(-1);
      const verified = test !== undefined && test.data.result.ok && test.seq > editSeq;
      session.append('stop', { reason: verified ? 'final-test-verified' : 'final-unverified', text: reply.action.text });
      hooks.onStep(`模型最终回复（${verified ? '最近改动后有通过的测试证据' : '未验证：不可据此声称测试通过'}）：\n${reply.action.text}`);
      return 'stopped';
    }

    const action = reply.action;
    const recent = session.events.filter(
      (e): e is Extract<LogEvent, { type: 'assistant' }> => e.type === 'assistant' && e.seq > turnStartSeq,
    ).slice(-3);
    if (recent.length === 3 && recent.every(e => JSON.stringify(e.data.action) === JSON.stringify(action))) {
      session.append('tool_result', { name: action.name, requestId: request.id, result: { ok: false, text: '连续三个相同动作，当前动作未执行；停止以防空转。' } });
      session.append('stop', { reason: 'repetition', text: '重复动作上限。' });
      return 'stopped';
    }

    try {
      const toolResult = await tools.execute(action.name, action.args, request.id);
      session.append('tool_result', { name: action.name, requestId: request.id, result: toolResult });
      hooks.onStep(`${action.name} → ${toolResult.ok ? 'ok' : 'error'}`);
    } catch (error) {
      if (error instanceof AwaitingEditApproval) return 'awaiting-approval';
      throw error;
    }
  }
}

/** 单任务入口：保持原有 start/continue 的语义，遇到 stop 不再继续。 */
export async function run(
  session: Session,
  provider: ModelProvider,
  tools: Tools,
  onStep: (line: string) => void = console.log,
): Promise<RunState> {
  return await runLoop(session, provider, tools, { onStep }, 0, true);
}

/**
 * REPL 的一轮：先写入 user 事件，再跑本轮循环。
 *
 * 首轮由 Session.create 的 config.task 承担，传 appendUser=false；
 * 后续轮 appendUser=true，历史里会保留之前的 user/assistant 单元。
 */
export async function runTurn(
  session: Session,
  provider: ModelProvider,
  tools: Tools,
  userText: string,
  hooks: RunHooks,
  options: { appendUser?: boolean } = {},
): Promise<RunState> {
  const text = userText.trim();
  if (!text) throw new Error('用户输入为空');
  if (options.appendUser !== false) session.append('user', { text });
  return await runLoop(session, provider, tools, hooks, session.currentTurnStartSeq(), false);
}

/** 审批后继续当前轮；不能再追加 user 事件，否则同一轮会被重复计入。 */
export async function continueTurn(
  session: Session,
  provider: ModelProvider,
  tools: Tools,
  hooks: RunHooks,
): Promise<RunState> {
  return await runLoop(session, provider, tools, hooks, session.currentTurnStartSeq(), false);
}
