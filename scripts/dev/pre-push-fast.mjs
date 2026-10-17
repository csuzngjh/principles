#!/usr/bin/env node
// Fast local push gate. The full merge contract remains CI's responsibility.
// Reuse the CI impact resolver: do not create a second package dependency graph.
// Local worktree safety is enforced separately by Lefthook's worktree-guard.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeImpact } from '../ci/impact.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ESLINT = path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js');

// Keep the exact test/file exclusions used by scripts/lint-by-package.mjs.
// eslint.config.js applies further ignored directories such as website.
export function selectTargets(changedFiles, exists = (file) => fs.existsSync(path.join(ROOT, file))) {
  const syntax = [];
  const lintByPackage = new Map();
  for (const file of changedFiles) {
    if (!exists(file)) continue; // deletion: CI handles cross-file effects
    if (/\.(?:cjs|mjs|js)$/.test(file)) syntax.push(file);
    if (!/^packages\/[^/]+\/.*\.ts$/.test(file)) continue;
    if (/\.(?:test|spec|d)\.ts$/.test(file)) continue;
    const pkgDir = file.split('/').slice(0, 2).join('/');
    if (!lintByPackage.has(pkgDir)) lintByPackage.set(pkgDir, []);
    lintByPackage.get(pkgDir).push(file);
  }
  return { syntax: syntax.sort(), lintByPackage: new Map([...lintByPackage].sort(([a], [b]) => a.localeCompare(b))) };
}

function run(label, command, args) {
  console.log('[pre-push-fast] ' + label);
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', windowsHide: true });
  if (result.error) throw new Error(label + ': ' + result.error.message);
  if (result.status !== 0) throw new Error(label + ' failed (exit ' + result.status + ')');
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const baseIndex = argv.indexOf('--base');
  if (argv.some((arg, i) => !['--dry-run', '--base'].includes(arg) && !(baseIndex >= 0 && i === baseIndex + 1))) {
    throw new Error('Usage: node scripts/dev/pre-push-fast.mjs [--dry-run] [--base <ref>]');
  }
  if (baseIndex !== -1 && !argv[baseIndex + 1]) throw new Error('--base requires a ref');
  const base = baseIndex === -1 ? 'origin/main' : argv[baseIndex + 1];
  const impact = await computeImpact({ base, head: 'HEAD', repo: ROOT });
  const { syntax, lintByPackage } = selectTargets(impact.changedFiles);
  console.log('[pre-push-fast] ' + impact.changedFiles.length + ' changed files; ' +
    impact.affectedPackages.length + ' affected packages; docs-only=' + impact.docsOnly);
  console.log('[pre-push-fast] ' + syntax.length + ' Node syntax files; ' +
    [...lintByPackage.values()].reduce((n, files) => n + files.length, 0) + ' TypeScript files.');
  if (dryRun) {
    for (const file of syntax) console.log('[pre-push-fast] PLAN node --check ' + file);
    for (const [pkg, files] of lintByPackage) console.log('[pre-push-fast] PLAN eslint ' + pkg + ' (' + files.length + ' files)');
    return;
  }
  for (const file of syntax) run('syntax: ' + file, process.execPath, ['--check', file]);
  if (lintByPackage.size > 0 && !fs.existsSync(ESLINT)) {
    throw new Error('ESLint not installed in this worktree; run npm run dev:worktree:bootstrap');
  }
  // A separate ESLint process per package prevents the type-aware heap
  // accumulation that previously caused Windows OOM (PRI-961).
  for (const [pkg, files] of lintByPackage) {
    run('eslint: ' + pkg, process.execPath, [ESLINT, ...files, '--no-warn-ignored']);
  }
  console.log('[pre-push-fast] PASS. Full verify:merge + package tests run on PR CI.');
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  console.error('[pre-push-fast] FAIL: ' + error.message);
  console.error('[pre-push-fast] Check local refs (git fetch origin), resolve errors and retry; never silently skip.');
  process.exitCode = 1;
});
