import { compileContext } from './context.js';
import { Session } from './session.js';
import { TOOL_SPECS, Tools, AwaitingEditApproval } from './tools.js';
import { AwaitingManualReply } from './types.js';
import type { ModelProvider } from './types.js';

export type RunState = 'stopped' | 'awaiting-model' | 'awaiting-approval';
/** 不对中断的工具自动重放；每一轮先持久化模型动作，再执行。 */
export async function run(session: Session, provider: ModelProvider, tools: Tools, onStep: (line: string) => void = console.log): Promise<RunState> {
  if (session.stopped()) return 'stopped';
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
    const steps = session.events.filter(e => e.type === 'assistant').length;
    if (steps >= session.config.maxSteps) {
      session.append('stop', { reason: 'step-limit', text: '达到最大动作轮次，未声称任务完成。' }); return 'stopped';
    }
    const request = session.pendingRequest() ?? compileContext(session, TOOL_SPECS);
    if (!session.pendingRequest()) session.append('request', request);
    onStep(`step ${steps + 1} · input≈${request.metrics.selectedTokens}/${request.metrics.inputLimit} · omitted=${request.metrics.omittedUnits} · provider=${provider.name}`);
    let result;
    const started = performance.now();
    try { result = await provider.complete(request); }
    catch (error) {
      if (error instanceof AwaitingManualReply) return 'awaiting-model';
      session.append('error', { code: 'provider-or-protocol', message: '模型请求失败或 JSON 协议无效。未保存凭据或完整远端错误，未自动重试。' });
      throw error;
    }
    const { reply, usage } = result;
    if (reply.requestId !== request.id) throw new Error('Provider 回复请求号不匹配');
    session.append('assistant', { requestId: request.id, action: reply.action, latencyMs: Math.round(performance.now() - started), ...usage === undefined ? {} : { usage } });
    if (reply.action.kind === 'final') {
      const results = session.events.filter(e => e.type === 'tool_result');
      const editSeq = results.filter(e => e.data.name === 'propose_edit' && e.data.result.ok).at(-1)?.seq ?? 0;
      const test = results.filter(e => e.data.name === 'run_tests').at(-1);
      const verified = test !== undefined && test.data.result.ok && test.seq > editSeq;
      session.append('stop', { reason: verified ? 'final-test-verified' : 'final-unverified', text: reply.action.text });
      onStep(`模型最终回复（${verified ? '最近改动后有通过的测试证据' : '未验证：不可据此声称测试通过'}）：\n${reply.action.text}`);
      return 'stopped';
    }
    const action = reply.action;
    const recent = session.events.filter(e => e.type === 'assistant').slice(-3);
    if (recent.length === 3 && recent.every(e => JSON.stringify(e.data.action) === JSON.stringify(action))) {
      session.append('tool_result', { name: action.name, requestId: request.id, result: { ok: false, text: '连续三个相同动作，当前动作未执行；停止以防空转。' } });
      session.append('stop', { reason: 'repetition', text: '重复动作上限。' }); return 'stopped';
    }
    try {
      const toolResult = await tools.execute(action.name, action.args, request.id);
      session.append('tool_result', { name: action.name, requestId: request.id, result: toolResult });
      onStep(`${action.name} → ${toolResult.ok ? 'ok' : 'error'}`);
    } catch (error) {
      if (error instanceof AwaitingEditApproval) return 'awaiting-approval';
      throw error;
    }
  }
}
