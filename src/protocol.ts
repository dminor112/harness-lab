import type { Action, Reply } from './types.js';

export function record(value: unknown, label = 'object'): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
  return value as Record<string, unknown>;
}
export function string(value: unknown, label: string, max = 100000): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error(`${label} 必须是非空字符串，长度不超过 ${max}`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('包含协议未允许的字段');
}
/** 只做严格 JSON 解析，不从自然语言/Markdown 中偷偷猜测工具调用。 */
export function parseReply(raw: string, requestId: string): Reply {
  if (Buffer.byteLength(raw) > 262144) throw new Error('回复超过 256 KiB');
  const r = record(JSON.parse(raw), 'reply');
  keys(r, ['requestId', 'action']);
  if (r.requestId !== requestId) throw new Error('requestId 不匹配：可能是旧回复或其他会话');
  const a = record(r.action, 'action');
  let action: Action;
  if (a.kind === 'tool') {
    keys(a, ['kind', 'name', 'args']);
    action = { kind: 'tool', name: string(a.name, 'name', 80), args: record(a.args, 'args') };
  } else if (a.kind === 'final') {
    keys(a, ['kind', 'text']);
    action = { kind: 'final', text: string(a.text, 'text') };
  } else throw new Error('action.kind 仅支持 tool/final');
  return { requestId, action };
}
export function assertToolArgs(args: Record<string, unknown>, allowed: string[]): void { keys(args, allowed); }
export function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : value;
  if (!Number.isInteger(n) || (n as number) < min || (n as number) > max) throw new Error(`整数范围应为 ${min}..${max}`);
  return n as number;
}
