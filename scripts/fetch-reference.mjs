/**
 * 下载 DeepSeek Harness 的版本锁定参考资料。
 *
 * 目的不是复刻上游，而是给“源码对照”留下可追溯证据：
 * - revision 固定，避免 main 漂移；
 * - 只下载选定文档/压缩源码，不假装是完整运行时审计；
 * - 写入 reference/sources.json 记录每个本地文件对应的原始 URL。
 *
 * 网络失败时直接抛出，不生成半套参考文件。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// 锁定版本：文档和源码对照都以这个 commit 为准。
const revision = '4b399c39a6d1479cd84ca591b4d7c88e24d38a96';

// 只取与上下文管理/会话/压缩有关的精选文件；不是完整仓库。
const files = [
  'docs/subsystems/compaction.md',
  'docs/subsystems/session.md',
  'packages/compaction/compaction-basic/src/index.ts',
  'packages/compaction/compaction-tool-result-pruner/src/index.ts',
  'packages/compaction/compaction/src/index.ts',
  'packages/core/agent-loop/README.md',
  'packages/llm/token-meter/README.md',
  'packages/core/session/README.md',
  'LICENSE',
];

const root = resolve(import.meta.dirname, '../reference');
await mkdir(root, { recursive: true });

const sources = [];

for (const file of files) {
  const url = `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${revision}/${file}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });

  // 任一文件失败都终止，避免 reference 目录出现“看起来完整其实缺件”的状态。
  if (!res.ok) throw new Error(`${res.status}: ${file}`);

  // 用 __ 扁平化路径，避免在 reference 下重建整棵上游目录。
  const local = file.replaceAll('/', '__');
  await writeFile(resolve(root, local), await res.text());
  sources.push({ file, local, url });
}

// sources.json 记录 revision、范围声明和逐文件来源，便于日后重新核对。
await writeFile(
  resolve(root, 'sources.json'),
  JSON.stringify({
    revision,
    scope: 'Selected documentation and compaction source; not a full runtime audit.',
    sources,
  }, null, 2),
);

console.log(`Downloaded ${sources.length} version-pinned reference files.`);
