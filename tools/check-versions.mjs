#!/usr/bin/env node
// Verify the hand-maintained version strings agree across sw.js, app.js, and index.html.
//
// Two independent version tracks must each be byte-identical wherever they are duplicated,
// otherwise the service worker caches one URL while the page requests another:
//   - APP_VERSION  (code):  sw.js APP_VERSION === index.html KE_APP_VERSION === the ?v= on
//                           index.html's app.js and sw.js script/register URLs.
//   - DICTIONARY_VERSION (data):  sw.js DICTIONARY_VERSION === app.js DEFAULT_DICTIONARY_ASSET_VERSION.
//
// DEFAULT_DICTIONARY_ID (app.js) intentionally has NO -rN suffix (it is the cache-set key,
// not the cache-buster), so it is deliberately excluded from these assertions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pick(source, label, regex) {
  const match = source.text.match(regex);
  if (!match) {
    return { error: `could not find ${label} in ${source.name}` };
  }
  return { value: match[1] };
}

const sw = { name: 'sw.js', text: await fs.readFile(path.join(ROOT, 'sw.js'), 'utf8') };
const app = { name: 'app.js', text: await fs.readFile(path.join(ROOT, 'app.js'), 'utf8') };
const html = { name: 'index.html', text: await fs.readFile(path.join(ROOT, 'index.html'), 'utf8') };

const errors = [];

const checks = {
  'sw.js APP_VERSION': pick(sw, 'APP_VERSION', /const APP_VERSION = '([^']+)'/),
  'sw.js DICTIONARY_VERSION': pick(sw, 'DICTIONARY_VERSION', /const DICTIONARY_VERSION = '([^']+)'/),
  'app.js DEFAULT_DICTIONARY_ASSET_VERSION': pick(app, 'DEFAULT_DICTIONARY_ASSET_VERSION', /const DEFAULT_DICTIONARY_ASSET_VERSION = '([^']+)'/),
  'index.html KE_APP_VERSION': pick(html, 'KE_APP_VERSION', /window\.KE_APP_VERSION = '([^']+)'/),
  'index.html app.js?v=': pick(html, 'app.js?v=', /app\.js\?v=([^"']+)"/),
  'index.html sw.js?v=': pick(html, 'sw.js?v=', /sw\.js\?v=([^"']+)'/),
};

for (const [label, result] of Object.entries(checks)) {
  if (result.error) errors.push(result.error);
}

if (!errors.length) {
  const appVersions = {
    'sw.js APP_VERSION': checks['sw.js APP_VERSION'].value,
    'index.html KE_APP_VERSION': checks['index.html KE_APP_VERSION'].value,
    'index.html app.js?v=': checks['index.html app.js?v='].value,
    'index.html sw.js?v=': checks['index.html sw.js?v='].value,
  };
  const appSet = new Set(Object.values(appVersions));
  if (appSet.size !== 1) {
    errors.push(`APP_VERSION strings disagree: ${JSON.stringify(appVersions)}`);
  }

  const dictVersions = {
    'sw.js DICTIONARY_VERSION': checks['sw.js DICTIONARY_VERSION'].value,
    'app.js DEFAULT_DICTIONARY_ASSET_VERSION': checks['app.js DEFAULT_DICTIONARY_ASSET_VERSION'].value,
  };
  const dictSet = new Set(Object.values(dictVersions));
  if (dictSet.size !== 1) {
    errors.push(`DICTIONARY_VERSION strings disagree: ${JSON.stringify(dictVersions)}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`OK: APP_VERSION='${checks['sw.js APP_VERSION'].value}', DICTIONARY_VERSION='${checks['sw.js DICTIONARY_VERSION'].value}' consistent across sw.js / app.js / index.html`);
