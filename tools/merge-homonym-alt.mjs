// Merge the master's curated homonym alternates into all.json as ranked extra candidates.
//
// Usage:
//   node tools/merge-homonym-alt.mjs ./all.json ./data/homonym-alt.tsv ./all.json
//
// WHY THIS EXISTS
// The primary dictionary is built from the master's `_identifier_sidecar.tsv`, which holds
// exactly ONE kanji per root spelling. The master separately curates `_homonym_disp.tsv`,
// where a spelling that carries more than one meaning gets a second (third, …) kanji:
//   amb  — a genuinely different word sharing the spelling (plum = 羽 "feather" / 笔ᴾᴸ "pen")
//   sep  — a sense valid only INSIDE the words listed in `disc`
//          (krom = 外 "besides", but 金ᴷᴹ "chromium" in krom/o, krom/at/o, krom/at/a)
//   comb — a combining form (-metr- = 计ᴹ "gauge" in termometr/barometr, vs metr = 米)
// The sidecar has no slot for a second sense, so none of these reached the editor. This step
// appends them as extra completion items on the SAME prefix, ranked after the base sense via
// `priority` — the field app.js already sorts candidates on, so no runtime code changes.
//
// `sep`/`comb` senses are word-scoped, and an editor cannot know the word at typing time, so
// their scope is spelled out in `detail`/`documentation` (適用語) and the human chooses. That
// is safe in both directions: reversal stays lossless because every alternate body is unique,
// so picking one outside its word list is a wording mistake, never an unrecoverable one.
//
// CLASSIFICATION
// Rows are adopted only when they can be attached safely; every other row is reported with
// its reason so a master-side change never silently alters what ships. Skips are expected
// (the master maintains this table for the annotator, whose reach is wider than the editor's):
//   * `already in dictionary`  — the exact form is already assigned to that same root
//   * `duplicate display form` — an earlier row already contributes it (same morpheme listed
//                                under several types); adopting both would collide with itself
//   * `no base root`           — a word-internal segment with no standalone root to rank after
//   * `collides with another root` — the form already belongs to a DIFFERENT root; adopting it
//                                would make reversal lossy (see check-dictionary-assets.mjs)
//
// The step is idempotent: previously merged alternates are dropped before merging, so
// re-running it (or running it on an already-merged all.json) converges to the same output.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toXSystem } from './x-system.mjs';

export const ALT_TYPES = new Set(['amb', 'sep', 'comb']);

const TYPE_LABEL = { amb: '同綴異義', sep: '語限定', comb: '結合形' };

export function parseAlternateTsv(raw) {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) throw new Error('homonym alternate TSV is empty');
  const header = lines.shift().split('\t');
  return lines.map((line, index) => {
    const cols = line.split('\t');
    const row = {};
    header.forEach((col, colIndex) => { row[col] = (cols[colIndex] ?? '').trim(); });
    row.line = index + 2;
    return row;
  });
}

// The master writes segments in its own notation (caret `c^iel`, or Unicode `ĉiel`), while the
// dictionary keys completions by the x-system prefix (`cxiel`). Normalising BOTH sides through
// the shared converter is what lets a segment find its base sense regardless of which notation
// the master happened to use for that row.
const prefixOf = (segment) => toXSystem(segment);

// A note reads "クロム(金属元素)→金。前置詞krom=外と別。…": the sense is what precedes the
// arrow (or the first sentence when there is none). Both delimiters also occur INSIDE the
// parenthetical glosses the master writes — "ギリシャlogos(言葉→戒め)→戒", "polio-(…cerba。
// PIV原本polio/定義)→灰" — so track bracket depth and only break at a top-level delimiter;
// splitting naively leaves a dangling bracket in the candidate list.
function senseOf(row) {
  const note = String(row.note || '');
  let depth = 0;
  let arrow = -1;
  let end = note.length;
  for (let i = 0; i < note.length; i += 1) {
    const ch = note[i];
    if (ch === '(' || ch === '（') depth += 1;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      if (ch === '。') { end = i; break; }
      if (ch === '→' && arrow < 0) arrow = i;
    }
  }
  return note.slice(0, arrow >= 0 ? arrow : end).trim();
}

