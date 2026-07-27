#!/usr/bin/env node
// Verify that split dictionary assets match all.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildReverseItems } from './generate-reverse-index.mjs';
import { ALT_TYPES, INLINE_TYPE } from './candidate-types.mjs';
import { classifyAlternates, parseAlternateTsv } from './merge-homonym-alt.mjs';
import { classifyInlineTokens, parseInlineTokenTsv } from './merge-inline-tokens.mjs';

const [,, allPath = './all.json', dataDir = './data'] = process.argv;

function priorityOf(item) {
  const n = Number(item.priority);
  return Number.isFinite(n) ? n : 999999;
}

function sortBucketItems(items) {
  return [...items].sort((a, b) => (
    String(a.prefix).localeCompare(String(b.prefix))
    || priorityOf(a) - priorityOf(b)
    || String(a.body || '').localeCompare(String(b.body || ''))
  ));
}

const errors = [];
const src = JSON.parse(await fs.readFile(allPath, 'utf8'));
const items = Array.isArray(src.items) ? src.items : [];
const buckets = new Map();

for (const item of items) {
  const key = String(item.prefix?.[0] || '#').toLowerCase();
  if (!buckets.has(key)) buckets.set(key, []);
  buckets.get(key).push(item);
}

const expectedFiles = new Set(Array.from(buckets.keys()).map(key => `ke-${key}.json`));
const actualFiles = new Set((await fs.readdir(dataDir)).filter(file => /^ke-.+\.json$/.test(file)));

for (const expectedFile of expectedFiles) {
  if (!actualFiles.has(expectedFile)) {
    errors.push(`missing split dictionary file: ${expectedFile}`);
  }
}
for (const actualFile of actualFiles) {
  if (!expectedFiles.has(actualFile)) {
    errors.push(`unexpected split dictionary file: ${actualFile}`);
  }
}

for (const [bucket, bucketItems] of buckets) {
  const file = `ke-${bucket}.json`;
  const filePath = path.join(dataDir, file);
  if (!actualFiles.has(file)) continue;
  const actual = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const expectedItems = sortBucketItems(bucketItems);
  const actualItems = Array.isArray(actual.items) ? actual.items : [];
  if (JSON.stringify(actualItems) !== JSON.stringify(expectedItems)) {
    errors.push(`split dictionary differs from all.json: ${file}`);
  }
  if (actual.meta && Number(actual.meta.itemCount) !== expectedItems.length) {
    errors.push(`wrong itemCount in ${file}: ${actual.meta.itemCount}`);
  }
}

