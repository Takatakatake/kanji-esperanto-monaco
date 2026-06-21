#!/usr/bin/env node
// Verify the hand-maintained version strings agree across sw.js, app.js, and index.html.
//
// Two independent version tracks must each be byte-identical wherever they are duplicated,
// otherwise the service worker caches one URL while the page requests another:
//   - APP_VERSION  (code):  sw.js APP_VERSION === index.html KE_APP_VERSION === EVERY ?v= on
//                           index.html's app.js and sw.js script/register URLs.
//   - DICTIONARY_VERSION (data):  sw.js DICTIONARY_VERSION === app.js DEFAULT_DICTIONARY_ASSET_VERSION.
//
// The human-readable footer is also checked to carry the current dictionary-refresh-N suffix
// (its date is formatted differently, so only the suffix is asserted).
//
// DEFAULT_DICTIONARY_ID (app.js) intentionally has NO -rN suffix (it is the cache-set key,
// not the cache-buster), so it is deliberately excluded from these assertions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pick(source, label, regex) {
  const match = source.text.match(regex);
  if (!match) return { error: `could not find ${label} in ${source.name}` };
  return { value: match[1] };
}

// Collect EVERY occurrence (not just the first), so a stale duplicate reference is caught.
function pickAll(source, label, regex) {
  const values = [...source.text.matchAll(regex)].map(m => m[1]);
  if (!values.length) return { error: `could not find any ${label} in ${source.name}` };
  return { values };
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
};
const appJsRefs = pickAll(html, 'app.js?v=', /app\.js\?v=([^"'\s>]+)/g);
const swJsRefs = pickAll(html, 'sw.js?v=', /sw\.js\?v=([^"'\s>)]+)/g);

for (const result of [...Object.values(checks), appJsRefs, swJsRefs]) {
  if (result.error) errors.push(result.error);
}

if (!errors.length) {
  // APP_VERSION track: the two declared constants plus every ?v= reference must all agree.
  const appVersions = {
    'sw.js APP_VERSION': checks['sw.js APP_VERSION'].value,
    'index.html KE_APP_VERSION': checks['index.html KE_APP_VERSION'].value,
  };
  appJsRefs.values.forEach((v, i) => { appVersions[`index.html app.js?v=[${i}]`] = v; });
  swJsRefs.values.forEach((v, i) => { appVersions[`index.html sw.js?v=[${i}]`] = v; });
  if (new Set(Object.values(appVersions)).size !== 1) {
    errors.push(`APP_VERSION strings disagree: ${JSON.stringify(appVersions)}`);
  }

  // DICTIONARY_VERSION track.
  const dictVersions = {
    'sw.js DICTIONARY_VERSION': checks['sw.js DICTIONARY_VERSION'].value,
    'app.js DEFAULT_DICTIONARY_ASSET_VERSION': checks['app.js DEFAULT_DICTIONARY_ASSET_VERSION'].value,
  };
  if (new Set(Object.values(dictVersions)).size !== 1) {
    errors.push(`DICTIONARY_VERSION strings disagree: ${JSON.stringify(dictVersions)}`);
  }

  // Footer must carry the current dictionary-refresh-N suffix (date format differs by design).
  const refreshSuffix = (checks['sw.js APP_VERSION'].value.match(/(dictionary-refresh-\d+)/) || [])[1];
  const footer = html.text.match(/<footer>([\s\S]*?)<\/footer>/);
  if (!footer) {
    errors.push('could not find <footer> in index.html');
  } else if (refreshSuffix && !footer[1].includes(refreshSuffix)) {
    errors.push(`index.html footer is missing the current version suffix '${refreshSuffix}' (footer: ${footer[1].trim()})`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  process.exit(1);
}

console.log(`OK: APP_VERSION='${checks['sw.js APP_VERSION'].value}', DICTIONARY_VERSION='${checks['sw.js DICTIONARY_VERSION'].value}' consistent across sw.js / app.js / index.html (incl. all ?v= refs + footer)`);