function scopeWords(row) {
  return String(row.disc || '').split(',').map(part => part.trim()).filter(Boolean);
}

function detailOf(row, root, body) {
  if (row.type === 'amb') return `${root} → ${body} (同綴異義: ${row.disc})`;
  const sense = senseOf(row) || row.disc || '';
  if (row.type === 'comb') return `${root} → ${body} (結合形: ${sense})`;
  const words = scopeWords(row);
  const shown = words.slice(0, 2).join(', ');
  const more = words.length > 2 ? ` 他${words.length - 2}語` : '';
  return `${root} → ${body} (語限定 ${sense}${words.length ? `: ${shown}${more}` : ''})`;
}

function documentationOf(row, prefix, root, sourceName) {
  const identifier = row.overrideDisp.startsWith(row.overrideKanji)
    ? row.overrideDisp.slice(row.overrideKanji.length)
    : '';
  const words = scopeWords(row);
  return [
    `語根: ${root}`,
    `入力: ${prefix}`,
    `最終形: ${row.overrideDisp}`,
    `漢字: ${row.overrideKanji}`,
    `識別子: ${identifier || 'なし'}`,
    `型: ${row.type}(${TYPE_LABEL[row.type] || row.type})`,
    `語義: ${row.type === 'amb' ? row.disc : (senseOf(row) || row.disc)}`,
    ...(row.type === 'amb' || !words.length ? [] : [`適用語: ${words.join(', ')}`]),
    `注記: ${row.note}`,
    '基本形: no',
    `出典: ${sourceName}:${row.line}`
  ].join('\n');
}

/**
 * Decide which alternate rows can be attached to the given base dictionary items.
 * Exported so check-dictionary-assets.mjs can re-derive the exact same expectation instead of
 * duplicating the rules (the reverse-index checker uses the same shared-logic pattern).
 */
export function classifyAlternates(baseItems, rows, sourceName = 'homonym-alt.tsv') {
  const baseByPrefix = new Map();
  const rootByBody = new Map();
  for (const item of baseItems) {
    const prefix = String(item.prefix || '');
    if (!baseByPrefix.has(prefix)) baseByPrefix.set(prefix, item);
    rootByBody.set(String(item.body || ''), String(item.sourceRoot || prefix));
  }

  const maxPriority = new Map();
  for (const item of baseItems) {
    const prefix = String(item.prefix || '');
    maxPriority.set(prefix, Math.max(maxPriority.get(prefix) ?? -1, Number(item.priority) || 0));
  }

  const adopted = [];
  const skipped = [];
  const claimed = new Set();

  // Some morphemes are listed under more than one type (vat 瓦ⱽ is both a free-standing
  // homonym and a rule for kilo/vat/hor…). Only the first listing can be adopted — the body
  // must stay unique — so take the LEAST restricted framing first: an `amb` sense is valid
  // wherever the spelling appears, while `sep`/`comb` hold only inside their word list, and
  // presenting a freely usable sense as word-scoped would understate it. File order is kept
  // within each type so the master's own ordering still decides the rank among equals.
  const typeRank = { amb: 0, sep: 1, comb: 2 };
  const ordered = rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => (typeRank[a.row.type] ?? 9) - (typeRank[b.row.type] ?? 9) || a.index - b.index)
    .map(entry => entry.row);

  for (const row of ordered) {
    if (!ALT_TYPES.has(row.type)) { skipped.push({ row, reason: `unsupported type "${row.type}"` }); continue; }
    if (!row.segment || !row.overrideKanji || !row.overrideDisp) {
      skipped.push({ row, reason: 'missing segment/overrideKanji/overrideDisp' });
      continue;
    }
    const body = row.overrideDisp;
    if (claimed.has(body)) { skipped.push({ row, reason: 'duplicate display form (an earlier row already contributes it)' }); continue; }

    const prefix = prefixOf(row.segment);
    const base = baseByPrefix.get(prefix);
    if (!base) { skipped.push({ row, reason: `no base root for segment "${row.segment}" (prefix ${prefix})` }); continue; }
    const root = String(base.sourceRoot || prefix);

    const owner = rootByBody.get(body);
    if (owner !== undefined) {
      skipped.push({
        row,
        reason: owner === root
          ? 'already in the dictionary for this root'
          : `collides with another root "${owner}" — adopting it would make reversal lossy`
      });
      continue;
    }

    claimed.add(body);
    const priority = (maxPriority.get(prefix) ?? 0) + 1;
    maxPriority.set(prefix, priority);

    adopted.push({
      row,
      item: {
        prefix,
        body,
        kanji: row.overrideKanji,
        detail: detailOf(row, root, body),
        documentation: documentationOf(row, prefix, root, sourceName),
        priority,
        sourceRoot: root,
        type: row.type,
        frequency: 0,
        base: false,
        sourceLine: row.line
      }
    });
  }

  return { adopted, skipped };
}

