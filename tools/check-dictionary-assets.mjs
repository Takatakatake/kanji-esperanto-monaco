#!/usr/bin/env node
// Verify that split dictionary assets match all.json.
import fs from 'node:fs/promises';
import path from 'node:path';

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

function reverseKey(item) {
  const body = String(item.body || '').trim();
  const prefix = String(item.prefix || '').trim();
  const sourceRoot = String(item.sourceRoot || prefix).trim();
  return body && prefix ? `${body}\u0000${sourceRoot}` : '';
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

const reversePath = path.join(dataDir, 'reverse.json');
try {
  const reverse = JSON.parse(await fs.readFile(reversePath, 'utf8'));
  const expectedReverseCount = new Set(items.map(reverseKey).filter(Boolean)).size;
  if (Number(reverse.meta?.dictionaryItemCount) !== items.length) {
    errors.push(`wrong reverse dictionaryItemCount: ${reverse.meta?.dictionaryItemCount}`);
  }
  if (Array.isArray(reverse.items) && reverse.items.length !== expectedReverseCount) {
    errors.push(`wrong reverse item count: ${reverse.items.length}, expected ${expectedReverseCount}`);
  }
} catch (error) {
  errors.push(`cannot read reverse index: ${error.message}`);
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`OK: ${items.length} dictionary items match split assets in ${dataDir}`);
