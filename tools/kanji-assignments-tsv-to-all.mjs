// Convert the kanji assignment preview TSV into all.json format.
// Usage:
//   node tools/kanji-assignments-tsv-to-all.mjs /path/to/漢字割当一覧_識別子付きプレビュー_20260614.tsv ./all.json
//   node tools/kanji-assignments-tsv-to-all.mjs /path/to/_identifier_sidecar.tsv ./all.json
import fs from 'node:fs/promises';
import path from 'node:path';
import { toXSystem } from './x-system.mjs';

// CROSS-VERSION CONCAT COLLISIONS — sidecar roots held OUT of the dictionary (2026-08-05).
//
// The master keeps two delivery streams. The learner stream renders these words DECOMPOSED
// (mikroskopo = mikro/skop/o → 微/镜ˢᴷ/o); the academic stream got whole-root mirror fills
// whose kanji is, by design (案A of master 続62), the CONCATENATION of those same learner
// pieces (mikroskopi → 微镜ˢᴷ). Inside the master those are separate documents, so its own
// surface-homograph audit ([J]) is rightly green. This app pair merges both streams into ONE
// dictionary and ONE reverter text universe, where the academic whole becomes a longest-match
// key that eats the learner adjacency and REWRITES real words. Measured on the r33 full-corpus
// regression (52,228 words) before shipping:
//   endo/skop/o ⟦内ᴱᴰ镜ˢᴷo⟧: endoskopo → endoskopio (a DIFFERENT existing word)
//   eu^/fon/i/o ⟦良ᴱ声ᶠᴼio⟧: eŭfonio  → eŭfoniio
// Damage needs BOTH (a) the whole-root kanji equals an adjacent pure-kanji learner sequence
// (no literal vowel between the pieces), and (b) the whole root's spelling differs from the
// concatenated spelling (mikro+skop = mikroskop ≠ mikroskopi). Spelling-preserving
// concatenations (tri+kromi = trikromi) are safe and are NOT excluded. The corpus regression
// is the gate that finds this class; it runs on every sync.
//
// Each entry pins the colliding body observed at exclusion time. If the master later changes
// the root's value (say, adds a distinguishing identifier the way the academic stream already
// distinguishes 微镜 mikroskop from 微镜ˢᴷ mikroskopi), the pin no longer matches and the
// build FAILS, forcing a re-review instead of the exclusion silently outliving its reason.
// Keys are toXSystem() forms of the sidecar root spelling.
export const EXCLUDED_ROOTS = new Map([
  ['mikroskopi', { body: '微镜ˢᴷ', reason: '学習者版 微(mikro)+镜ˢᴷ(skop) の連結と同字面 — 顕微鏡系の実コーパス13語が mikroskopio 系の別語へ誤読される' }],
  ['endoskopi', { body: '内ᴱᴰ镜ˢᴷ', reason: '学習者版 内ᴱᴰ(endo)+镜ˢᴷ(skop) の連結と同字面 — endoskopo→endoskopio の退行' }],
  ['euxfoni', { body: '良ᴱ声ᶠᴼ', reason: '学習者版 良ᴱ(eu^)+声ᶠᴼ(fon 別義) の連結と同字面 — eŭfonio→eŭfoniio の退行' }],
  ['asistoli', { body: '无ᴬ缩ˢ', reason: '学習者版 无ᴬ(a)+缩ˢ(sistol) の連結と同字面 — 无ᴬ缩ˢio(asistolio) が二重iの誤語 asistoliio になる' }]
]);

const [,, inPath, outPath = './all.json'] = process.argv;
if (!inPath) {
  console.error('Usage: node tools/kanji-assignments-tsv-to-all.mjs <assignments.tsv> [out.json]');
  process.exit(1);
}

const PREVIEW_COLUMNS = ['最終形', '識別子', '漢字', '語根', '型', 'F(汎用性)', 'グループ数', '基本形'];
const SIDECAR_COLUMNS = ['root', 'kanji', 'id', 'disp', 'band', 'F', 'groupkey'];

