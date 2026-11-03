#!/usr/bin/env node
// PRI-965 / EP-09 — ADVISORY ONLY.
//
// Reminds authors that a failure-path test must (a) feed a state production
// can really produce and (b) carry a positive control that turns red when the
// branch is not taken. Findings NEVER change the exit code; argument and scan
// errors do (fail-loud), so "advisory" cannot hide a broken invocation.
//
// Usage:
//   node scripts/dev/advisory-test-reality.mjs [--root <dir>] [--all]
//     [--base <ref>] [--json]
//
// Default mode scans the diff <base>...HEAD for ADDED lines in test files.
// --all scans every git-tracked test file (false-positive measurement).
//
// Generic error shapes are deliberately treated as NO discriminator:
// `new Error()`, `new Error`, `Error`, and `/error/i` carry no branch identity.
// Do not "simplify" them into markers — that would silently disable the
// `toThrow(new Error())` reminder.

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
      console.error('[advisory:test-reality] nextAction: run --help for the supported arguments');
      process.exit(1);
    }
  }
  return args;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Minimal string/comment state machine: returns a copy of the line with
 * string contents and comments replaced by spaces, while keeping code
 * punctuation. It is deliberately not a full parser; it exists so fixture
 * strings and comments cannot masquerade as assertions.
 */
function codeOnly(line, state) {
  let out = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (state.blockComment) {
      if (ch === '*' && line[i + 1] === '/') {
        state.blockComment = false;
        i += 1;
        out += '  '; // consume TWO characters, keep the column offset intact
        continue;
      }
      out += ' ';
      continue;
    }
    if (state.quote) {
      if (ch === '\\') {
        out += '  ';
        i += 1;
        continue;
      }
      if (ch === state.quote) state.quote = '';
      out += ' ';
      continue;
    }
    if (ch === '/' && line[i + 1] === '*') {
      state.blockComment = true;
      i += 1;
      out += '  ';
      continue;
    }
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '"' || ch === "'" || ch === '`') {
      state.quote = ch;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

function collectArgument(lines, lineIndex, openIndex) {
  let depth = 1;
  let arg = '';
  let started = false;
  for (let li = lineIndex; li < lines.length && li < lineIndex + 25; li += 1) {
    const line = lines[li];
    const from = li === lineIndex ? openIndex + 1 : 0;
    let quote = '';
    for (let ci = from; ci < line.length; ci += 1) {
      const ch = line[ci];
      if (quote) {
        arg += ch;
        if (ch === '\\') {
          if (ci + 1 < line.length) {
            arg += line[ci + 1];
            ci += 1;
          }
          continue;
        }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        arg += ch;
        started = true;
        continue;
      }
      if (ch === '(') {
        depth += 1;
        if (started) arg += ch;
        continue;
      }
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) return arg.trim();
        if (started) arg += ch;
        continue;
      }
      if (started || !/\s/.test(ch)) {
        arg += ch;
        started = true;
      }
    }
    arg += ' ';
  }
  return arg.trim();
}

function isDiscriminator(argument) {
  const value = argument.trim();
  if (value.length === 0) return false;
  // A bare generic error carries no branch identity.
  if (/^new\s+Error\s*\(\s*\)\s*$/i.test(value)) return false;
  if (/^new\s+Error\s*$/i.test(value)) return false;
  if (/^Error\s*$/i.test(value)) return false;
  if (/^\/error\/[gimsuy]*$/i.test(value)) return false;
  return true;
}

function findAssertions(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  const state = { blockComment: false, quote: '' };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const code = codeOnly(raw, state);
    // A line can contain a real assertion AND then open a block comment; the
    // state flag alone must not drop it. Only a fully comment/string line is
    // skipped.
    if (!code.trim()) continue;
    if (/\.not\.toThrow\s*\(/.test(code)) continue;

    const toThrow = code.search(/\b(?:rejects\.)?toThrow\s*\(/);
    if (toThrow >= 0) {
      const open = code.indexOf('(', code.indexOf('toThrow'));
      const argument = collectArgument(lines, index, open);
      if (!isDiscriminator(argument)) {
        items.push({ path: null, line: index + 1, assertion: raw.trim(), kind: 'bare-toThrow' });
      }
      continue;
    }

    const inlineNoCall = /expect\s*\(\s*(?:vi|jest)\.fn(?:<[^>]*>)?\s*\([^)]*\)\s*\)\s*\.not\.toHaveBeenCalled\s*\(\s*\)/.test(code);
    if (inlineNoCall) {
      items.push({ path: null, line: index + 1, assertion: raw.trim(), kind: 'generic-no-call' });
      continue;
    }

    const noCall = code.match(/expect\s*\(\s*([A-Za-z_$][\w$.]*)\s*\)\s*\.not\.toHaveBeenCalled\s*\(\s*\)/);
    if (noCall) {
      const receiver = noCall[1].split('.').pop() ?? '';
      if (/^(?:fn|spy|mock)$/i.test(receiver)) {
        items.push({ path: null, line: index + 1, assertion: raw.trim(), kind: 'generic-no-call' });
      }
    }
  }

  return items;
}

function scanFile(root, relPath) {
  const text = fs.readFileSync(path.join(root, relPath), 'utf8');
  return findAssertions(text).map((item) => ({ ...item, path: relPath }));
}

function scanAll(root) {
  const files = git(root, ['ls-files']).split('\n').filter((file) => TEST_FILE.test(file));
  return files.flatMap((file) => scanFile(root, file));
}

function scanDiff(root, base) {
  const diff = git(root, ['diff', '--unified=0', '--diff-filter=AM', `${base}...HEAD`]);
  const added = new Map();
  let file = null;
  let nextLine = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ b/')) {
      file = line.slice('+++ b/'.length);
      if (TEST_FILE.test(file)) added.set(file, new Set());
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      nextLine = Number(hunk[1]);
      continue;
    }
    if (file && added.has(file) && line.startsWith('+') && !line.startsWith('+++')) {
      added.get(file).add(nextLine);
      nextLine += 1;
    } else if (file && line.startsWith(' ')) {
      nextLine += 1;
    }
  }

  const items = [];
  for (const [relPath, lines] of added) {
    for (const item of scanFile(root, relPath)) {
      if (lines.has(item.line)) items.push(item);
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
    console.error('[advisory:test-reality] nextAction: run from a git checkout, or pass --all for the tracked test corpus');
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
  console.log('[advisory:test-reality] ADVISORY ONLY — findings never fail; argument/scan errors exit non-zero.');
  for (const item of items) {
    console.log(`${item.path}:${item.line}  ${item.kind}  ${item.assertion}`);
  }
}

main();
