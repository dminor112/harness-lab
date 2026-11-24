import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const revision = '4b399c39a6d1479cd84ca591b4d7c88e24d38a96';
const files = ['docs/subsystems/compaction.md', 'docs/subsystems/session.md', 'packages/compaction/compaction-basic/src/index.ts', 'packages/compaction/compaction-tool-result-pruner/src/index.ts', 'packages/compaction/compaction/src/index.ts', 'packages/core/agent-loop/README.md', 'packages/llm/token-meter/README.md', 'packages/core/session/README.md', 'LICENSE'];
const root = resolve(import.meta.dirname, '../reference');
await mkdir(root, { recursive: true });
const sources = [];
for (const file of files) {
  const url = `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/${revision}/${file}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status}: ${file}`);
  const local = file.replaceAll('/', '__');
  await writeFile(resolve(root, local), await res.text());
  sources.push({ file, local, url });
}
await writeFile(resolve(root, 'sources.json'), JSON.stringify({ revision, scope: 'Selected documentation and compaction source; not a full runtime audit.', sources }, null, 2));
console.log(`Downloaded ${sources.length} version-pinned reference files.`);
