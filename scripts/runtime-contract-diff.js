/**
 * Runtime Contract Diff — PRI-441 / Issue #996
 *
 * Git diff acquisition, hunk parsing, and lightweight trust-origin data-flow
 * analysis for the incremental Runtime Contract scanner.
 *
 * All git I/O is wrapped so failures degrade to a structured reason rather than
 * a thrown exception (Runtime Contract Rule 9 — graceful degradation with reason).
 * The pure hunk-parsing function is split out so it can be unit-tested without
 * a git repo.
 *
 * Runtime Contract Rule 1/2: every field returned by git is treated as untrusted
 * string data — no `as` casts, only typeof / Array.isArray / String() guards.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * @typedef {Object} NewLine
 * @property {string} text - source text of the new line (no leading `+`)
 * @property {number} lineNo - 1-based line number in the new file
 */

/**
 * @typedef {Object} FileHunks
 * @property {string} file - path of the changed file (git's `b/` path)
 * @property {NewLine[]} newLines - only the added/modified lines
 */

/** Scan target: only TypeScript sources (not scripts/, not tests). */
const TS_INCLUDE = ['*.ts'];
/** Exclude test files and the scripts tree (avoid self-scan recursion). */
const SCAN_EXCLUDES = ['*.test.ts', '*.spec.ts', 'scripts/**'];

/**
 * Probe candidates in priority order. First rev that verifies wins.
 * CI (with fetch-depth: 0) provides `origin/main`; local clones may only have
 * `main`; detached/feature-only clones fall back to `HEAD~1`.
 */
const BASE_CANDIDATES = ['origin/main', 'main', 'HEAD~1'];

/** Max git output we accept (10 MB) — guards against runaway diffs. */
const MAX_GIT_BUFFER = 10 * 1024 * 1024;

/**
 * @typedef {Object} ResolvedBase
 * @property {string} ref - the ref string to pass to `git diff <ref>...HEAD`
 * @property {string} kind - 'origin/main' | 'main' | 'HEAD~1' | 'none'
 * @property {string} [note] - explanatory note for non-canonical bases
 */

/**
 * Verify that a git ref exists in the current repo.
 * @param {string} ref
 * @returns {boolean}
 */
