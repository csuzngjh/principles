#!/usr/bin/env node
// PRI-961 — per-package ESLint scheduler (replaces the single full-repo lint).
//
// The old `npm run lint` linted `packages` TS globs in ONE ESLint process with
// type-aware rules (projectService). TypeScript programs across all packages
// accumulated in that process until the default V8 heap was exhausted:
// `FATAL ERROR: Ineffective mark-compacts near heap limit`, exit 134
// (Windows + Node 26.7.0, evidence in Linear PRI-961).
//
// This script runs the SAME ESLint CLI with the SAME config once per
// workspace package in its own child process, strictly serially. Each child's
// exit releases its type-aware memory, so per-package usage no longer adds up
// across packages. Rules, ignores and projectService semantics stay in
// eslint.config.js — this script only schedules processes.
//
// Contract:
// - Packages are discovered from the root package.json `workspaces` patterns
//   (currently `packages/*`): every matched directory containing a
//   package.json, sorted lexically. New workspace packages are linted
//   automatically; no package list is hardcoded.
// - Each child lints one package TS glob with the same three --ignore-pattern
//   flags the old command passed. cwd stays at the repo root, so
//   `tsconfigRootDir: process.cwd()` resolves identically.
// - --no-error-on-unmatched-pattern keeps packages whose matched files are
//   all config-ignored (e.g. packages/website, globally ignored) or that have
//   no .ts files at all a safe skip instead of a failure. ESLint remains the
//   single authority on ignore semantics — no duplicated ignore logic here.
// - Any extra CLI args (e.g. --fix) are forwarded verbatim to every child.
// - One failing package never cancels the rest: every package runs, then the
//   scheduler exits non-zero naming the failures. Spawn errors, signal-killed
//   children and Ctrl-C are failures, never successes; Ctrl-C also terminates
//   the running child before exiting.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const IGNORE_PATTERNS = ['**/*.test.ts', '**/*.spec.ts', '**/*.d.ts'];
const UNMATCHED_PATTERN_FLAG = '--no-error-on-unmatched-pattern';

export function repoRootFromModuleUrl(moduleUrl) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..');
}

/** Expand one workspace glob pattern (`*` segments only) to dirs with a package.json. */
function expandWorkspacePattern(root, pattern) {
  const segments = String(pattern).split(/[\\/]+/).filter(Boolean);
  let current = [root];
  for (const segment of segments) {
    if (segment !== '*' && segment.includes('*')) {
      throw new Error(`Unsupported workspace pattern segment "${segment}" in "${pattern}"`);
    }
    const next = [];
    for (const dir of current) {
      if (segment === '*') {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) next.push(path.join(dir, entry.name));
        }
      } else {
        const joined = path.join(dir, segment);
        if (fs.existsSync(joined)) next.push(joined);
      }
    }
    current = next;
  }
  return current.filter((dir) => fs.existsSync(path.join(dir, 'package.json')));
}

/**
 * Workspace package directories that need linting, relative to `root`,
 * POSIX-separated and lexically sorted (stable order).
 */
export function discoverPackageRelDirs(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const relDirs = new Set();
  for (const pattern of manifest.workspaces ?? []) {
    for (const dir of expandWorkspacePattern(root, pattern)) {
      relDirs.add(path.relative(root, dir).split(path.sep).join('/'));
    }
  }
  return [...relDirs].sort();
}

/**
 * The exact args one child ESLint process receives for one package.
 * `packageRelDir` is POSIX-separated relative to the repo root.
 */
export function buildEslintArgs(packageRelDir, extraArgs = []) {
  return [
    `${packageRelDir}/**/*.ts`,
    ...IGNORE_PATTERNS.flatMap((pattern) => ['--ignore-pattern', pattern]),
    UNMATCHED_PATTERN_FLAG,
    ...extraArgs,
  ];
}

function resolveEslintBin(root) {
  const bin = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (!fs.existsSync(bin)) {
    throw new Error(`ESLint CLI not found at ${bin} — run npm install at the repository root first.`);
  }
  return bin;
}

