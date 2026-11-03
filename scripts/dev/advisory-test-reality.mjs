#!/usr/bin/env node
// PRI-965 / EP-09 — ADVISORY ONLY.
//
// Reminds authors that a failure-path test must (a) feed a state production
// can really produce and (b) carry a positive control that turns red when the
// branch is not taken. This script NEVER exits non-zero for findings and is
// deliberately not wired into verify:merge.
//
// Usage:
//   node scripts/dev/advisory-test-reality.mjs [--root <dir>] [--all]
//     [--base <ref>] [--json]
//
// Default mode scans the diff origin/main...HEAD for ADDED lines in test files.
// --all scans every git-tracked test file (false-positive measurement).
//
// Heuristic scope: an added assertion is reported only when it has no
// discriminator on the same line:
//   * bare `toThrow()` / `rejects.toThrow()` (no matcher), or
//   * `expect(<generic>).not.toHaveBeenCalled*()` where <generic> is not a
//     named spy/mock.
// A named matcher (`toThrow('reason-code')`) or named spy (`writeSpy`) is
// treated as a marker, so it is not reported.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TEST_FILE = /\.(test|spec)\.(ts|tsx|js|mjs|cjs)$/;

function parseArgs(argv) {
  const args = { root: process.cwd(), all: false, base: 'origin/main', json: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = path.resolve(argv[++i] ?? '.');
    else if (arg === '--all') args.all = true;
    else if (arg === '--base') args.base = argv[++i] ?? args.base;
    else if (arg === '--json') args.json = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: advisory-test-reality.mjs [--root <dir>] [--all] [--base <ref>] [--json]');
      process.exit(0);
    } else {
      console.error(`[advisory:test-reality] unknown argument: ${arg}`);
      process.exit(1);
    }
  }
  return args;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function classify(line) {
  // `.not.toThrow()` asserts success, not a failure path.
  if (/\.not\.toThrow/.test(line)) return null;

  const toThrow = line.match(/\b(?:rejects\.)?toThrow\s*\(/);
  if (toThrow) {
    // Any argument — a matcher string/regex, a named error class, or a key —
    // is a discriminator. Only a bare `toThrow()` lacks one.
    const argument = line.match(/toThrow\s*\(([^)]*)/);
    const marker = argument ? argument[1].trim().length > 0 : false;
    return marker ? null : 'bare-toThrow';
  }

  // An inline `vi.fn()` / `jest.fn()` assertion has no named spy. For a
  // receiver variable, only generic names (fn/spy/mock) count as missing a
  // discriminator; `writeSpy`, `runner`, `emitter` etc. are named markers.
  if (/expect\s*\(\s*(?:vi|jest)\.fn\s*\(/.test(line)) return 'generic-no-call';
  const noCall = line.match(/expect\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)\.not\.toHaveBeenCalled(?:With|Times)?\s*\(/);
  if (noCall) {
    const receiver = (noCall[1].split('.').pop() ?? '');
    return /^(?:fn|spy|mock)$/i.test(receiver) ? 'generic-no-call' : null;
  }

  return null;
}

function scanFile(root, relPath, startLine = 1) {
  const abs = path.join(root, relPath);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch {
    return [];
  }
  const items = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const kind = classify(line);
    if (kind !== null) {
      items.push({ path: relPath, line: startLine + index, assertion: line.trim(), kind });
    }
  });
  return items;
}

function scanAll(root) {
  const files = git(root, ['ls-files']).split('\n').filter((file) => TEST_FILE.test(file));
  return files.flatMap((file) => scanFile(root, file));
}

function scanDiff(root, base) {
  const diff = git(root, ['diff', '--unified=0', '--diff-filter=AM', `${base}...HEAD`]);
  const items = [];
  let currentPath = null;
  let currentLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      currentPath = line.slice('+++ b/'.length);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? +(\d+)(?:,\d+)? @@/);
    if (hunk) {
      currentLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentPath && TEST_FILE.test(currentPath)) {
        const kind = classify(line.slice(1));
        if (kind !== null) {
          items.push({ path: currentPath, line: currentLine, assertion: line.slice(1).trim(), kind });
        }
      }
      currentLine += 1;
    } else if (line.startsWith(' ')) {
      currentLine += 1;
    }
  }
  return items;
}

function main() {
  const args = parseArgs(process.argv);
  let items;
  try {
    items = args.all ? scanAll(args.root) : scanDiff(args.root, args.base);
  } catch (error) {
    console.error(`[advisory:test-reality] cannot scan: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[advisory:test-reality] nextAction: run from a git checkout, or pass --all for the tracked test corpus`);
    process.exit(1);
  }

  const files = new Set(items.map((item) => item.path)).size;
  if (args.json) {
    console.log(JSON.stringify({ mode: args.all ? 'all' : 'diff', files, assertions: items.length, items }, null, 2));
    return;
  }

  console.log(
    `[advisory:test-reality] ${items.length} failure-path assertion(s) without a branch marker in ${files} file(s).`,
  );
  console.log('[advisory:test-reality] ADVISORY ONLY — never blocks CI. For each: feed a real production state and add a positive control.');
  for (const item of items) {
    console.log(`${item.path}:${item.line}  ${item.kind}  ${item.assertion}`);
  }
}

main();