// Cross-check the two HAND-MAINTAINED bucket lists (sw.js DICTIONARY_BUCKETS for the PWA
// precache, app.js bucketLetters for the lazy loader) against the buckets actually generated
// from all.json. Otherwise a future root whose prefix starts with q/w/x/y would emit a new
// ke-<letter>.json that is silently never precached (offline gap) and never loaded (app.js
// short-circuits unknown letters to []), with no error surfaced.
const generatedBuckets = Array.from(buckets.keys()).sort().join(',');
try {
  const repoRoot = path.dirname(path.resolve(allPath));
  const swText = await fs.readFile(path.join(repoRoot, 'sw.js'), 'utf8');
  const appText = await fs.readFile(path.join(repoRoot, 'app.js'), 'utf8');
  const swMatch = swText.match(/const DICTIONARY_BUCKETS = \[([^\]]*)\]/);
  if (!swMatch) {
    errors.push('could not find DICTIONARY_BUCKETS in sw.js');
  } else {
    const swBuckets = (swMatch[1].match(/'([a-z])'/g) || []).map(s => s.replace(/'/g, '')).sort().join(',');
    if (swBuckets !== generatedBuckets) {
      errors.push(`sw.js DICTIONARY_BUCKETS [${swBuckets}] != generated buckets [${generatedBuckets}]`);
    }
  }
  const appMatch = appText.match(/bucketLetters:\s*'([a-z]+)'/);
  if (!appMatch) {
    errors.push('could not find bucketLetters in app.js');
  } else {
    const appBuckets = appMatch[1].split('').sort().join(',');
    if (appBuckets !== generatedBuckets) {
      errors.push(`app.js bucketLetters [${appBuckets}] != generated buckets [${generatedBuckets}]`);
    }
  }
} catch (error) {
  errors.push(`cannot cross-check bucket lists: ${error.message}`);
}

const reversePath = path.join(dataDir, 'reverse.json');
try {
  const reverse = JSON.parse(await fs.readFile(reversePath, 'utf8'));
  // Re-derive the expected reverse index from all.json and verify its CONTENT
  // (kanji / prefixes / insertText / priority / ...), not merely its item count, so a
  // stale or corrupted reverse.json with a matching count cannot pass undetected.
  // The comparison is ORDER-INDEPENDENT: reverse.json's array order comes from a kanji
  // collation that can differ slightly across environments/ICU versions, but its set of
  // entries must match all.json exactly. We normalise by sorting each side's serialised
  // entries, so ordering never causes a false failure while any content change is caught.
  const expectedReverseItems = buildReverseItems(items);
  if (Number(reverse.meta?.dictionaryItemCount) !== items.length) {
    errors.push(`wrong reverse dictionaryItemCount: ${reverse.meta?.dictionaryItemCount}`);
  }
  const actualReverseItems = Array.isArray(reverse.items) ? reverse.items : [];
  if (actualReverseItems.length !== expectedReverseItems.length) {
    errors.push(`wrong reverse item count: ${actualReverseItems.length}, expected ${expectedReverseItems.length}`);
  } else {
    const normalize = (arr) => arr.map(it => JSON.stringify(it)).sort();
    const expectedNorm = normalize(expectedReverseItems);
    const actualNorm = normalize(actualReverseItems);
    if (JSON.stringify(actualNorm) !== JSON.stringify(expectedNorm)) {
      errors.push('reverse index content differs from all.json: data/reverse.json');
    }
  }
} catch (error) {
  errors.push(`cannot read reverse index: ${error.message}`);
}

// Reverse-mapping uniqueness: the reverter keys its dictionary by the kanji body and keeps
// only ONE root per body (first-wins), so if two DISTINCT source roots were assigned the same
// body (kanji + superscript identifier) the reverse direction would silently become lossy —
// one of the roots could never be recovered. The per-root identifier convention is meant to
// make every final form unique; assert it here so a future TSV mistake (a duplicate or
// forgotten identifier) is caught at build time instead of shipping a quietly lossy dictionary.
const rootsByBody = new Map();
for (const item of items) {
  const body = String(item.body || '');
  if (!body) continue;
  const root = String(item.sourceRoot || item.prefix || '');
  if (!rootsByBody.has(body)) rootsByBody.set(body, new Set());
  rootsByBody.get(body).add(root);
}
for (const [body, roots] of rootsByBody) {
  if (roots.size > 1) {
    errors.push(`reverse-mapping collision: body "${body}" is assigned to ${roots.size} distinct roots {${Array.from(roots).join(', ')}} — the reverter can recover only one`);
  }
}

// Curated homonym alternates (data/homonym-alt.tsv, merged by merge-homonym-alt.mjs) live
// OUTSIDE the sidecar the primary dictionary is built from, so a rebuild that runs only the
// sidecar → split → reverse steps would drop all of them and still look perfectly
// self-consistent to every check above. Re-derive the expected set with the merge tool's own
// classifier — never a second copy of the rules — and compare it against what all.json
// actually carries, so a forgotten merge step (or a drifted alternate) fails the build instead
// of silently shipping a dictionary that lost its second senses.
const altSourcePath = path.join(dataDir, 'homonym-alt.tsv');
try {
  const altRaw = await fs.readFile(altSourcePath, 'utf8');
  const altRows = parseAlternateTsv(altRaw);
  // Same baseline the merge step uses: inline tokens rank AFTER the alternates, so they must not
  // be part of what the alternates are ranked against (see merge-homonym-alt.mjs).
  const baseItems = items.filter(item => !ALT_TYPES.has(item.type) && item.type !== INLINE_TYPE);
  const { adopted } = classifyAlternates(baseItems, altRows, path.basename(altSourcePath));
  const actual = items.filter(item => ALT_TYPES.has(item.type));
  const actualByBody = new Map(actual.map(item => [String(item.body || ''), item]));

  if (actual.length !== adopted.length) {
    errors.push(`homonym alternates: all.json carries ${actual.length} but ${path.basename(altSourcePath)} yields ${adopted.length} — run: node tools/merge-homonym-alt.mjs ./all.json ${altSourcePath} ./all.json`);
  }
  for (const entry of adopted) {
    const item = actualByBody.get(entry.item.body);
    if (!item) {
      errors.push(`homonym alternate missing from all.json: ${entry.row.segment} → ${entry.item.body}`);
      continue;
    }
    if (JSON.stringify(item) !== JSON.stringify(entry.item)) {
      errors.push(`homonym alternate differs from its source row: ${entry.item.body} (${entry.row.segment}, line ${entry.row.line})`);
    }
  }
} catch (error) {
  // Absent source file: nothing to enforce (legacy dictionaries built by ke-txt-to-all.mjs
  // have no alternates at all). Any other failure is a real problem worth surfacing.
  if (error.code !== 'ENOENT') errors.push(`cannot verify homonym alternates: ${error.message}`);
}

// Inline rendering tokens (data/inline-tokens.tsv, merged by merge-inline-tokens.mjs) sit outside
// the sidecar exactly like the homonym alternates, and are protected the same way: re-derive the
// expected set with that tool's own classifier and compare. This also pins the ADOPTED_RULES
// policy — if the master adds a rule, or an excluded rule is quietly let in, the build fails
// instead of shipping new candidates on high-traffic suffixes that nobody reviewed.
const inlineSourcePath = path.join(dataDir, 'inline-tokens.tsv');
try {
  const inlineRaw = await fs.readFile(inlineSourcePath, 'utf8');
  const inlineRows = parseInlineTokenTsv(inlineRaw);
  const existing = items.filter(item => item.type !== INLINE_TYPE);
  const { adopted } = classifyInlineTokens(existing, inlineRows, path.basename(inlineSourcePath));
  const actual = items.filter(item => item.type === INLINE_TYPE);
  const actualByBody = new Map(actual.map(item => [String(item.body || ''), item]));

  if (actual.length !== adopted.length) {
    errors.push(`inline tokens: all.json carries ${actual.length} but ${path.basename(inlineSourcePath)} yields ${adopted.length} — run: node tools/merge-inline-tokens.mjs ./all.json ${inlineSourcePath} ./all.json`);
  }
  for (const entry of adopted) {
    const item = actualByBody.get(entry.item.body);
    if (!item) {
      errors.push(`inline token missing from all.json: ${entry.row.segment} → ${entry.item.body}`);
      continue;
    }
    if (JSON.stringify(item) !== JSON.stringify(entry.item)) {
      errors.push(`inline token differs from its source row: ${entry.item.body} (${entry.row.segment}, line ${entry.row.line})`);
    }
  }
} catch (error) {
  if (error.code !== 'ENOENT') errors.push(`cannot verify inline tokens: ${error.message}`);
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`OK: ${items.length} dictionary items match split assets in ${dataDir}`);
