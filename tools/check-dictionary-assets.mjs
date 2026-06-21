#!/usr/bin/env node
// Verify that split dictionary assets match all.json.
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildReverseItems } from './generate-reverse-index.mjs';

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

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`OK: ${items.length} dictionary items match split assets in ${dataDir}`);
