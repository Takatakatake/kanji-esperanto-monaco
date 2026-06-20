// Convert the kanji assignment preview TSV into all.json format.
// Usage:
//   node tools/kanji-assignments-tsv-to-all.mjs /path/to/漢字割当一覧_識別子付きプレビュー_20260614.tsv ./all.json
import fs from 'node:fs/promises';
import path from 'node:path';

const [,, inPath, outPath = './all.json'] = process.argv;
if (!inPath) {
  console.error('Usage: node tools/kanji-assignments-tsv-to-all.mjs <assignments.tsv> [out.json]');
  process.exit(1);
}

const REQUIRED_COLUMNS = ['最終形', '識別子', '漢字', '語根', '型', 'F(汎用性)', 'グループ数', '基本形'];

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

function parseIntOrZero(value) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseTsv(raw) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error('Input TSV is empty');

  const header = lines.shift().replace(/^\uFEFF/, '').split('\t');
  const missing = REQUIRED_COLUMNS.filter(col => !header.includes(col));
  if (missing.length) {
    throw new Error(`Missing required column(s): ${missing.join(', ')}`);
  }

  return lines.map((line, index) => {
    const cols = line.split('\t');
    const row = {};
    header.forEach((col, colIndex) => {
      row[col] = cols[colIndex] ?? '';
    });
    row.__line = index + 2;
    return row;
  });
}

function rootAliases(root) {
  return String(root || '')
    .split(',')
    .map(part => toXSystem(part))
    .filter(Boolean);
}

function makeDetail(row, sourceRoot) {
  const type = row['型'] || 'unknown';
  const freq = parseIntOrZero(row['F(汎用性)']);
  const base = String(row['基本形'] || '').trim() ? ', 基本形' : '';
  return `${sourceRoot} → ${row['最終形']} (${type}, F=${freq}${base})`;
}

function makeDocumentation(row, prefix, sourceRoot, sourceName) {
  const identifier = String(row['識別子'] || '').trim() || 'なし';
  const base = String(row['基本形'] || '').trim() ? 'yes' : 'no';
  return [
    `語根: ${sourceRoot}`,
    `入力: ${prefix}`,
    `最終形: ${row['最終形']}`,
    `漢字: ${row['漢字']}`,
    `識別子: ${identifier}`,
    `型: ${row['型']}`,
    `F(汎用性): ${parseIntOrZero(row['F(汎用性)'])}`,
    `グループ数: ${parseIntOrZero(row['グループ数'])}`,
    `基本形: ${base}`,
    `出典: ${sourceName}:${row.__line}`
  ].join('\n');
}

const raw = await fs.readFile(inPath, 'utf8');
const rows = parseTsv(raw);
const sourceName = path.basename(inPath);

const grouped = new Map();
const skipped = [];

for (const row of rows) {
  const sourceRoot = String(row['語根'] || '').trim();
  const body = String(row['最終形'] || '').trim();
  if (!sourceRoot || !body) {
    skipped.push({ line: row.__line, reason: 'missing root or final form', root: sourceRoot, body });
    continue;
  }

  const aliases = rootAliases(sourceRoot);
  for (const prefix of aliases) {
    if (!/^[a-z]+$/.test(prefix)) {
      skipped.push({ line: row.__line, reason: 'non-ASCII prefix after normalization', root: sourceRoot, prefix });
      continue;
    }

    const freq = parseIntOrZero(row['F(汎用性)']);
    const isBase = String(row['基本形'] || '').trim() ? 1 : 0;
    const item = {
      prefix,
      body,
      detail: makeDetail(row, sourceRoot),
      documentation: makeDocumentation(row, prefix, sourceRoot, sourceName),
      priority: 0,
      sourceRoot,
      type: row['型'] || '',
      frequency: freq,
      base: Boolean(isBase),
      sourceLine: row.__line
    };

    if (!grouped.has(prefix)) grouped.set(prefix, []);
    grouped.get(prefix).push(item);
  }
}

const items = [];
for (const [prefix, entries] of grouped) {
  const deduped = new Map();
  for (const item of entries) {
    const key = `${item.prefix}\u0000${item.body}`;
    const existing = deduped.get(key);
    if (!existing || item.sourceLine < existing.sourceLine) deduped.set(key, item);
  }

  const ranked = Array.from(deduped.values()).sort((a, b) => {
    if (a.base !== b.base) return a.base ? -1 : 1;
    if (a.frequency !== b.frequency) return b.frequency - a.frequency;
    return a.sourceLine - b.sourceLine;
  });

  ranked.forEach((item, index) => {
    item.priority = index;
    items.push(item);
  });
}

items.sort((a, b) => (
  a.prefix.localeCompare(b.prefix)
  || a.priority - b.priority
  || a.body.localeCompare(b.body)
));

const out = {
  meta: {
    sourceName,
    prefixNotation: 'x-system',
    itemCount: items.length,
    skippedCount: skipped.length
  },
  items
};

await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(`wrote ${items.length} items to`, path.resolve(outPath));
if (skipped.length) {
  console.warn(`skipped ${skipped.length} row(s):`);
  for (const row of skipped.slice(0, 20)) {
    console.warn(`  line ${row.line}: ${row.reason} (${row.root} -> ${row.prefix || row.body || ''})`);
  }
  if (skipped.length > 20) console.warn(`  ... ${skipped.length - 20} more`);
}
