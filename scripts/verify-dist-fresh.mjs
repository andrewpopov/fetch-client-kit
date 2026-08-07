#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

// npm's entry point is npm.cmd on Windows: spawnSync applies no PATHEXT so
// plain 'npm' is ENOENT, and naming npm.cmd is EINVAL because Node >= 20
// refuses to spawn .cmd without a shell (the CVE-2024-27980 mitigation).
// Running npm's own npm-cli.js under this node keeps an argv array end to end
// and needs no shell, so nothing has to be quoted for cmd.exe.
function npmCliPath() {
  const fromNpm = process.env.npm_execpath;
  if (fromNpm && /\.js$/i.test(fromNpm)) {
    const absolute = resolve(fromNpm);
    if (existsSync(absolute)) return absolute;
  }
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(bundled) ? bundled : null;
}

function run(command, args, options = {}) {
  if (command === 'npm') {
    const cli = npmCliPath();
    if (cli) return execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...options });
  }
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function fail(message) {
  console.error(`\n[verify:dist-fresh] FAIL: ${message}\n`);
  process.exit(1);
}

function gitStatus(paths) {
  return run('git', ['status', '--porcelain', '--', ...paths], { cwd: packageRoot });
}

const preStatus = gitStatus(['dist', 'src']);
if (preStatus.trim()) {
  fail(
    `Working tree has uncommitted changes under dist/ or src/:\n${preStatus}` +
      'Commit or stash these before running this guard — otherwise it cannot ' +
      'attribute a dist diff to staleness rather than your in-progress edit.',
  );
}

console.log('[verify:dist-fresh] Building...');
run('npm', ['run', 'build'], { cwd: packageRoot, stdio: 'inherit' });

const postStatus = gitStatus(['dist']);
if (postStatus.trim()) {
  fail(
    `Committed dist/ is stale; a fresh build produced different output:\n${postStatus}` +
      'Run `npm run build` and commit dist/ before releasing.',
  );
}

console.log('[verify:dist-fresh] PASS: committed dist matches a fresh build.');
