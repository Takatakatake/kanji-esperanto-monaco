// tools/split-dictionary.mjs
// Usage: node tools/split-dictionary.mjs ./all.json ./data
import fs from 'node:fs/promises';
import path from 'node:path';

const [,, srcPath = './all.json', outDir = './data'] = process.argv;
const src = JSON.parse(await fs.readFile(srcPath, 'utf8')); // { items: [{prefix, body, detail?}, ...] }
const buckets = {};
for (const it of (src.items || [])) {
  const k = (it.prefix?.[0] || '#').toLowerCase();
  (buckets[k] ||= []).push(it);
}
await fs.mkdir(outDir, { recursive: true });
for (const file of await fs.readdir(outDir)) {
  if (/^ke-.+\.json$/.test(file)) {
    await fs.unlink(path.join(outDir, file));
  }
}
function priorityOf(item) {
  const n = Number(item.priority);
  return Number.isFinite(n) ? n : 999999;
}
for (const [k, arr] of Object.entries(buckets)) {
  arr.sort((a,b)=> (
    String(a.prefix).localeCompare(String(b.prefix))
    || priorityOf(a) - priorityOf(b)
    || String(a.body || '').localeCompare(String(b.body || ''))
  ));
  await fs.writeFile(path.join(outDir, `ke-${k}.json`), JSON.stringify({ items: arr }, null, 2));
}
console.log('done:', Object.keys(buckets).sort().join(','));
