/**
 * 严格 JSON 动作协议。
 *
 * 这里故意不做“从自然语言里猜工具调用”的兼容：
 * - 模型输出必须是单个 JSON 对象；
 * - 不允许 Markdown 围栏、前后解释、未知字段；
 * - requestId 必须匹配当前请求。
 *
 * 严格解析的价值是让失败可定位：协议错误就是协议错误，不会被静默当成
 * “模型其实想调用工具”，从而掩盖上下文或提示词问题。
 */
import type { Action, Reply } from './types.js';

/** 确认 value 是普通对象（不是 null、数组或函数），否则抛出带 label 的错误。 */
export function record(value: unknown, label = 'object'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}

/** 确认 value 是非空字符串且不超过 max 字符；用于限制工具参数和最终文本的体量。 */
export function string(value: unknown, label: string, max = 100000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label} 必须是非空字符串，长度不超过 ${max}`);
  return value;
}

/**
 * 拒绝对象中的未知字段。
 *
 * 这不是 JSON Schema 的完整校验，而是一道“协议面收敛”门禁：
 * 新增字段必须同时改协议和调用方，避免模型悄悄塞入未定义语义。
 */
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('包含协议未允许的字段');
}

/**
 * 解析模型回复。
 *
 * 顺序很重要：
 * 1. 先做字节上限，防止超大响应拖垮日志/内存；
 * 2. 再 JSON.parse，语法错误直接失败；
 * 3. 校验外层字段和 requestId，拒绝旧回复/串会话；
 * 4. 校验 action 形状，只允许 tool/final 两种。
 */
export function parseReply(raw: string, requestId: string): Reply {
  // 256 KiB 是学习项目的硬上限；真实模型长回复应先在外层裁剪或分页。
  if (Buffer.byteLength(raw) > 262144) throw new Error('回复超过 256 KiB');
  const r = record(JSON.parse(raw), 'reply');
  keys(r, ['requestId', 'action']);
  // requestId 是防重放/防串会话的关键；不匹配时不能“将就使用”。
  if (r.requestId !== requestId) throw new Error('requestId 不匹配：可能是旧回复或其他会话');
  const a = record(r.action, 'action');
  let action: Action;
  if (a.kind === 'tool') {
    keys(a, ['kind', 'name', 'args']);
    action = { kind: 'tool', name: string(a.name, 'name', 80), args: record(a.args, 'args') };
  } else if (a.kind === 'final') {
    keys(a, ['kind', 'text']);
    action = { kind: 'final', text: string(a.text, 'text') };
  } else {
    // 未知 kind 不做兼容猜测，直接失败。
    throw new Error('action.kind 仅支持 tool/final');
  }
  return { requestId, action };
}

/** 工具执行前的参数白名单校验；具体类型/范围由各工具自己再校验。 */
export function assertToolArgs(args: Record<string, unknown>, allowed: string[]): void {
  keys(args, allowed);
}

/**
 * 解析命令行/工具参数中的整数。
 *
 * fallback 只在字段缺失时使用；显式传入 null、字符串或越界值都会失败，
 * 避免“看起来能跑，其实用了默认值”的隐性行为。
 */
export function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`整数范围应为 ${min}..${max}`);
  return n as number;
}
