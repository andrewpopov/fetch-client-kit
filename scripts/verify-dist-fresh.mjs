#!/usr/bin/env node
import { execFileSync } from 'node:child_process';

const packageRoot = new URL('..', import.meta.url).pathname;

function run(command, args, options = {}) {
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
