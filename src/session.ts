import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EventData, EventType, LogEvent, ModelRequest, SessionConfig } from './types.js';

/** 原始日志只追加；上下文的删减永远不修改这里的历史。单写者锁由 CLI 持有。 */
export class Session {
  readonly dir: string;
  private readonly journal: string;
  private entries: LogEvent[];
  constructor(dir: string) {
    this.dir = resolve(dir);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.journal = resolve(this.dir, 'events.jsonl');
    this.entries = [];
    if (existsSync(this.journal)) {
      const raw = readFileSync(this.journal, 'utf8');
      // 崩溃产生的半行不盲目修复；拒绝继续，避免重复执行副作用。
      if (raw && !raw.endsWith('\n')) throw new Error('日志末行不完整；先人工检查，未自动修复或重放');
      this.entries = raw.split('\n').filter(Boolean).map((line, i) => {
        const e = JSON.parse(line) as LogEvent;
        if (e.seq !== i + 1 || !e.type || !e.data) throw new Error('日志序号或结构损坏');
        return e;
      });
    }
  }
  static create(dir: string, config: SessionConfig): Session {
    const s = new Session(dir);
    if (s.entries.length) throw new Error('会话目录已存在，不覆盖');
    const workspace = realpathSync(config.workspace);
    s.append('config', { ...config, workspace });
    return s;
  }
  get events(): readonly LogEvent[] { return structuredClone(this.entries); }
  get config(): SessionConfig {
    const first = this.entries[0];
    if (first?.type !== 'config') throw new Error('没有会话配置');
    return structuredClone(first.data);
  }
  /** REPL 当前轮的任务文本：优先取最后一条 user 事件，否则用首轮 config.task。 */
  currentTask(): string {
    const user = this.entries.filter(e => e.type === 'user').at(-1);
    return user?.type === 'user' ? user.data.text : this.config.task;
  }
  /** 当前轮的起点：最后一条 user 的 seq；首轮没有 user，返回 0。 */
  currentTurnStartSeq(): number {
    const user = this.entries.filter(e => e.type === 'user').at(-1);
    return user?.seq ?? 0;
  }
  append<K extends EventType>(type: K, data: EventData[K]): LogEvent {
    const event = { seq: this.entries.length + 1, at: new Date().toISOString(), type, data: structuredClone(data) } as LogEvent;
    appendFileSync(this.journal, JSON.stringify(event) + '\n', { mode: 0o600 });
    this.entries.push(event);
    return structuredClone(event);
  }
  pendingRequest(): ModelRequest | undefined {
    for (const e of [...this.entries].reverse()) {
      if (e.type === 'assistant' || e.type === 'stop') return undefined;
      if (e.type === 'request') return structuredClone(e.data);
    }
    return undefined;
  }
  stopped(): boolean { return this.entries.some(e => e.type === 'stop'); }
  notes(): string[] { return this.entries.filter(e => e.type === 'note').map(e => e.data.text).slice(-8); }
  /** 搜索旧原文而不是把整本历史重新灌回上下文。 */
  search(query: string, limit = 10): Array<{ seq: number; type: string; excerpt: string }> {
    return this.entries.filter(e => e.type !== 'request' && JSON.stringify(e.data).includes(query))
      .slice(-limit).map(e => ({ seq: e.seq, type: e.type, excerpt: JSON.stringify(e.data).slice(0, 2000) }));
  }
}