function parseIntOrZero(value) {
  const n = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

function parseTsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (ch === '\t' && !quoted) {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

function parseGenericTsv(raw) {
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error('Input TSV is empty');

  const header = parseTsvLine(lines.shift().replace(/^\uFEFF/, ''));

  const rows = lines.map((line, index) => {
    const cols = parseTsvLine(line);
    const row = {};
    header.forEach((col, colIndex) => {
      row[col] = cols[colIndex] ?? '';
    });
    row.__line = index + 2;
    return row;
  });

  return { header, rows };
}

function normalizeSidecarRows(rows) {
  const groupCounts = new Map();
  for (const row of rows) {
    const groupKey = String(row.groupkey || row.kanji || row.disp || '').trim();
    if (!groupKey) continue;
    groupCounts.set(groupKey, (groupCounts.get(groupKey) || 0) + 1);
  }

  return rows.map(row => {
    const groupKey = String(row.groupkey || row.kanji || row.disp || '').trim();
    const identifier = String(row.id || '').trim();
    return {
      '最終形': String(row.disp || row.kanji || '').trim(),
      '識別子': identifier,
      '漢字': String(row.kanji || '').trim(),
      '語根': String(row.root || '').trim(),
      '型': String(row.band || '').trim(),
      'F(汎用性)': String(row.F || '').trim(),
      'グループ数': String(groupCounts.get(groupKey) || 1),
      '基本形': identifier ? '' : '✓',
      __line: row.__line
    };
  });
}

function parseTsv(raw) {
  const { header, rows } = parseGenericTsv(raw);
  // The .every(includes) guards above already guarantee every column is present, so an
  // explicit assertColumns() here was unreachable; the schema is determined by the guard.
  if (PREVIEW_COLUMNS.every(col => header.includes(col))) {
    return { schema: 'preview', rows };
  }
  if (SIDECAR_COLUMNS.every(col => header.includes(col))) {
    return { schema: 'identifier-sidecar', rows: normalizeSidecarRows(rows) };
  }
  throw new Error(`Unsupported assignment TSV columns: ${header.join(', ')}`);
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
const parsed = parseTsv(raw);
const rows = parsed.rows;
const sourceName = path.basename(inPath);

const grouped = new Map();
const skipped = [];

for (const row of rows) {
  const sourceRoot = String(row['語根'] || '').trim();
  // Strip any trailing comma/space from the final form. A comma-separated root such as
  // "dio,Di" leaks its separator into the identifier (disp "神ᴰ,"); that stray comma must
  // not reach the inserted body or the reverse-lookup key. Write it back so detail/
  // documentation stay consistent with the cleaned body.
  const body = String(row['最終形'] || '').trim().replace(/[,\s]+$/u, '');
  row['最終形'] = body;
  if (!sourceRoot || !body) {
    skipped.push({ line: row.__line, reason: 'missing root or final form', root: sourceRoot, body });
    continue;
  }

  const aliases = rootAliases(sourceRoot);
  for (const prefix of aliases) {
    if (!/^[a-z-]+$/.test(prefix)) {
      skipped.push({ line: row.__line, reason: 'non-ASCII prefix after normalization', root: sourceRoot, prefix });
      continue;
    }

    const excluded = EXCLUDED_ROOTS.get(prefix);
    if (excluded) {
      if (excluded.body !== body) {
        console.error(`ERROR: excluded root "${prefix}" now has body "${body}" (pinned "${excluded.body}").`);
        console.error('The master changed this root since the exclusion was recorded — re-review EXCLUDED_ROOTS (see header) before building.');
        process.exit(1);
      }
      skipped.push({ line: row.__line, reason: `excluded (cross-version concat collision): ${excluded.reason}`, root: sourceRoot, prefix });
      continue;
    }

    const freq = parseIntOrZero(row['F(汎用性)']);
    const isBase = String(row['基本形'] || '').trim() ? 1 : 0;
    const item = {
      prefix,
      body,
      kanji: String(row['漢字'] || '').trim(),
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
    sourceSchema: parsed.schema,
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
