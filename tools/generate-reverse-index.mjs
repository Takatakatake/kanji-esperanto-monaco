// Generate a kanji-to-root reverse index from all.json.
// Usage:
//   node tools/generate-reverse-index.mjs ./all.json ./data/reverse.json
import fs from 'node:fs/promises';
import path from 'node:path';

const [,, inPath = './all.json', outPath = './data/reverse.json'] = process.argv;

function toXSystem(input) {
  return String(input || '')
    .trim()
    .normalize('NFC')
    .replace(/([cghjsuCGHJSU])\^/g, (_m, ch) => ch.toLowerCase() + 'x')
    .replace(/[ĉĈ]/g, 'cx')
    .replace(/[ĝĜ]/g, 'gx')
    .replace(/[ĥĤ]/g, 'hx')
    .replace(/[ĵĴ]/g, 'jx')
    .replace(/[ŝŜ]/g, 'sx')
    .replace(/[ŭŬ]/g, 'ux')
    .toLowerCase();
}

function aliasesFromSourceRoot(sourceRoot, fallbackPrefix) {
  const aliases = String(sourceRoot || '')
    .split(',')
    .map(part => toXSystem(part))
    .filter(alias => /^[a-z]+$/.test(alias));
  if (!aliases.length && fallbackPrefix) aliases.push(String(fallbackPrefix));
  return Array.from(new Set(aliases)).sort((a, b) => b.length - a.length || a.localeCompare(b));
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const src = JSON.parse(await fs.readFile(inPath, 'utf8'));
const groups = new Map();

for (const item of src.items || []) {
  const body = String(item.body || '').trim();
  const prefix = String(item.prefix || '').trim();
  if (!body || !prefix) continue;

  const sourceRoot = String(item.sourceRoot || prefix).trim();
  const key = `${body}\u0000${sourceRoot}`;
  const existing = groups.get(key);
  const aliases = aliasesFromSourceRoot(sourceRoot, prefix);

  if (existing) {
    for (const alias of aliases) existing.prefixes.add(alias);
    existing.priority = Math.min(existing.priority, numberOrZero(item.priority));
    existing.frequency = Math.max(existing.frequency, numberOrZero(item.frequency));
    existing.base = existing.base || Boolean(item.base);
    continue;
  }

  groups.set(key, {
    body,
    root: sourceRoot,
    prefixes: new Set(aliases),
    insertText: aliases[0] || prefix,
    detail: item.detail || `${sourceRoot} → ${body}`,
    documentation: item.documentation || '',
    priority: numberOrZero(item.priority),
    frequency: numberOrZero(item.frequency),
    base: Boolean(item.base),
    type: item.type || '',
    sourceLine: numberOrZero(item.sourceLine)
  });
}

const items = Array.from(groups.values())
  .map(item => ({
    ...item,
    prefixes: Array.from(item.prefixes),
    insertText: item.insertText || Array.from(item.prefixes)[0] || item.root
  }))
  .sort((a, b) => (
    a.body.localeCompare(b.body)
    || a.priority - b.priority
    || b.frequency - a.frequency
    || a.root.localeCompare(b.root)
  ));

const out = {
  meta: {
    sourceName: path.basename(inPath),
    itemCount: items.length,
    dictionaryItemCount: Array.isArray(src.items) ? src.items.length : 0
  },
  items
};

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(`wrote ${items.length} reverse items to`, path.resolve(outPath));
