/**
 * 追加式会话日志。
 *
 * 设计目标：
 * - 原始事件只 append，不 update/delete；
 * - 上下文压缩只影响“本次发给模型的投影”，不改原始历史；
 * - 恢复时按 seq 重建内存视图；
 * - 单写者锁由 CLI 持有，Session 本身不提供并发写保护。
 *
 * 这不是事务数据库：没有 fsync、跨文件原子提交和 exactly-once。
 * 因此遇到半行日志、未完成工具或已审批未落盘时，选择停止并人工检查，
 * 而不是自动修复/重放。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { EventData, EventType, LogEvent, ModelRequest, SessionConfig } from './types.js';

export class Session {
  /** 会话目录；request.md、reply.json、writer.lock、events.jsonl 都在这里。 */
  readonly dir: string;
  /** 追加日志文件的绝对路径。 */
  private readonly journal: string;
  /** 内存中的事件视图；每次 append 同步追加，读取时返回克隆。 */
  private entries: LogEvent[];

  constructor(dir: string) {
    this.dir = resolve(dir);
    // 0700：会话里可能包含代码片段和任务内容，默认只允许当前用户访问。
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.journal = resolve(this.dir, 'events.jsonl');
    this.entries = [];

    if (existsSync(this.journal)) {
      const raw = readFileSync(this.journal, 'utf8');
      // 崩溃可能留下没有换行符的半行。半行意味着“上一次写入结果未知”，
      // 此时不能猜测最后一条事件是否生效，更不能重放副作用。
      if (raw && !raw.endsWith('\n')) throw new Error('日志末行不完整；先人工检查，未自动修复或重放');

      this.entries = raw.split('\n').filter(Boolean).map((line, i) => {
        const e = JSON.parse(line) as LogEvent;
        // seq 必须从 1 连续递增；结构缺字段说明日志被截断或手工改坏。
        if (e.seq !== i + 1 || !e.type || !e.data) throw new Error('日志序号或结构损坏');
        return e;
      });
    }
  }

  /**
   * 新建会话。
   *
   * - 目录必须为空（entries.length === 0），避免覆盖旧会话；
   * - workspace 先 realpath，防止后续路径比较被 symlink 绕过；
   * - 第一条事件固定为 config，作为整个会话不可变的配置来源。
   */
  static create(dir: string, config: SessionConfig): Session {
    const s = new Session(dir);
    if (s.entries.length) throw new Error('会话目录已存在，不覆盖');
    const workspace = realpathSync(config.workspace);
    s.append('config', { ...config, workspace });
    return s;
  }

  /** 返回事件克隆，调用方无法通过修改返回值污染内存日志。 */
  get events(): readonly LogEvent[] {
    return structuredClone(this.entries);
  }

  /** 读取首条 config 事件；缺失或类型不对说明日志不是本程序创建的。 */
  get config(): SessionConfig {
    const first = this.entries[0];
    if (first?.type !== 'config') throw new Error('没有会话配置');
    return structuredClone(first.data);
  }

  /**
   * 追加一条事件。
   *
   * 先写文件、再 push 内存：如果文件写失败，内存不会出现“已存在但未持久化”的
   * 假事件；如果进程在写文件后崩溃，恢复时最多看到已写入的完整行。
   * 这里使用 appendFileSync，未做 fsync，仍可能丢最后一条。
   */
  append<K extends EventType>(type: K, data: EventData[K]): LogEvent {
    const event = {
      seq: this.entries.length + 1,
      at: new Date().toISOString(),
      type,
      data: structuredClone(data),
    } as LogEvent;
    appendFileSync(this.journal, JSON.stringify(event) + '\n', { mode: 0o600 });
    this.entries.push(event);
    return structuredClone(event);
  }

  /**
   * 找出“已发出但尚未被回答”的 request。
   *
   * 从后往前看：
   * - 遇到 assistant/stop，说明该 request 已被处理或会话已结束；
   * - 遇到 request，说明它还没有对应 assistant，是待恢复的请求。
   * 这样进程重启后可以继续同一请求，而不是重新编译一份新上下文。
   */
  pendingRequest(): ModelRequest | undefined {
    for (const e of [...this.entries].reverse()) {
      if (e.type === 'assistant' || e.type === 'stop') return undefined;
      if (e.type === 'request') return structuredClone(e.data);
    }
    return undefined;
  }

  /** 会话是否已经写入 stop 事件。 */
  stopped(): boolean {
    return this.entries.some(e => e.type === 'stop');
  }

  /** 最近 8 条模型笔记；checkpoint 只注入这些，原始 note 事件仍在日志中。 */
  notes(): string[] {
    return this.entries.filter(e => e.type === 'note').map(e => e.data.text).slice(-8);
  }

  /**
   * 在原始事件中做定向检索。
   *
   * 这是“历史恢复”而不是“把整本历史重新灌回上下文”：
   * 模型先用 search 找到相关 seq，再用 history_read 分页读取。
   * 这里返回 2000 字符摘要，避免一次检索就把上下文撑爆。
   */
  search(query: string, limit = 10): Array<{ seq: number; type: string; excerpt: string }> {
    return this.entries
      .filter(e => e.type !== 'request' && JSON.stringify(e.data).includes(query))
      .slice(-limit)
      .map(e => ({ seq: e.seq, type: e.type, excerpt: JSON.stringify(e.data).slice(0, 2000) }));
  }
}