async function main() {
  const [,, allPath = './all.json', altPath = './data/homonym-alt.tsv', outPath = allPath] = process.argv;
  const src = JSON.parse(await fs.readFile(allPath, 'utf8'));
  // Drop any previously merged alternates so the step is idempotent (see header).
  const baseItems = (Array.isArray(src.items) ? src.items : []).filter(item => !ALT_TYPES.has(item.type));
  const sourceName = path.basename(altPath);
  const rows = parseAlternateTsv(await fs.readFile(altPath, 'utf8'));
  const { adopted, skipped } = classifyAlternates(baseItems, rows, sourceName);

  const items = [...baseItems, ...adopted.map(entry => entry.item)].sort((a, b) => (
    String(a.prefix).localeCompare(String(b.prefix))
    || (Number(a.priority) || 0) - (Number(b.priority) || 0)
    || String(a.body || '').localeCompare(String(b.body || ''))
  ));

  // Belt and braces: the skip rules above already prevent it, but never ship a dictionary in
  // which one body maps to two roots — the reverter could recover only one of them.
  const rootsByBody = new Map();
  for (const item of items) {
    const body = String(item.body || '');
    if (!rootsByBody.has(body)) rootsByBody.set(body, new Set());
    rootsByBody.get(body).add(String(item.sourceRoot || item.prefix || ''));
  }
  const lossy = [...rootsByBody].filter(([, roots]) => roots.size > 1);
  if (lossy.length) {
    for (const [body, roots] of lossy) console.error(`ERROR: body "${body}" maps to ${roots.size} roots {${[...roots].join(', ')}}`);
    process.exit(1);
  }

  const byType = adopted.reduce((acc, entry) => { acc[entry.row.type] = (acc[entry.row.type] || 0) + 1; return acc; }, {});
  // Re-derive every homonym-related meta key instead of inheriting it: a counter written by an
  // earlier revision of this tool would otherwise linger forever and make the output depend on
  // the build history rather than on the inputs alone.
  const carriedMeta = Object.fromEntries(Object.entries(src.meta || {}).filter(([key]) => !key.startsWith('homonym')));
  const out = {
    meta: {
      ...carriedMeta,
      homonymSourceName: sourceName,
      homonymAltCount: adopted.length,
      itemCount: items.length
    },
    items
  };
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');

  console.log(`merged ${adopted.length} alternates (${Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(' ')}); wrote ${items.length} items to ${path.resolve(outPath)}`);
  if (skipped.length) {
    console.log(`skipped ${skipped.length} row(s):`);
    for (const entry of skipped) console.log(`  line ${entry.row.line}: ${entry.row.type} ${entry.row.segment} → ${entry.row.overrideDisp} — ${entry.reason}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