function refExists(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve which base ref to diff against.
 *
 * Priority: origin/main → main → HEAD~1. If none verifies, returns kind 'none'
 * so the caller can emit a WARNING + reason and exit 0 (do not block on a
 * fresh clone that has no main history — Runtime Contract Rule 9).
 *
 * @param {string[]} [candidates] - override list (for testing)
 * @param {(ref: string) => boolean} [existsFn] - override ref-existence check
 * @returns {ResolvedBase}
 */
export function resolveBaseRef(candidates, existsFn) {
  const list = Array.isArray(candidates) && candidates.length > 0 ? candidates : BASE_CANDIDATES;
  const probe = typeof existsFn === 'function' ? existsFn : refExists;

  for (const ref of list) {
    if (probe(ref)) {
      let kind;
      let note;
      if (ref === 'origin/main') {
        kind = 'origin/main';
      } else if (ref === 'main') {
        kind = 'main';
        note = "origin/main not present — using local 'main' as base";
      } else {
        kind = 'HEAD~1';
        note = "no 'main' branch found — falling back to HEAD~1 (only the last commit is scanned)";
      }
      return { ref: `${ref}...HEAD`, kind, note };
    }
  }
  return {
    ref: '',
    kind: 'none',
    note: "no base ref available (origin/main, main, HEAD~1 all missing) — likely a fresh shallow clone",
  };
}

/**
 * Run git and return its stdout as a trimmed string, or null on failure.
 *
 * Runtime Contract Rule 1: stdout is untrusted; the caller must validate shape.
 *
 * @param {string[]} args
 * @returns {string | null}
 */
function gitOutput(args) {
  try {
    const out = execFileSync('git', args, {
      encoding: 'utf8',
      maxBuffer: MAX_GIT_BUFFER,
    });
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Parse unified-diff output into per-file added/modified lines.
 *
 * Pure function — accepts the raw diff string, no git. This is the testable
 * seam: the caller can feed a fixture diff string and assert on the parsed
 * structure.
 *
 * Recognises:
 *   - `diff --git a/x b/x` headers (resets current file)
 *   - `+++ b/x` / `+++ /dev/null` lines (canonical new-file path)
 *   - `@@ -a,b +c,d @@` hunk headers (resets the running new-line counter to c)
 *   - `+...` added lines (collected, with the running new-line number)
 *   - ` ` context lines and `-` removed lines (advance/track line counters but
 *     are NOT collected — only new lines matter)
 *   - `\ No newline at end of file` markers (ignored)
 *
 * Robustness: if a `+`/` `-`/context line appears before any hunk header, it is
 * skipped (malformed diff). Binary diffs (contain `Binary files ... differ`) are
 * skipped entirely.
 *
 * @param {string} diffText
 * @returns {FileHunks[]}
 */
export function parseDiffHunks(diffText) {
  if (typeof diffText !== 'string' || diffText.length === 0) return [];

  const result = [];
  /** @type {FileHunks | null} */
  let current = null;
  let newLineNo = 0;
  let sawHunkForCurrent = false;
  let binary = false;

  const lines = diffText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('diff --git')) {
      // Flush previous file.
      if (current && current.newLines.length > 0) result.push(current);
      current = null;
      binary = false;
      sawHunkForCurrent = false;
      continue;
    }

    if (line.startsWith('Binary files')) {
      binary = true;
      continue;
    }

    // `+++ b/path` gives the canonical new-file path. Prefer it over the
    // `diff --git` header because it survives rename/copy edge cases.
    if (line.startsWith('+++ ')) {
      const rest = line.slice(4);
      if (rest === '/dev/null') {
        // Deleted file — no new lines to scan.
        if (current && current.newLines.length > 0) result.push(current);
        current = null;
        sawHunkForCurrent = false;
        continue;
      }
      // Strip the `b/` prefix if present.
      const filePath = rest.startsWith('b/') ? rest.slice(2) : rest;
      current = { file: filePath, newLines: [] };
      sawHunkForCurrent = false;
      continue;
    }

    if (!current || binary) continue;

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunkMatch) {
      newLineNo = Number.parseInt(hunkMatch[1], 10);
      sawHunkForCurrent = true;
      continue;
    }

    if (!sawHunkForCurrent) continue; // ignore diff metadata lines before hunk

    if (line.startsWith('+')) {
      current.newLines.push({ text: line.slice(1), lineNo: newLineNo });
      newLineNo += 1;
    } else if (line.startsWith('-')) {
      // Removed line — does not advance the new-file counter.
    } else if (line.startsWith('\\')) {
      // `\ No newline at end of file` marker — ignore.
    } else {
      // Context line (leading space) or empty line — advances new counter.
      newLineNo += 1;
    }
  }

  if (current && current.newLines.length > 0) result.push(current);
  return result;
}

/**
 * Get the diff hunks for the current branch vs the resolved base.
 *
 * Uses `--unified=0` to minimize noise (we only need added-line text + numbers).
 * Restricts to `.ts` files and excludes tests / scripts / fixtures.
 *
 * @param {string} baseRef - e.g. `origin/main...HEAD`
 * @returns {FileHunks[]}
 */
export function getDiffHunks(baseRef) {
  if (typeof baseRef !== 'string' || baseRef.length === 0) return [];

  const args = ['diff', '--unified=0', '--no-color', baseRef];
  for (const pat of TS_INCLUDE) args.push(pat);
  for (const ex of SCAN_EXCLUDES) {
    args.push(`:!${ex}`);
  }

  const out = gitOutput(args);
  if (out === null) return [];
  return parseDiffHunks(out.trim());
}

/**
 * Build a TrustContext for a file by scanning its full current content and
 * recording every identifier whose runtime value originates from an untrusted
 * source. Lightweight: line-by-line regex, no real AST.
 *
 * Recognised untrusted origins:
 *   - `const X = JSON.parse(...)` / `let X = JSON.parse(...)`
 *   - `const X = fs.readFile(...)` / `readFileSync` / `fsPromises.readFile`
 *   - `const X = await fetch(...)`
 *   - `const X = await exec(...)` / `execSync` / `execFile`
 *   - `const X = await db.all(...)` / `.get(...)` / `.query(...)` / `.raw(...)`
 *   - destructuring: `const { a, b } = JSON.parse(...)` marks both a and b
 *   - multi-declaration: `const a = 1, b = JSON.parse(x)` marks only b
 *   - typed const: `const x: Foo = JSON.parse(...)` marks x, not Foo
 *
 * Known limitations (precision/recall trade-off, documented for honesty):
 *   - `JSON['parse']` and aliased `const parse = JSON.parse` are NOT tracked
 *     (rare in this codebase; follow-up if it becomes a real bypass vector).
 *   - Reassignment without declaration (`let x; x = JSON.parse(...)`) is NOT
 *     tracked — only `const/let/var X = ...` forms are.
 *
 * @param {string[]} fileLines - full file content, one entry per line
 * @returns {{ untrustedVars: Set<string> }}
 */
export function buildTrustContext(fileLines) {
  const untrustedVars = new Set();
  if (!Array.isArray(fileLines)) return { untrustedVars };

  // Identifiers that begin an untrusted call: JSON.parse, fs reads, fetch, exec.
  const inlineUntrustedCall = /\b(?:JSON\.parse|readFileSync|readFile|fetch|execSync|execFile)\s*\(/;
  // Trailing method call that yields DB rows: `.all(...)` / `.get(...)` etc.
  // NOTE: `.map` / `.each` / `.filter` are intentionally NOT included — they
  // are Array prototype methods, not DB query methods, and including them
  // caused false positives (e.g. `const items = list.map(...)` marking `items`
  // as untrusted). Only include methods that are unambiguous DB/IO yields.
  const dbMethodCall = /\.(?:all|get|query|raw)\s*\(/;

  for (const line of fileLines) {
    if (typeof line !== 'string') continue;

    // Only declarations (`const` / `let` / `var`) introduce a new binding.
    // We split on top-level commas to support multi-declaration
    // (`const a = 1, b = JSON.parse(x)`). A naive non-greedy regex stops at
    // the first `=` and misses `b`, so we parse the RHS-bound pairs manually.
    const declPrefix = /\b(?:const|let|var)\s+/.exec(line);
    if (!declPrefix) continue;
    const afterKeyword = line.slice(declPrefix.index + declPrefix[0].length);

    // Split into `binder = rhs` pairs on commas that are at paren/bracket
    // depth 0 and not inside a string. This correctly handles
    // `const { a, b } = JSON.parse(x)` (one pair) and
    // `const a = f(1, 2), b = JSON.parse(x)` (two pairs).
    const pairs = splitTopLevelCommas(afterKeyword);

    for (const pair of pairs) {
      const eqMatch = /^([^=]*?)=\s*(.+)$/.exec(pair);
      if (!eqMatch) continue;
      const lhs = eqMatch[1];
      const rhs = eqMatch[2];

      const isUntrustedRhs =
        inlineUntrustedCall.test(rhs) || dbMethodCall.test(rhs);
      if (!isUntrustedRhs) continue;

      // Collect every identifier introduced on the LHS, EXCLUDING type
      // annotations: `const x: Foo = ...` should mark `x` only, not `Foo`.
      const lhsNoType = lhs.split(':')[0];
      const identifiers = lhsNoType.match(/[A-Za-z_$][\w$]*/g);
      if (!identifiers) continue;
      for (const id of identifiers) untrustedVars.add(id);
    }
  }

  return { untrustedVars };
}

/**
 * Split a declaration body on top-level commas (depth 0, outside strings).
 *
 * `const { a, b } = JSON.parse(x), c = 1` →
 *   [ '{ a, b } = JSON.parse(x)', ' c = 1' ]
 *
 * Handles nested `{}`/`[]`/`()` so commas inside destructuring patterns or
 * call arguments do not split prematurely. Also tracks `<>` (TS generics) so
 * `const x: Record<string, unknown> = ...` is not split on the type-arg comma.
 *
 * Caveat: `<>` are also less-than/greater-than operators. Tracking them as a
 * depth group can mis-parse `if (a < b, c)` — but this function only ever
 * receives declaration bodies (`const/let/var <body>`), where `<` at the start
 * of a type annotation position is generics, and a comparison `<` inside an
 * expression RHS is rare and would at most over-split (false negative, not a
 * false positive). Acceptable for a heuristic trust-context builder.
 *
 * @param {string} text
 * @returns {string[]}
 */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let angleDepth = 0;
  let inSingle = false;
  let inDouble = false;
  let inTemplate = false;
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    const next = text[i + 1];
    if (ch === "'" && !inDouble && !inTemplate && prev !== '\\') inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inTemplate && prev !== '\\') inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble && prev !== '\\') inTemplate = !inTemplate;
    if (!inSingle && !inDouble && !inTemplate) {
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      else if (ch === '<') angleDepth += 1;
      else if (ch === '>' && angleDepth > 0) angleDepth -= 1;
      else if (ch === ',' && depth === 0 && angleDepth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

/**
 * Read a file's current content as lines. Returns [] on any I/O failure so the
 * caller degrades to "no trust context" (i.e. does not flag identifier-based
 * violations — inline untrusted calls on the new line still get flagged).
 *
 * @param {string} filePath
 * @returns {string[]}
 */
export function readFileLines(filePath) {
  try {
    const content = readFileSync(filePath, { encoding: 'utf8' });
    if (typeof content !== 'string') return [];
    return content.split(/\r?\n/);
  } catch {
    return [];
  }
}
