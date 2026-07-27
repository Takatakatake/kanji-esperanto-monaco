// Merge the master's context-embedded rendering tokens into all.json as ranked extra candidates.
//
// Usage:
//   node tools/merge-inline-tokens.mjs ./all.json ./data/inline-tokens.tsv ./all.json
//
// WHY THIS EXISTS
// Two master files feed the editor's dictionary: `_identifier_sidecar.tsv` (one kanji per root)
// and `_homonym_disp.tsv` (extra senses of a shared spelling). A third class of rendering exists
// in NEITHER: the annotator's injection layer decides some kanji from LINE-LEVEL context, not
// from the segment alone. Chemical salts, medical -itis and the alkyl stems are rendered that
// way, so their tokens belong to no root table at all. The master enumerated them in
// `_inline_tokens.tsv` (its 16th lens) precisely because a consumer that only sees the shipped
// data cannot otherwise complete the reverse dictionary: 庚 appears in kanjified text but maps
// back to nothing.
//
// WHAT IS ADOPTED — see ADOPTED_RULES
// Only the alkyl stems (`$alkylStem`). The user's ruling (2026-07-27) was to take those and
// leave the chemical-salt / medical-itis rows alone: `at` and `it` are the passive participle
// suffixes, by far the highest-traffic input path in the language, and a chemistry sense on them
// would put noise where almost nobody wants it. Everything else — including any rule the master
// invents later — is skipped with its reason printed, so a new rule is reviewed before it ships
// rather than appearing in users' candidate lists unannounced.
//
// WHY THESE MAY ATTACH WITHOUT A BASE ROOT
// merge-homonym-alt.mjs refuses a segment that has no standalone root, because a word-scoped
// SENSE of a word-internal fragment would be offered as if the fragment were a word. Alkyl stems
// are the opposite case: the master renders the bare segment itself as a headword (`hept/` →
// `庚/`, `non/` → `壬/`), so the segment IS a typeable unit and `hept` currently completes to
// nothing at all. Adopting them adds an input path that did not exist and displaces nothing.
//
// ORDER INDEPENDENCE
// This step runs after merge-homonym-alt.mjs so the rare chemistry sense ranks last. That is the
// documented order, but it is not load-bearing: this tool drops its own previous output and
// recomputes priorities from whatever else is present, and merge-homonym-alt.mjs keeps inline
// items out of its own priority baseline. Running either step again, in either order, converges
// to the same file.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toXSystem } from './x-system.mjs';
import { INLINE_TYPE } from './candidate-types.mjs';

export { INLINE_TYPE };

// Injection rules whose tokens are taken into the dictionary. Anything else is skipped by policy.
export const ADOPTED_RULES = new Set(['$alkylStem']);

const POLICY_NOTE = {
  $chemSaltLine: 'ユーザー裁定(2026-07-27): 化学塩 -at/-it は分詞接尾と同綴で入力頻度が高いため除外',
  $medIt: 'ユーザー裁定(2026-07-27): 医学 -itis は分詞接尾 -it- と同綴で入力頻度が高いため除外'
};

/** Split the master's token into its kanji and the superscript identifier that follows it. */
function splitToken(token) {
  const kanji = String(token).replace(/[^\p{Script=Han}]+$/u, '');
  return { kanji: kanji || String(token), identifier: String(token).slice(kanji.length) };
}

// Same shape as the note in `_homonym_disp.tsv`: a sense, then 。, then the contrast with the
// spelling's other meaning. Break only at a top-level 。 — the sense itself contains parenthesised
// glosses with their own punctuation ("アルキル C4 butane(ブタノール but/an/ol/o=丁/an/ol)").
function senseOf(note) {
  const text = String(note || '');
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(' || ch === '（') depth += 1;
    else if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === '。') return text.slice(0, i).trim();
  }
  return text.trim();
}

/**
 * Parse `_inline_tokens.tsv`. Unlike the homonym table this file carries a `#` comment preamble
 * explaining each rule, so comments are dropped and the first non-comment line is the header.
 */
export function parseInlineTokenTsv(raw) {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/);
  const rows = [];
  let header = null;
  lines.forEach((line, index) => {
    if (!line.trim() || line.startsWith('#')) return;
    const cols = line.split('\t');
    if (!header) { header = cols.map(col => col.trim()); return; }
    const row = {};
    header.forEach((col, colIndex) => { row[col] = (cols[colIndex] ?? '').trim(); });
    row.line = index + 1;
    rows.push(row);
  });
  if (!header) throw new Error('inline token TSV has no header row');
  return rows;
}

