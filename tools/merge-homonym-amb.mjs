// Merge same-spelling / different-meaning (amb) assignments into all.json as ranked alternates.
//
// Usage:
//   node tools/merge-homonym-amb.mjs ./all.json ./data/homonym-amb.tsv ./all.json
//
// WHY THIS EXISTS
// The primary dictionary is built from the master's `_identifier_sidecar.tsv`, which carries
// exactly ONE kanji per root spelling. The master separately curates `_homonym_disp.tsv`, and
// its `type=amb` rows record spellings that are genuinely two different words with two
// different kanji (plum = 羽 "feather" / 笔ᴾᴸ "pen"; mat = 席 "mat" / 将ᴹ "checkmate").
// The sidecar has no slot for a second sense, so those alternates never reached the editor.
// This step appends them as additional completion items on the SAME prefix, ranked after the
// base sense through `priority` — the field app.js already sorts candidates on, so no runtime
// code change is needed.
//
// Only `amb` rows are merged. The other rows of `_homonym_disp.tsv` (`sep`, `comb`) are
// WORD-SCOPED: their second sense is valid only inside an enumerated list of words, which the
// annotator can apply because it sees the whole word, but a text editor cannot at typing time.
// Offering those unconditionally would let the editor emit a form that is only correct in
// certain compounds, so they are deliberately left out.
//
// INVARIANTS (each violation exits non-zero instead of shipping a quietly broken dictionary)
//   * Every amb segment must already exist as a base root. An alternate with no primary sense
//     would be an orphan the editor could offer but the master never sanctioned.
//   * An alternate body must not already belong to a different root, and must be unique among
//     the alternates: the reverter keeps ONE root per body (see check-dictionary-assets.mjs),
//     so a duplicate body would silently make reversal lossy.
//
// The step is idempotent: previously merged alternates are dropped before merging, so
// re-running it (or running it on an already-merged all.json) converges to the same output.
import fs from 'node:fs/promises';
import path from 'node:path';

const AMB_TYPE = 'amb';

const [,, allPath = './all.json', ambPath = './data/homonym-amb.tsv', outPath = allPath] = process.argv;

function parseTsv(raw) {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error(`${ambPath} is empty`);
  const header = lines.shift().split('\t');
  return lines.map((line, index) => {
    const cols = line.split('\t');
    const row = {};
    header.forEach((col, colIndex) => { row[col] = (cols[colIndex] ?? '').trim(); });
    row.__line = index + 2;
    return row;
  });
}

function makeDetail(root, body, sense) {
  return `${root} → ${body} (同綴異義: ${sense})`;
}

function makeDocumentation(row, prefix, root, identifier, sourceName) {
  return [
    `語根: ${root}`,
    `入力: ${prefix}`,
    `最終形: ${row.overrideDisp}`,
    `漢字: ${row.overrideKanji}`,
    `識別子: ${identifier || 'なし'}`,
    `型: ${AMB_TYPE}(同綴異義)`,
    `語義: ${row.disc}`,
    `注記: ${row.note}`,
    `基本形: no`,
    `出典: ${sourceName}:${row.__line}`
  ].join('\n');
}

const src = JSON.parse(await fs.readFile(allPath, 'utf8'));
// Drop any previously merged alternates so the step is idempotent (see header).
const baseItems = (Array.isArray(src.items) ? src.items : []).filter(item => item.type !== AMB_TYPE);
const ambRows = parseTsv(await fs.readFile(ambPath, 'utf8')).filter(row => row.type === AMB_TYPE);
const sourceName = path.basename(ambPath);

const itemsByRoot = new Map();
const maxPriorityByPrefix = new Map();
const rootByBody = new Map();
for (const item of baseItems) {
  const root = String(item.sourceRoot || '');
  if (!itemsByRoot.has(root)) itemsByRoot.set(root, []);
  itemsByRoot.get(root).push(item);
  const prefix = String(item.prefix || '');
  const priority = Number(item.priority) || 0;
  maxPriorityByPrefix.set(prefix, Math.max(maxPriorityByPrefix.get(prefix) ?? -1, priority));
  rootByBody.set(String(item.body || ''), root);
}

const errors = [];
const merged = [];
const seenBodies = new Set();

for (const row of ambRows) {
  const segment = row.segment;
  const body = row.overrideDisp;
  const kanji = row.overrideKanji;
  if (!segment || !body || !kanji) {
    errors.push(`line ${row.__line}: missing segment/overrideKanji/overrideDisp`);
    continue;
  }

  const bases = itemsByRoot.get(segment);
  if (!bases || !bases.length) {
    errors.push(`line ${row.__line}: segment "${segment}" has no base root in the dictionary`);
    continue;
  }
  // The base item owns the canonical typing key: the segment is written in the master's
  // caret notation (pic^), while the editor's prefix is x-system (picx). Cloning the base
  // item's prefix keeps the alternate on exactly the same completion key as its base sense.
  const base = bases[0];
  const prefix = String(base.prefix || '');
  const root = String(base.sourceRoot || segment);

  const owner = rootByBody.get(body);
  if (owner !== undefined && owner !== root) {
    errors.push(`line ${row.__line}: body "${body}" already belongs to root "${owner}" — reversal would become lossy`);
    continue;
  }
  if (seenBodies.has(body)) {
    errors.push(`line ${row.__line}: duplicate alternate body "${body}"`);
    continue;
  }
  seenBodies.add(body);

  const identifier = body.startsWith(kanji) ? body.slice(kanji.length) : '';
  const priority = (maxPriorityByPrefix.get(prefix) ?? 0) + 1;
  maxPriorityByPrefix.set(prefix, priority);

  merged.push({
    prefix,
    body,
    kanji,
    detail: makeDetail(root, body, row.disc),
    documentation: makeDocumentation(row, prefix, root, identifier, sourceName),
    priority,
    sourceRoot: root,
    type: AMB_TYPE,
    frequency: 0,
    base: false,
    sourceLine: row.__line
  });
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

const items = [...baseItems, ...merged].sort((a, b) => (
  String(a.prefix).localeCompare(String(b.prefix))
  || (Number(a.priority) || 0) - (Number(b.priority) || 0)
  || String(a.body || '').localeCompare(String(b.body || ''))
));

const out = {
  meta: {
    ...(src.meta || {}),
    homonymSourceName: sourceName,
    homonymAmbCount: merged.length,
    itemCount: items.length
  },
  items
};

await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');
console.log(`merged ${merged.length} amb alternates; wrote ${items.length} items to`, path.resolve(outPath));
