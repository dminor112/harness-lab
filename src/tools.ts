import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { Session } from './session.js';
import { assertToolArgs, int, record, string } from './protocol.js';
import type { ToolResult, ToolSpec } from './types.js';

const ignored = new Set(['.git', '.harness', 'node_modules', 'dist', 'upstream', '.ssh']);
const sensitive = (name: string): boolean => /^\.env(?:\.|$)/i.test(name) || /\.(pem|key|p12|pfx)$/i.test(name) || /^(credentials|id_rsa|id_ed25519)$/i.test(name);
const schema = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' };
export const TOOL_SPECS: ToolSpec[] = [
  { name: 'list_files', description: '列出工作区普通文件，不跟随符号链接，不返回敏感文件。', parameters: schema({}, []) },
  { name: 'read_file', description: '按行读取工作区文本文件（1-based）。', parameters: schema({ path: str, start: { type: 'integer' }, lines: { type: 'integer' } }, ['path']) },
  { name: 'search_files', description: '普通字符串搜索，返回有限的文件名、行号和行内容。', parameters: schema({ query: str }, ['query']) },
  { name: 'propose_edit', description: '对已经读取的文件提出唯一精确替换；不会自动落盘，需要人工批准。', parameters: schema({ path: str, old: str, replacement: str }, ['path', 'old', 'replacement']) },
  { name: 'run_tests', description: '经人工确认，用 node --test test.test.mjs 运行工作区测试；无任意 shell。', parameters: schema({}, []) },
  { name: 'save_note', description: '保存短的阶段笔记：目标、约束、文件、验证证据、失败和下一步。', parameters: schema({ text: str }, ['text']) },
  { name: 'history_search', description: '定向检索已离开上下文的原始事件。', parameters: schema({ query: str }, ['query']) },
  { name: 'history_read', description: '按事件 seq 恢复 assistant/tool_result/note 原文；按 offset/limit 分页。', parameters: schema({ seq: { type: 'integer' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, ['seq']) },
];
export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export class AwaitingEditApproval extends Error {
  constructor(public requestId: string) { super('编辑提案等待人工批准'); }
}
/** 防止路径穿越及已有 symlink；不是 OS 沙箱，不覆盖恶意并发文件替换。 */
export function safePath(workspace: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes('\0')) throw new Error('只允许工作区相对路径');
  const root = realpathSync(workspace), target = resolve(root, name), rel = relative(root, target);
  if (!rel || rel === '..' || rel.startsWith('..' + sep)) throw new Error('路径越过工作区边界');
  let cursor = root;
  for (const part of rel.split(sep)) {
    if (ignored.has(part) || sensitive(part)) throw new Error('受保护目录／敏感文件不可访问');
    cursor = resolve(cursor, part);
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('不允许符号链接');
  }
  if (!existsSync(target)) throw new Error('目标不存在；第一版只读取／修改已存在的普通文件');
  if (!lstatSync(target).isFile()) throw new Error('目标必须是普通文件');
  return target;
}
function textFile(path: string): string {
  if (lstatSync(path).size > 262144) throw new Error('文件超过 256 KiB；请先缩小范围');
  const text = readFileSync(path, 'utf8');
  if (text.includes('\0')) throw new Error('不读取二进制文件');
  return text;
}
export class Tools {
  constructor(readonly session: Session, private confirmTests: () => Promise<boolean> = async () => false) {}
  private files(): string[] {
    const root = this.session.config.workspace;
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 6 || found.length >= 200) return;
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (found.length >= 200) return;
        if (ignored.has(e.name) || sensitive(e.name) || e.isSymbolicLink()) continue;
        const path = resolve(dir, e.name);
        if (e.isDirectory()) walk(path, depth + 1);
        else if (e.isFile()) found.push(relative(root, path));
      }
    };
    walk(root, 0); return found;
  }
  async execute(name: string, args: Record<string, unknown>, requestId: string): Promise<ToolResult> {
    const root = this.session.config.workspace;
    try {
      switch (name) {
        case 'list_files':
          assertToolArgs(args, []); return { ok: true, text: JSON.stringify({ files: this.files(), bounded: 'max 200 files, depth 6' }) };
        case 'read_file': {
          assertToolArgs(args, ['path', 'start', 'lines']);
          const path = string(args.path, 'path', 300), start = int(args.start, 1, 1, 100000), lines = int(args.lines, 100, 1, 200);
          const text = textFile(safePath(root, path)), all = text.split('\n');
          return { ok: true, text: JSON.stringify({ path, hash: hash(text), start, totalLines: all.length,
            text: all.slice(start - 1, start - 1 + lines).map((l, i) => `${start + i}: ${l}`).join('\n') }) };
        }
        case 'search_files': {
          assertToolArgs(args, ['query']); const query = string(args.query, 'query', 200), hits: unknown[] = [];
          for (const file of this.files()) {
            try { textFile(safePath(root, file)).split('\n').forEach((line, i) => {
              if (line.includes(query) && hits.length < 50) hits.push({ path: file, line: i + 1, text: line.slice(0, 500) });
            }); } catch { /* 边界文件不扩大读取范围。 */ }
          }
          return { ok: true, text: JSON.stringify({ hits, cap: 50 }) };
        }
        case 'propose_edit': {
          assertToolArgs(args, ['path', 'old', 'replacement']);
          const path = string(args.path, 'path', 300), old = string(args.old, 'old', 50000);
          if (typeof args.replacement !== 'string' || args.replacement.length > 50000) throw new Error('replacement 必须是长度 <=50000 的字符串');
          const readAction = this.session.events.find(e => e.type === 'assistant' && e.data.action.kind === 'tool'
            && e.data.action.name === 'read_file' && e.data.action.args.path === path);
          if (!readAction || readAction.type !== 'assistant') throw new Error('需要先成功读取这个文件');
          const readResult = this.session.events.find(r => r.type === 'tool_result' && r.data.requestId === readAction.data.requestId && r.data.result.ok);
          if (!readResult || readResult.type !== 'tool_result') throw new Error('需要先成功读取这个文件');
          let readInfo: Record<string, unknown>;
          try { readInfo = record(JSON.parse(readResult.data.result.text), 'read result'); } catch { throw new Error('读取证据不可解析，请重新读取'); }
          if (readInfo.path !== path || typeof readInfo.hash !== 'string') throw new Error('读取证据不完整，请重新读取');
          const before = textFile(safePath(root, path));
          // 拒绝基于过时读取的提案；审批时还会再次核对提案时的 hash。
          if (hash(before) !== readInfo.hash) throw new Error('文件在读取后已改变，请重新读取后再提案');
          const index = before.indexOf(old);
          if (index < 0 || before.indexOf(old, index + 1) >= 0) throw new Error('old 必须唯一精确匹配文件内容');
          const after = before.slice(0, index) + args.replacement + before.slice(index + old.length);
          if (after === before) throw new Error('提案没有改动');
          this.session.append('proposal', { requestId, path, beforeHash: hash(before), after, preview: `文件 ${path}\n--- 旧片段\n${old}\n+++ 新片段\n${args.replacement}` });
          throw new AwaitingEditApproval(requestId);
        }
        case 'run_tests': {
          assertToolArgs(args, []);
          safePath(root, 'test.test.mjs');
          if (!await this.confirmTests()) return { ok: false, text: '用户未批准执行工作区测试。测试脚本是代码执行，不是沙箱。' };
          return await this.tests(root);
        }
        case 'save_note': {
          assertToolArgs(args, ['text']); const text = string(args.text, 'text', 1500);
          this.session.append('note', { text, sourceRequestId: requestId });
          return { ok: true, text: '已保存阶段笔记；最多保留最近 8 条进入 checkpoint，原始笔记事件仍在日志。' };
        }
        case 'history_search': {
          assertToolArgs(args, ['query']); return { ok: true, text: JSON.stringify(this.session.search(string(args.query, 'query', 200))) };
        }
        case 'history_read': {
          assertToolArgs(args, ['seq', 'offset', 'limit']);
          const seq = int(args.seq, 0, 1, 1000000), offset = int(args.offset, 0, 0, 10000000), limit = int(args.limit, 6000, 1, 12000);
          const event = this.session.events.find(e => e.seq === seq);
          if (!event || !['assistant', 'tool_result', 'note'].includes(event.type)) throw new Error('只能恢复 assistant/tool_result/note 事件');
          const raw = JSON.stringify(event);
          return { ok: true, text: JSON.stringify({ seq, offset, nextOffset: Math.min(offset + limit, raw.length), totalChars: raw.length, text: raw.slice(offset, offset + limit) }) };
        }
        default: throw new Error(`未知工具 ${name}`);
      }
    } catch (error) {
      if (error instanceof AwaitingEditApproval) throw error;
      return { ok: false, text: error instanceof Error ? error.message : '工具执行失败' };
    }
  }
  approve(requestId: string, granted: boolean): ToolResult {
    const proposal = this.session.events.find(e => e.type === 'proposal' && e.data.requestId === requestId);
    if (!proposal || proposal.type !== 'proposal') throw new Error('找不到编辑提案');
    if (this.session.events.some(e => e.type === 'approval' && e.data.requestId === requestId)) throw new Error('审批已记录；不重复应用。若上次中断，先人工核查');
    this.session.append('approval', { requestId, granted });
    let result: ToolResult;
    if (!granted) result = { ok: false, text: '用户拒绝编辑提案，未写入文件。' };
    else {
      try {
        const target = safePath(this.session.config.workspace, proposal.data.path);
        if (hash(textFile(target)) !== proposal.data.beforeHash) throw new Error('提案后文件已改变：拒绝覆盖，请重新读取和提案');
        writeFileSync(target, proposal.data.after, 'utf8');
        result = { ok: true, text: JSON.stringify({ applied: proposal.data.path, hash: hash(proposal.data.after), tests: 'not-run' }) };
      } catch (error) { result = { ok: false, text: error instanceof Error ? error.message : '应用失败' }; }
    }
    this.session.append('tool_result', { name: 'propose_edit', requestId, result });
    return result;
  }
  private async tests(root: string): Promise<ToolResult> {
    return await new Promise(resolveResult => {
      const child = spawn(process.execPath, ['--test', 'test.test.mjs'], {
        cwd: root, shell: false,
        env: { PATH: process.env.PATH ?? '', LANG: 'en_US.UTF-8', TMPDIR: process.env.TMPDIR ?? '/tmp' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '', timedOut = false, truncated = false;
      const collect = (chunk: Buffer): void => {
        if (output.length < 30000) output += chunk.toString('utf8').slice(0, 30000 - output.length);
        else truncated = true;
      };
      child.stdout.on('data', collect); child.stderr.on('data', collect);
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
      child.on('error', error => { clearTimeout(timer); resolveResult({ ok: false, text: error.message }); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolveResult({ ok: code === 0 && !timedOut, text: JSON.stringify({ command: 'node --test test.test.mjs', code, signal, timedOut, truncated, output }) });
      });
    });
  }
}