/**
 * Decide which inline-token rows can be attached to the given items.
 * Exported so check-dictionary-assets.mjs re-derives the expectation with these exact rules
 * instead of keeping a second copy of them.
 */
export function classifyInlineTokens(existingItems, rows, sourceName = 'inline-tokens.tsv') {
  const rootByBody = new Map();
  const rootByPrefix = new Map();
  const maxPriority = new Map();
  for (const item of existingItems) {
    const prefix = String(item.prefix || '');
    rootByBody.set(String(item.body || ''), String(item.sourceRoot || prefix));
    if (!rootByPrefix.has(prefix)) rootByPrefix.set(prefix, String(item.sourceRoot || prefix));
    maxPriority.set(prefix, Math.max(maxPriority.get(prefix) ?? -1, Number(item.priority) || 0));
  }

  const adopted = [];
  const skipped = [];
  const claimed = new Set();

  for (const row of rows) {
    if (!ADOPTED_RULES.has(row.rule)) {
      skipped.push({ row, reason: POLICY_NOTE[row.rule] || `rule "${row.rule}" is not in ADOPTED_RULES — review it before shipping` });
      continue;
    }
    if (!row.token || !row.segment) { skipped.push({ row, reason: 'missing token/segment' }); continue; }

    const body = row.token;
    if (claimed.has(body)) { skipped.push({ row, reason: 'duplicate token (an earlier row already contributes it)' }); continue; }

    const prefix = toXSystem(row.segment);
    const root = rootByPrefix.get(prefix) || prefix;

    // The reverter keeps one root per display form, so a token already owned by some root can
    // never be adopted: for the same root it is already there, for another it would make the
    // reverse direction lossy. (A token that is merely a PREFIX of a longer form is fine — the
    // reverter matches longest-first, so 丁香ᴷ still wins over 丁.)
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
    const priority = (maxPriority.get(prefix) ?? -1) + 1;
    maxPriority.set(prefix, priority);

    const { kanji, identifier } = splitToken(body);
    const sense = senseOf(row.note);
    adopted.push({
      row,
      item: {
        prefix,
        body,
        kanji,
        detail: `${root} → ${body} (化学文脈: ${sense})`,
        documentation: [
          `語根: ${root}`,
          `入力: ${prefix}`,
          `最終形: ${body}`,
          `漢字: ${kanji}`,
          `識別子: ${identifier || 'なし'}`,
          `型: ${INLINE_TYPE}(文脈埋込)`,
          `語義: ${sense}`,
          `規則: ${row.rule}`,
          `注記: ${row.note}`,
          '基本形: no',
          `出典: ${sourceName}:${row.line}`
        ].join('\n'),
        priority,
        sourceRoot: root,
        type: INLINE_TYPE,
        frequency: 0,
        base: false,
        sourceLine: row.line
      }
    });
  }

  return { adopted, skipped };
}

async function main() {
  const [,, allPath = './all.json', tokensPath = './data/inline-tokens.tsv', outPath = allPath] = process.argv;
  const src = JSON.parse(await fs.readFile(allPath, 'utf8'));
  // Drop any previously merged inline tokens so the step is idempotent (see header).
  const existing = (Array.isArray(src.items) ? src.items : []).filter(item => item.type !== INLINE_TYPE);
  const sourceName = path.basename(tokensPath);
  const rows = parseInlineTokenTsv(await fs.readFile(tokensPath, 'utf8'));
  const { adopted, skipped } = classifyInlineTokens(existing, rows, sourceName);

  const items = [...existing, ...adopted.map(entry => entry.item)].sort((a, b) => (
    String(a.prefix).localeCompare(String(b.prefix))
    || (Number(a.priority) || 0) - (Number(b.priority) || 0)
    || String(a.body || '').localeCompare(String(b.body || ''))
  ));

  // Belt and braces, as in merge-homonym-alt.mjs: never ship a dictionary in which one body
  // maps to two roots — the reverter could recover only one of them.
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

  const carriedMeta = Object.fromEntries(Object.entries(src.meta || {}).filter(([key]) => !key.startsWith('inline')));
  const out = {
    meta: {
      ...carriedMeta,
      inlineSourceName: sourceName,
      inlineTokenCount: adopted.length,
      itemCount: items.length
    },
    items
  };
  await fs.writeFile(outPath, JSON.stringify(out, null, 2), 'utf8');

  console.log(`merged ${adopted.length} inline tokens; wrote ${items.length} items to ${path.resolve(outPath)}`);
  if (skipped.length) {
    console.log(`skipped ${skipped.length} row(s):`);
    for (const entry of skipped) console.log(`  line ${entry.row.line}: ${entry.row.segment} → ${entry.row.token} — ${entry.reason}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) await main();
