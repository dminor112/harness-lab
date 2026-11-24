/**
 * 顺序 Agent 循环。
 *
 * 每一轮：
 * 1. 检查会话是否已停止、是否有未完成动作；
 * 2. 检查步数上限；
 * 3. 复用未回答的 request，或编译一份新上下文；
 * 4. 调 provider，拿到严格 JSON 动作；
 * 5. 先持久化 assistant 动作，再执行工具；
 * 6. 工具结果写日志后进入下一轮。
 *
 * 关键取舍：
 * - 不自动重放中断的工具；
 * - 不把“模型说完成”当成“测试通过”；
 * - final 的 verified 只看最近一次成功编辑之后是否有成功的 run_tests。
 */
import { compileContext } from './context.js';
import { Session } from './session.js';
import { TOOL_SPECS, Tools, AwaitingEditApproval } from './tools.js';
import { AwaitingManualReply } from './types.js';
import type { ModelProvider } from './types.js';

/** 一次 run() 的结束状态；CLI 用它决定提示用户继续、审批还是结束。 */
export type RunState = 'stopped' | 'awaiting-model' | 'awaiting-approval';

/**
 * 运行 Agent 循环。
 *
 * onStep 是轻量观测回调，默认打印一行；测试里传空函数避免污染 TAP 输出。
 */
export async function run(
  session: Session,
  provider: ModelProvider,
  tools: Tools,
  onStep: (line: string) => void = console.log,
): Promise<RunState> {
  if (session.stopped()) return 'stopped';

  /**
   * 恢复前的安全检查。
   *
   * 如果最后一条 assistant 是 tool 动作，但没有对应 tool_result：
   * - 有 approval：说明审批已记录、文件可能已写、结果可能没记，必须人工核查；
   * - 有 proposal：说明还在等审批，安全地回到 awaiting-approval；
   * - 都没有：说明工具执行到一半中断，不能猜它是否产生副作用。
   */
  const lastAction = session.events.filter(e => e.type === 'assistant').at(-1);
  if (lastAction?.type === 'assistant' && lastAction.data.action.kind === 'tool'
    && !session.events.some(e => e.type === 'tool_result' && e.data.requestId === lastAction.data.requestId)) {
    if (session.events.some(e => e.type === 'approval' && e.data.requestId === lastAction.data.requestId)) {
      throw new Error('审批已记录但缺少工具结果：可能上次进程在写入／记账之间崩溃。禁止自动重放；请人工核查文件与应用状态。');
    }
    if (session.events.some(e => e.type === 'proposal' && e.data.requestId === lastAction.data.requestId)) {
      return 'awaiting-approval';
    }
    throw new Error('发现未完成工具动作，可能上次进程中断。禁止盲目重放；请人工检查文件／测试状态并使用新会话');
  }

  while (true) {
    // 步数按 assistant 动作计数；final 也算一步，防止无限“最后再说一句”。
    const steps = session.events.filter(e => e.type === 'assistant').length;
    if (steps >= session.config.maxSteps) {
      session.append('stop', { reason: 'step-limit', text: '达到最大动作轮次，未声称任务完成。' });
      return 'stopped';
    }

    /**
     * 优先复用 pendingRequest：进程暂停/重启后，同一个 requestId 继续，
     * 避免重新编译导致模型看到不同上下文却按旧回复执行。
     */
    const request = session.pendingRequest() ?? compileContext(session, TOOL_SPECS);
    if (!session.pendingRequest()) session.append('request', request);

    onStep(`step ${steps + 1} · input≈${request.metrics.selectedTokens}/${request.metrics.inputLimit} · omitted=${request.metrics.omittedUnits} · provider=${provider.name}`);

    let result;
    const started = performance.now();
    try {
      result = await provider.complete(request);
    } catch (error) {
      // manual 是正常暂停，不是错误；其余 provider/协议错误记录摘要后向上抛。
      if (error instanceof AwaitingManualReply) return 'awaiting-model';
      session.append('error', {
        code: 'provider-or-protocol',
        message: '模型请求失败或 JSON 协议无效。未保存凭据或完整远端错误，未自动重试。',
      });
      throw error;
    }

    const { reply, usage } = result;
    if (reply.requestId !== request.id) throw new Error('Provider 回复请求号不匹配');

    /**
     * 先写 assistant 事件，再执行工具。
     * 这样即使工具执行到一半崩溃，日志也能看出“模型已经要求做什么”，
     * 恢复时可以选择停止而不是重放未知副作用。
     */
    session.append('assistant', {
      requestId: request.id,
      action: reply.action,
      latencyMs: Math.round(performance.now() - started),
      ...usage === undefined ? {} : { usage },
    });

    if (reply.action.kind === 'final') {
      /**
       * verified 不是“模型说测试通过”，而是：
       * - 最近一次 run_tests 的 tool_result.ok 为 true；
       * - 该测试事件的 seq 晚于最近一次成功的 propose_edit。
       *
       * 这仍然只证明固定入口返回 0；normal CLI 不保证测试文件未被批准修改。
       * 更严格的 testUnchanged 检查在 scripts/evaluate.ts 里。
       */
      const results = session.events.filter(e => e.type === 'tool_result');
      const editSeq = results.filter(e => e.data.name === 'propose_edit' && e.data.result.ok).at(-1)?.seq ?? 0;
      const test = results.filter(e => e.data.name === 'run_tests').at(-1);
      const verified = test !== undefined && test.data.result.ok && test.seq > editSeq;

      session.append('stop', { reason: verified ? 'final-test-verified' : 'final-unverified', text: reply.action.text });
      onStep(`模型最终回复（${verified ? '最近改动后有通过的测试证据' : '未验证：不可据此声称测试通过'}）：\n${reply.action.text}`);
      return 'stopped';
    }

    /**
     * 重复动作保护：连续三次完全相同的动作，不执行第三次，直接停止。
     * 这是防“读同一个文件/跑同一个测试”空转的最低成本 guard，不是通用循环检测。
     */
    const action = reply.action;
    const recent = session.events.filter(e => e.type === 'assistant').slice(-3);
    if (recent.length === 3 && recent.every(e => JSON.stringify(e.data.action) === JSON.stringify(action))) {
      session.append('tool_result', {
        name: action.name,
        requestId: request.id,
        result: { ok: false, text: '连续三个相同动作，当前动作未执行；停止以防空转。' },
      });
      session.append('stop', { reason: 'repetition', text: '重复动作上限。' });
      return 'stopped';
    }

    try {
      const toolResult = await tools.execute(action.name, action.args, request.id);
      session.append('tool_result', { name: action.name, requestId: request.id, result: toolResult });
      onStep(`${action.name} → ${toolResult.ok ? 'ok' : 'error'}`);
    } catch (error) {
      // 编辑提案是控制流：proposal 已写日志，文件未落盘，等人工审批。
      if (error instanceof AwaitingEditApproval) return 'awaiting-approval';
      throw error;
    }
  }
}
