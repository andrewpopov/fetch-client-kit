#!/usr/bin/env node
/**
 * Pack the package into a tarball, install it into a throwaway project, and
 * assert that:
 *   1. dist/index.d.ts, dist/upload.js and dist/upload.d.ts ship inside the tarball.
 *   2. CommonJS `require()` exposes the public functions of BOTH entry points: the
 *      root (createFetchClient, the auth strategies, isAbortError) and `/upload`
 *      (upload, the transports, isAbortError), and requiring the root never loads
 *      the upload file.
 *   3. Native ESM `import { ... }` resolves the same named exports from both entry
 *      points (this is what catches the "member-expression export" bug where
 *      cjs-module-lexer can't see the names for ESM consumers).
 *   4. TypeScript resolves both entry points under node16 (CJS and ESM) and bundler
 *      module resolution.
 *
 * Exits non-zero with a clear message on any failure.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
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
  run('npm', ['run', 'compile'], { cwd: pkgRoot, stdio: 'inherit' });

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
  for (const file of ['index.d.ts', 'upload.js', 'upload.d.ts']) {
    if (!contents.includes(`package/dist/${file}`)) {
      fail(`dist/${file} is not present in the packed tarball`);
    }
  }
  console.log('[verify:pack] OK: dist/index.d.ts and the ./upload files ship in tarball');

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
    const expected = ['createFetchClient', 'cookieAuth', 'bearerAuth', 'csrfAuth', 'isAbortError'];
    const missing = expected.filter((n) => typeof mod[n] !== 'function');
    if (missing.length) {
      console.error('CJS missing exports: ' + missing.join(', '));
      process.exit(2);
    }
    if (Object.keys(require.cache).some((file) => file.replace(/\\\\/g, '/').endsWith('/dist/upload.js'))) {
      console.error('CJS: requiring the root loaded the upload file');
      process.exit(3);
    }
    const sub = require('${pkg.name}/upload');
    const expectedUpload = ['upload', 'xhrUploadTransport', 'fetchUploadTransport', 'isAbortError'];
    const missingUpload = expectedUpload.filter((n) => typeof sub[n] !== 'function');
    if (missingUpload.length) {
      console.error('CJS missing /upload exports: ' + missingUpload.join(', '));
      process.exit(4);
    }
    if (sub.isAbortError !== mod.isAbortError) {
      console.error('CJS: root and /upload isAbortError differ');
      process.exit(6);
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
    import { createFetchClient, cookieAuth, bearerAuth, csrfAuth, isAbortError } from '${pkg.name}';
    import { upload, xhrUploadTransport, fetchUploadTransport, isAbortError as subIsAbortError } from '${pkg.name}/upload';
    for (const [n, f] of Object.entries({ createFetchClient, cookieAuth, bearerAuth, csrfAuth, isAbortError, upload, xhrUploadTransport, fetchUploadTransport })) {
      if (typeof f !== 'function') { console.error('ESM missing: ' + n); process.exit(5); }
    }
    if (subIsAbortError !== isAbortError) { console.error('ESM: root and /upload isAbortError differ'); process.exit(7); }
    console.log('ESM OK');
  `;
  writeFileSync(join(consumerDir, 'smoke.mjs'), esmSmoke);
  const esmOut = run('node', ['smoke.mjs'], { cwd: consumerDir });
  if (!esmOut.includes('ESM OK')) fail('ESM smoke did not report OK');
  console.log('[verify:pack] OK: ESM named imports resolve');

  // 4. Types resolve for both entry points under each module resolution a consumer may use.
  const typeSmoke = `
    import { createFetchClient, cookieAuth, isAbortError, type FetchClient, type AttemptContext } from '${pkg.name}';
    import { upload, xhrUploadTransport, fetchUploadTransport, type UploadTransport } from '${pkg.name}/upload';
    const client: FetchClient = createFetchClient({ baseUrl: 'http://x', auth: cookieAuth() });
    const transport: UploadTransport = xhrUploadTransport();
    const fetchTransport: UploadTransport = fetchUploadTransport();
    const attempt = (context: AttemptContext) => context.fetcher(context.url, context.decorate({}));
    export const sent: Promise<unknown> = upload(client, { path: '/p', method: 'PUT', body: 'x', transport });
    export const raw: Promise<Response> = client.exchange('/p', attempt);
    export const kept = [isAbortError, fetchTransport];
  `;
  writeFileSync(join(consumerDir, 'types-check.cts'), typeSmoke);
  writeFileSync(join(consumerDir, 'types-check.mts'), typeSmoke);
  const tsc = join(pkgRoot, 'node_modules', 'typescript', 'bin', 'tsc');
  const typeModes = [
    ['node16 (CJS)', ['types-check.cts', '--module', 'node16', '--moduleResolution', 'node16']],
    ['node16 (ESM)', ['types-check.mts', '--module', 'node16', '--moduleResolution', 'node16']],
    ['bundler', ['types-check.mts', '--module', 'esnext', '--moduleResolution', 'bundler']],
  ];
  for (const [label, args] of typeModes) {
    try {
      run('node', [tsc, '--noEmit', '--strict', '--target', 'es2020', '--lib', 'es2020,dom', ...args], {
        cwd: consumerDir,
        stdio: 'pipe',
      });
    } catch (error) {
      fail(`TypeScript could not resolve both entry points under ${label}:\n${error.stdout ?? ''}${error.stderr ?? ''}`);
    }
    console.log(`[verify:pack] OK: types resolve under ${label}`);
  }

  console.log('\n[verify:pack] PASS: all checks green');
} finally {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}
