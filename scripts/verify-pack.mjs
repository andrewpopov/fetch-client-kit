#!/usr/bin/env node
/**
 * Pack the package into a tarball, install it into a throwaway project, and
 * assert that:
 *   1. dist/index.d.ts ships inside the tarball.
 *   2. CommonJS `require()` exposes createFetchClient + cookieAuth.
 *   3. Native ESM `import { ... }` resolves the same named exports (this is what
 *      catches the "member-expression export" bug where cjs-module-lexer can't
 *      see the names for ESM consumers).
 *
 * Exits non-zero with a clear message on any failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pkgRoot = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts });
}

function fail(message) {
  console.error(`\n[verify:pack] FAIL: ${message}\n`);
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'esk-verify-'));
let tarballPath;

try {
  console.log('[verify:pack] Building...');
  run('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'inherit' });

  if (!existsSync(join(pkgRoot, 'dist', 'index.d.ts'))) {
    fail('dist/index.d.ts is missing after build');
  }

  console.log('[verify:pack] Packing tarball...');
  const packOut = run('npm', ['pack', '--json', '--pack-destination', workDir], {
    cwd: pkgRoot,
  });
  const packInfo = JSON.parse(packOut);
  const filename = packInfo[0].filename;
  tarballPath = join(workDir, filename);

  // 1. Assert the declaration file ships inside the tarball.
  const contents = run('tar', ['-tzf', tarballPath]);
  if (!contents.includes('package/dist/index.d.ts')) {
    fail('dist/index.d.ts is not present in the packed tarball');
  }
  console.log('[verify:pack] OK: dist/index.d.ts ships in tarball');

  // Set up a throwaway consumer project and install the tarball.
  const consumerDir = join(workDir, 'consumer');
  run('mkdir', ['-p', consumerDir]);
  writeFileSync(
    join(consumerDir, 'package.json'),
    JSON.stringify(
      {
        name: 'esk-consumer',
        version: '1.0.0',
        private: true,
        // Peer deps are required by the package; provide them so it loads.
      },
      null,
      2,
    ),
  );

  console.log('[verify:pack] Installing tarball + peers into consumer...');
  run('npm', ['install', '--no-audit', '--no-fund', tarballPath, 'express', 'helmet'], {
    cwd: consumerDir,
    stdio: 'inherit',
  });

  // 2. CommonJS require smoke.
  const cjsSmoke = `
    const mod = require('${pkg.name}');
    const expected = ['createFetchClient', 'cookieAuth', 'bearerAuth', 'csrfAuth'];
    const missing = expected.filter((n) => typeof mod[n] !== 'function');
    if (missing.length) {
      console.error('CJS missing exports: ' + missing.join(', '));
      process.exit(2);
    }
    console.log('CJS OK');
  `;
  writeFileSync(join(consumerDir, 'smoke.cjs'), cjsSmoke);
  const cjsOut = run('node', ['smoke.cjs'], { cwd: consumerDir });
  if (!cjsOut.includes('CJS OK')) fail('CommonJS smoke did not report OK');
  console.log('[verify:pack] OK: CommonJS require exposes named exports');

  // The declaration ships (dist/index.d.ts present) and its exports are checked below.

  // 3. Native ESM import smoke (catches the member-expression export bug).
  const esmSmoke = `
    import { createFetchClient, cookieAuth, bearerAuth, csrfAuth } from '${pkg.name}';
    for (const [n, f] of Object.entries({ createFetchClient, cookieAuth, bearerAuth, csrfAuth })) {
      if (typeof f !== 'function') { console.error('ESM missing: ' + n); process.exit(5); }
    }
    console.log('ESM OK');
  `;
  writeFileSync(join(consumerDir, 'smoke.mjs'), esmSmoke);
  const esmOut = run('node', ['smoke.mjs'], { cwd: consumerDir });
  if (!esmOut.includes('ESM OK')) fail('ESM smoke did not report OK');
  console.log('[verify:pack] OK: ESM named imports resolve');

  console.log('\n[verify:pack] PASS: all checks green');
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}
