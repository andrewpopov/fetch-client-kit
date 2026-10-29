#!/usr/bin/env node
/**
 * Runs AFTER `npm run compile` and reads the freshly built output: the core module
 * must never reference the upload code, so a consumer that does not upload never
 * loads it.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(fileURLToPath(new URL('..', import.meta.url)), 'dist');

function fail(message) {
  console.error(`\n[verify:separation] FAIL: ${message}\n`);
  process.exit(1);
}

if (!existsSync(join(dist, 'upload.js'))) fail('dist/upload.js is missing; run `npm run compile` first');

const forbidden = [
  ['XMLHttpRequest', /XMLHttpRequest/],
  ['xhrUploadTransport', /xhrUploadTransport/],
  ['a require of ./upload', /require\(["']\.\/upload["']\)/],
];

for (const file of ['index.js', 'cancellation.js']) {
  const source = readFileSync(join(dist, file), 'utf8');
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) fail(`dist/${file} references ${label}`);
  }
}
console.log('[verify:separation] PASS: the built core never references the upload code.');