/**
 * Run one child ESLint process for one package. Resolves after the child
 * exits with { code, signal, error? }; never rejects.
 */
function runEslintForPackage({ root, eslintBin, packageRelDir, extraArgs, spawnChild, onSpawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnChild(process.execPath, [eslintBin, ...buildEslintArgs(packageRelDir, extraArgs)], {
        cwd: root,
        stdio: 'inherit',
        shell: false,
      });
    } catch (error) {
      resolve({ code: null, signal: null, error });
      return;
    }
    onSpawn?.(child);
    child.on('error', (error) => resolve({ code: null, signal: null, error }));
    child.on('close', (code, signal) => resolve({ code, signal, error: null }));
  });
}

/**
 * Lint every workspace package serially, one child process per package.
 * Returns { ok, interrupted, results }; never throws for per-package lint
 * failures — only discovery/config problems (thrown before any child runs).
 */
export async function runLintByPackage({
  root,
  args = [],
  spawnChild = spawn,
  log = (message) => process.stdout.write(`${message}\n`),
  signalTarget = null,
} = {}) {
  const eslintBin = resolveEslintBin(root);
  const packageRelDirs = discoverPackageRelDirs(root);
  const results = [];

  let activeChild = null;
  let interrupted = false;
  const interruptWith = (signal) => {
    interrupted = true;
    activeChild?.kill(signal);
  };
  // Real `process` invokes signal listeners with NO arguments, so each signal
  // gets its own closure forwarding the explicit name (a shared
  // `onSignal(signal)` would forward `undefined` and default to SIGTERM).
  const onSigint = () => interruptWith('SIGINT');
  const onSigterm = () => interruptWith('SIGTERM');
  // `signalTarget` is EventEmitter-like (process in production); `null`
  // disables signal handling (tests).
  if (signalTarget) {
    signalTarget.on('SIGINT', onSigint);
    signalTarget.on('SIGTERM', onSigterm);
  }

  try {
    for (const [index, packageRelDir] of packageRelDirs.entries()) {
      if (interrupted) break;
      log(`[lint-by-package] (${index + 1}/${packageRelDirs.length}) eslint ${packageRelDir} ...`);
      const startedAtMs = Date.now();
      const outcome = await runEslintForPackage({
        root,
        eslintBin,
        packageRelDir,
        extraArgs: args,
        spawnChild,
        onSpawn: (child) => {
          activeChild = child;
        },
      });
      activeChild = null;
      const seconds = ((Date.now() - startedAtMs) / 1000).toFixed(1);
      const failedBecause =
        outcome.error?.message ??
        (outcome.signal ? `killed by ${outcome.signal}` : undefined);
      const ok = !outcome.error && outcome.code === 0 && !outcome.signal;
      results.push({
        package: packageRelDir,
        ok,
        code: outcome.code,
        signal: outcome.signal,
        error: outcome.error?.message ?? null,
        seconds: Number(seconds),
      });
      log(
        `[lint-by-package] ${packageRelDir} -> ${ok ? 'ok' : `FAILED${failedBecause ? ` (${failedBecause})` : ` exit=${outcome.code}`}`} in ${seconds}s`,
      );
    }
  } finally {
    if (signalTarget) {
      signalTarget.off('SIGINT', onSigint);
      signalTarget.off('SIGTERM', onSigterm);
    }
  }

  const failures = results.filter((result) => !result.ok);
  log(
    `[lint-by-package] summary: ${results.length - failures.length}/${packageRelDirs.length} packages ok` +
      (failures.length ? `, FAILED: ${failures.map((r) => r.package).join(', ')}` : ''),
  );
  if (interrupted) log('[lint-by-package] interrupted — remaining packages were not linted');
  return { ok: failures.length === 0 && !interrupted, interrupted, results };
}

export async function main(argv = process.argv.slice(2)) {
  const root = repoRootFromModuleUrl(import.meta.url);
  try {
    const { ok, interrupted } = await runLintByPackage({ root, args: argv, signalTarget: process });
    process.exitCode = interrupted ? 130 : ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`[lint-by-package] ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
