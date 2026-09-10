#!/usr/bin/env node
/**
 * Error Context Router — Error Experience v2
 *
 * Deterministic retrieval hint that surfaces relevant historical error
 * patterns (EP cards in ERROR_PATTERN_INDEX.md) for the current task:
 *
 *   - plan mode:  `node scripts/error-context.mjs --paths <p1,p2> [--signals <s1,s2>]`
 *     Pre-implementation routing from Survey-identified paths/concepts.
 *   - diff mode:  `node scripts/error-context.mjs --base origin/main`
 *     Post-implementation routing from the actual branch diff — committed
 *     (merge-base relative) PLUS staged AND unstaged working-tree changes,
 *     so an agent can route before its first commit.
 *   - JSON mode:   append `--json` for machine-readable output.
 *
 * Design constraints (SPEC "Error Experience v2"):
 *   - deterministic, no LLM, no state, no network;
 *   - path signals weigh more than diff-content signals (+2 vs +1);
 *   - every hit prints the specific matched signal (no opaque scores);
 *   - no match still tells the agent to manually review the Pattern Index;
 *   - crash / base-unavailability fail loud with reason + nextAction.
 *
 * Reuses resolveBaseRef + parseDiffHunks from runtime-contract-diff.js
 * (generic, unit-tested seams). Owns its own wider diff acquisition —
 * `getDiffHunks` there is TS-production-scoped and must not change.
 *
 * Runtime-contract rules observed: git output is untrusted string data
 * (rc-1); no `as`-style trust escape hatches; fail-loud on bad base (rc-9).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBaseRef, parseDiffHunks } from './runtime-contract-diff.js';

const TAG = '[error:context]';
const ROUTING_MARKER = 'error-pattern-routing';
const RECURRENCE_MARKER = 'recurrence-meta';
const MAX_GIT_BUFFER = 10 * 1024 * 1024;
const MAX_DIFF_HITS_PER_PATTERN = 50;

/** path signal hit weight — location is stronger evidence than text. */
const PATH_WEIGHT = 2;
/** diff/content signal hit weight. */
const SIGNAL_WEIGHT = 1;

/** Confidence thresholds — calibrated against the PR #1472 regression fixture
 * and docs-only negative controls (see scripts/__tests__/error-context.test.ts). */
const HIGH_THRESHOLD = 4;
const MEDIUM_THRESHOLD = 2;

const VALID_RISK = new Set(['high', 'medium', 'low']);
const VALID_ENFORCEMENT = new Set(['blocking', 'advisory', 'semantic', 'mixed']);

/**
 * @typedef {Object} PatternMeta
 * @property {string} id
 * @property {string} heading
 * @property {string} risk
 * @property {string[]} pathSignals
 * @property {string[]} diffSignals
 * @property {string[]} requiredEvidence
 * @property {string} enforcement
 */

/**
 * @typedef {Object} RecurrenceMeta
 * @property {string} date
 * @property {string} pattern
 * @property {string} invariant
 * @property {string} severity
 * @property {string} escaped
 * @property {string} caughtBy
 * @property {string} guard
 */

/**
 * @typedef {Object} PatternHit
 * @property {string} id
 * @property {'high'|'medium'|'low'} confidence
 * @property {{kind: 'path'|'diff'|'signal', path?: string, signal: string}[]} matches
 * @property {string[]} requiredEvidence
 * @property {string} enforcement
 * @property {number} score
 */

function isNonEmptyStringArray(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'string' && v.trim().length > 0)
  );
}

/**
 * Parse one HTML-comment JSON metadata block.
 *
 * @param {string} commentBody - content between <!-- and -->
 * @param {string} marker - expected first-line marker (routing / recurrence)
 * @returns {{ok: true, meta: Record<string, unknown>} | {ok: false, error: string}}
 */
function parseMetaComment(commentBody, marker) {
  const lines = commentBody.split(/\r?\n/);
  const firstNonEmpty = lines.find((l) => l.trim().length > 0);
  if (firstNonEmpty === undefined) {
    return { ok: false, error: 'empty comment' };
  }
  if (!firstNonEmpty.trim().startsWith(marker)) {
    return { ok: false, error: `missing ${marker} marker` };
  }
  const jsonText = lines.slice(lines.indexOf(firstNonEmpty) + 1).join('\n');
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'metadata is not a JSON object' };
  }
  return { ok: true, meta: parsed };
}

/**
 * Extract all `<!-- ... -->` comment bodies from a markdown document.
 * Non-greedy scan; tolerant of `\r\n` line endings.
 *
 * @param {string} markdown
 * @returns {string[]}
 */
function extractHtmlComments(markdown) {
  const comments = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    comments.push(m[1]);
  }
  return comments;
}

/**
 * Parse all pattern routing metadata from an ERROR_PATTERN_INDEX document.
 * Pure function — the primary test seam.
 *
 * Known limitation: a routing marker appearing in a non-pattern location
 * (e.g. this test script's own documentation) is not distinguishable from a
 * real card; validation of the `id`/EP format filters most of that noise, and
 * duplicate-ID validation in check:error-handbook guards the real file.
 *
 * @param {string} markdown
 * @returns {{patterns: PatternMeta[], errors: string[]}}
 */
export function parsePatternRouting(markdown) {
  const patterns = [];
  const errors = [];
  const seenIds = new Set();
  const headings = markdown.match(/^### (EP-\d{2}) .*$/gm) ?? [];

  const comments = extractHtmlComments(markdown);
  for (const body of comments) {
    const parsed = parseMetaComment(body, ROUTING_MARKER);
    if (!parsed.ok) {
      if (parsed.error.startsWith('missing')) continue; // unrelated comment
      errors.push(`routing metadata ${parsed.error}`);
      continue;
    }
    const meta = parsed.meta;
    const problems = [];
    if (typeof meta.id !== 'string' || !/^EP-\d{2}$/.test(meta.id)) {
      problems.push('id must match EP-NN');
    }
    if (!VALID_RISK.has(meta.risk)) {
      problems.push(`risk must be one of ${[...VALID_RISK].join('|')}`);
    }
    if (!VALID_ENFORCEMENT.has(meta.enforcement)) {
      problems.push(`enforcement must be one of ${[...VALID_ENFORCEMENT].join('|')}`);
    }
    if (!isNonEmptyStringArray(meta.pathSignals)) problems.push('pathSignals must be a non-empty string array');
    if (!isNonEmptyStringArray(meta.diffSignals)) problems.push('diffSignals must be a non-empty string array');
    if (!isNonEmptyStringArray(meta.requiredEvidence)) problems.push('requiredEvidence must be a non-empty string array');
    if (problems.length > 0) {
      errors.push(`${String(meta.id ?? '<unparsed>')} routing metadata invalid: ${problems.join('; ')}`);
      continue;
    }
    if (seenIds.has(meta.id)) {
      errors.push(`duplicate routing metadata for ${meta.id}`);
      continue;
    }
    seenIds.add(meta.id);
    if (!headings.some((h) => h.includes(`### ${meta.id} `) || h === `### ${meta.id}`)) {
      errors.push(`routing metadata id ${meta.id} has no matching pattern card heading`);
      continue;
    }
    patterns.push({
      id: meta.id,
      heading: (markdown.match(new RegExp(`^### ${meta.id} .*$`, 'm')) ?? ['', meta.id])[0],
      risk: meta.risk,
      pathSignals: meta.pathSignals,
      diffSignals: meta.diffSignals,
      requiredEvidence: meta.requiredEvidence,
      enforcement: meta.enforcement,
    });
  }

  // Every active card must carry routing metadata — a card without a block
  // would otherwise be silently invisible to routing (same fail-loud class
  // as a broken block). Mirrors error-handbook-meta.cjs.
  for (const heading of headings) {
    const id = heading.slice(4, 9);
    if (!seenIds.has(id)) {
      errors.push(`${id} pattern card has no routing metadata block`);
    }
  }

  return { patterns, errors };
}

/**
 * Strict YYYY-MM-DD calendar validation. `Date.parse` silently ROLLS OVER
 * impossible dates (2026-02-30 → 2026-03-02, 2025-02-29 → 2026-03-01), so a
 * regex + Date.parse gate admits them. Parse the components and require the
 * UTC round-trip to reproduce them exactly.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

/**
 * Parse all structured recurrence metadata from the handbook document.
 * Pure function.
 *
 * @param {string} markdown
 * @returns {{recurrences: RecurrenceMeta[], errors: string[]}}
 */
export function parseRecurrenceMeta(markdown) {
  const recurrences = [];
  const errors = [];

  for (const body of extractHtmlComments(markdown)) {
    const parsed = parseMetaComment(body, RECURRENCE_MARKER);
    if (!parsed.ok) {
      if (parsed.error.startsWith('missing')) continue;
      errors.push(`recurrence metadata ${parsed.error}`);
      continue;
    }
    const meta = parsed.meta;
    const problems = [];
    if (typeof meta.pattern !== 'string' || !/^EP-\d{2}$/.test(meta.pattern)) {
      problems.push('pattern must match EP-NN');
    }
    if (!isValidCalendarDate(meta.date)) {
      problems.push('date must be a valid YYYY-MM-DD');
    }
    if (typeof meta.invariant !== 'string' || meta.invariant.trim().length === 0) {
      problems.push('invariant must be a non-empty string');
    }
    if (typeof meta.severity !== 'string' || !/^P[0-3]$/.test(meta.severity)) {
      problems.push('severity must be P0..P3');
    }
    if (typeof meta.escaped !== 'string' || meta.escaped.trim().length === 0) {
      problems.push('escaped must be a non-empty string');
    }
    if (typeof meta.caughtBy !== 'string' || meta.caughtBy.trim().length === 0) {
      problems.push('caughtBy must be a non-empty string');
    }
    if (typeof meta.guard !== 'string' || meta.guard.trim().length === 0) {
      problems.push('guard must be a non-empty string');
    }
    if (problems.length > 0) {
      errors.push(`recurrence metadata invalid: ${problems.join('; ')}`);
      continue;
    }
    recurrences.push({
      date: meta.date,
      pattern: meta.pattern,
      invariant: meta.invariant,
      severity: meta.severity,
      escaped: meta.escaped,
      caughtBy: meta.caughtBy,
      guard: meta.guard,
    });
  }

  return { recurrences, errors };
}

/**
 * Match one file path against a pattern's path signals (substring, case-insensitive).
 *
 * @param {string} filePath
 * @param {string[]} pathSignals
 * @returns {string[]} matched signals
 */
function matchPathSignals(filePath, pathSignals) {
  const lower = filePath.toLowerCase();
  const matched = [];
  for (const signal of pathSignals) {
    if (lower.includes(signal.toLowerCase())) matched.push(signal);
  }
  return matched;
}

/**
 * Match text content against a pattern's diff signals (substring, case-sensitive —
 * code tokens like `process.exit` are case-sensitive in practice).
 *
 * @param {string} text
 * @param {string[]} diffSignals
 * @returns {string[]} matched signals
 */
function matchDiffSignals(text, diffSignals) {
  const matched = [];
  for (const signal of diffSignals) {
    if (text.includes(signal)) matched.push(signal);
  }
  return matched;
}

/**
 * Route a set of changed files + collected added-line text against all patterns.
 * Pure, deterministic — the core matching algorithm.
 *
 * @param {PatternMeta[]} patterns
 * @param {string[]} files - changed file paths
 * @param {string[]} texts - added-line texts (or plan-mode concept signals)
 * @returns {PatternHit[]}
 */
export function routeContext(patterns, files, texts) {
  /** @type {PatternHit[]} */
  const hits = [];

  for (const pattern of patterns) {
    /** @type {PatternHit['matches']} */
    const matches = [];
    let score = 0;

    for (const file of files) {
      for (const signal of matchPathSignals(file, pattern.pathSignals)) {
        matches.push({ kind: 'path', path: file, signal });
        score += PATH_WEIGHT;
      }
    }
    const joinedText = texts.join('\n');
    for (const signal of matchDiffSignals(joinedText, pattern.diffSignals)) {
      matches.push({ kind: 'diff', signal });
      score += SIGNAL_WEIGHT;
    }

    if (score <= 0) continue;
    const confidence = score >= HIGH_THRESHOLD ? 'high' : score >= MEDIUM_THRESHOLD ? 'medium' : 'low';
    hits.push({
      id: pattern.id,
      confidence,
      matches: matches.slice(0, MAX_DIFF_HITS_PER_PATTERN),
      requiredEvidence: pattern.requiredEvidence,
      enforcement: pattern.enforcement,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return hits;
}

/**
 * Run git and return trimmed stdout, or null on failure.
 *
 * @param {string[]} args
 * @param {string} [cwd] - repo to run git in (tests inject a temp repo)
 * @returns {string | null}
 */
function gitOutput(args, cwd = process.cwd()) {
  try {
    const out = execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_GIT_BUFFER, cwd });
    return typeof out === 'string' ? out : null;
  } catch {
    return null;
  }
}

/**
 * Merge parsed per-segment hunks into ONE entry per file.
 *
 * The router matches on file PATH (once per file) and line TEXT. A file
 * touched in committed AND staged AND unstaged segments would otherwise
 * appear as three FileHunks entries and inflate path-signal scores 3x.
 * Identical (lineNo, text) lines across segments are collapsed as pure
 * duplicates; distinct content at the same line number from different
 * segments is kept (the segments describe disjoint change ranges).
 *
 * @param {import('./runtime-contract-diff.js').FileHunks[][]} parsedSegments
 * @returns {import('./runtime-contract-diff.js').FileHunks[]}
 */
function mergeFileHunks(parsedSegments) {
  const byFile = new Map();
  for (const hunks of parsedSegments) {
    for (const hunk of hunks) {
      let entry = byFile.get(hunk.file);
      if (entry === undefined) {
        entry = { file: hunk.file, newLines: [] };
        byFile.set(hunk.file, entry);
      }
      const seen = new Set(entry.newLines.map((l) => `${l.lineNo}\u0000${l.text}`));
      for (const line of hunk.newLines) {
        const key = `${line.lineNo}\u0000${line.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          entry.newLines.push(line);
        }
      }
    }
  }
  return [...byFile.values()];
}

/**
 * Wide diff acquisition for the router: unlike runtime-contract's TS-only
 * scope, the router wants the FULL diff (docs, tests, scripts, configs) —
 * routing signals live in all of those. Covers every reviewable state:
 *
 *   1. committed — `<baseRef>` (e.g. `origin/main...HEAD`, merge-base relative)
 *   2. staged    — `--cached` (HEAD → index)
 *   3. unstaged  — plain (index → working tree)
 *
 * The three segments are disjoint by construction (each starts where the
 * previous one ends), so the same change is not counted twice; per-file
 * merging additionally guarantees one path match per file.
 *
 * Reuses parseDiffHunks for parsing.
 *
 * @param {string} baseRef - e.g. `origin/main...HEAD`
 * @param {string} [cwd] - repo to run git in (tests inject a temp repo)
 * @returns {{ok: true, hunks: import('./runtime-contract-diff.js').FileHunks[]} | {ok: false, reason: string, nextAction: string}}
 */
export function getRouterDiff(baseRef, cwd = process.cwd()) {
  const segments = [
    { label: `committed (${baseRef})`, args: ['diff', '--unified=0', '--no-color', baseRef] },
    { label: 'staged (--cached)', args: ['diff', '--unified=0', '--no-color', '--cached'] },
    { label: 'unstaged (working tree)', args: ['diff', '--unified=0', '--no-color'] },
  ];
  const parsedSegments = [];
  const failed = [];
  for (const segment of segments) {
    const out = gitOutput(segment.args, cwd);
    if (out === null) {
      failed.push(segment.label);
      continue;
    }
    parsedSegments.push(parseDiffHunks(out.trim()));
  }
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `git diff acquisition failed for: ${failed.join(', ')} (missing base ref, not a repo, or git error)`,
      nextAction: 'Run `git fetch origin` and verify the base ref exists (`git rev-parse --verify origin/main`), then rerun.',
    };
  }
  return { ok: true, hunks: mergeFileHunks(parsedSegments) };
}

/**
 * Load and parse the pattern index from a repo root.
 *
 * @param {string} repoRoot
 * @returns {{patterns: PatternMeta[], errors: string[]}}
 */
export function loadPatterns(repoRoot) {
  const indexPath = path.join(repoRoot, 'docs', 'process', 'error-management', 'ERROR_PATTERN_INDEX.md');
  let markdown;
  try {
    markdown = readFileSync(indexPath, 'utf8');
  } catch (err) {
    return {
      patterns: [],
      errors: [`cannot read ERROR_PATTERN_INDEX.md: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return parsePatternRouting(markdown);
}

/**
 * Aggregate router inputs from parsed diff hunks.
 *
 * @param {import('./runtime-contract-diff.js').FileHunks[]} hunks
 * @returns {{files: string[], texts: string[]}}
 */
export function hunksToInputs(hunks) {
  const files = [];
  const texts = [];
  for (const hunk of hunks) {
    files.push(hunk.file);
    for (const line of hunk.newLines) texts.push(line.text);
  }
  return { files, texts };
}

/**
 * Render human-readable output.
 *
 * @param {PatternHit[]} hits
 * @param {string} mode - description of the routing basis (plan inputs / base ref)
 * @returns {string}
 */
export function renderText(hits, mode) {
  const lines = [];
  lines.push('Error Context');
  lines.push('');
  lines.push(`Basis: ${mode}`);
  lines.push('');

  if (hits.length === 0) {
    lines.push('No automatic routing match; manual Pattern Index review is still required.');
    lines.push('Read docs/process/error-management/ERROR_PATTERN_INDEX.md before implementing.');
    return lines.join('\n');
  }

  lines.push('Triggered patterns:');
  lines.push('');
  for (const hit of hits) {
    lines.push(`${hit.id} — ${hit.confidence.toUpperCase()} (score ${hit.score})`);
    lines.push('Matched:');
    for (const m of hit.matches) {
      lines.push(`- ${m.kind}: ${m.path ? `${m.path} ← ${m.signal}` : m.signal}`);
    }
    lines.push('Required evidence:');
    hit.requiredEvidence.forEach((ev, i) => lines.push(`${i + 1}. ${ev}`));
    lines.push('');
  }
  lines.push('Router supplements semantic selection; it does not replace ERROR_PATTERN_INDEX.md.');
  return lines.join('\n');
}

/**
 * Render JSON output (same semantics, machine-readable).
 *
 * @param {PatternHit[]} hits
 * @param {string} mode
 * @returns {string}
 */
export function renderJson(hits, mode) {
  return JSON.stringify(
    {
      basis: mode,
      patterns: hits.map((h) => ({
        id: h.id,
        confidence: h.confidence,
        score: h.score,
        matches: h.matches,
        requiredEvidence: h.requiredEvidence,
        enforcement: h.enforcement,
      })),
      note: hits.length === 0
        ? 'No automatic routing match; manual Pattern Index review is still required.'
        : 'Router supplements semantic selection; it does not replace ERROR_PATTERN_INDEX.md.',
    },
    null,
    2,
  );
}

/**
 * Parse CLI arguments. Exported for parser-level testing (cli-7).
 *
 * @param {string[]} argv
 * @returns {{ok: true, mode: 'plan'|'diff', paths: string[], signals: string[], base: string, json: boolean} | {ok: false, error: string, nextAction: string}}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|string[]|boolean>} */
  const opts = { paths: [], signals: [], base: '', json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--paths') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0) return { ok: false, error: '--paths requires a comma-separated list', nextAction: 'Example: --paths packages/pd-cli/src/index.ts,scripts/foo.js' };
      opts.paths = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      i += 1;
    } else if (arg === '--signals') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0) return { ok: false, error: '--signals requires a comma-separated list', nextAction: 'Example: --signals preload,safeStorage' };
      opts.signals = v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
      i += 1;
    } else if (arg === '--base') {
      const v = argv[i + 1];
      if (typeof v !== 'string' || v.length === 0) return { ok: false, error: '--base requires a ref', nextAction: 'Example: --base origin/main' };
      opts.base = v;
      i += 1;
    } else {
      return { ok: false, error: `unknown argument: ${arg}`, nextAction: 'Usage: error-context [--paths a,b] [--signals x,y] [--base <ref>] [--json]' };
    }
  }

  const hasPaths = Array.isArray(opts.paths) && opts.paths.length > 0;
  const hasBase = typeof opts.base === 'string' && opts.base.length > 0;
  if (hasPaths && hasBase) {
    return { ok: false, error: '--paths (plan mode) and --base (diff mode) are mutually exclusive', nextAction: 'Pass --paths for pre-implementation routing, or --base for post-diff routing.' };
  }
  if (!hasPaths && !hasBase) {
    // Default: diff mode against the canonical base, matching SPEC default.
    opts.base = 'origin/main';
  }
  const mode = hasPaths ? 'plan' : 'diff';
  return {
    ok: true,
    mode,
    paths: opts.paths,
    signals: opts.signals,
    base: opts.base,
    json: opts.json,
  };
}

/**
 * Main entry point. Dependency-injectable like scan() in check-runtime-contract.js.
 *
 * @param {Object} [inject]
 * @param {string[]} [inject.argv]
 * @param {string} [inject.repoRoot]
 * @param {() => {patterns: PatternMeta[], errors: string[]}} [inject.loadPatterns]
 * @param {(ref: string) => ReturnType<typeof getRouterDiff>} [inject.getDiff]
 * @param {() => import('./runtime-contract-diff.js').ResolvedBase} [inject.resolveBase]
 * @returns {{exitCode: number, stdout: string}}
 */
export function run(inject) {
  const argv = inject?.argv ?? process.argv.slice(2);
  const repoRoot = inject?.repoRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const load = inject?.loadPatterns ?? (() => loadPatterns(repoRoot));
  const getDiff = inject?.getDiff ?? getRouterDiff;
  const resolveBase = inject?.resolveBase ?? resolveBaseRef;

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    return { exitCode: 1, stdout: `${TAG} FAILED: ${parsed.error}\n${TAG} Next action: ${parsed.nextAction}` };
  }

  const { patterns, errors: patternErrors } = load();
  // Fail loud on ANY metadata error — partial success (12 valid cards + 1
  // broken) would silently drop one pattern from routing, which is exactly
  // the invisible-loss class this tool exists to prevent.
  if (patternErrors.length > 0) {
    return {
      exitCode: 1,
      stdout: `${TAG} FAILED: pattern routing metadata could not be parsed:\n${patternErrors.map((e) => `${TAG}   ${e}`).join('\n')}\n${TAG} Next action: fix docs/process/error-management/ERROR_PATTERN_INDEX.md routing blocks, then rerun.`,
    };
  }

  if (parsed.mode === 'plan') {
    const files = parsed.paths;
    const texts = parsed.signals;
    const hits = routeContext(patterns, files, texts);
    const basis = `plan inputs (paths: ${files.length}, signals: ${texts.length})`;
    return { exitCode: 0, stdout: parsed.json ? renderJson(hits, basis) : renderText(hits, basis) };
  }

  // diff mode — resolve the base like the runtime-contract scanner, but fail
  // loud with reason + nextAction when nothing usable exists (rc-9).
  const base = resolveBase(parsed.base ? [parsed.base] : undefined);
  if (base.kind === 'none') {
    return {
      exitCode: 1,
      stdout: `${TAG} FAILED: no base ref available (${base.note}).\n${TAG} Next action: run \`git fetch origin\` or pass an explicit --base <ref>, or use plan mode (--paths) for pre-implementation routing.`,
    };
  }
  const diffResult = getDiff(base.ref);
  if (!diffResult.ok) {
    return {
      exitCode: 1,
      stdout: `${TAG} FAILED: ${diffResult.reason}\n${TAG} Next action: ${diffResult.nextAction}`,
    };
  }

  const { files, texts } = hunksToInputs(diffResult.hunks);
  const hits = routeContext(patterns, files, texts);
  const basis = `diff ${base.ref} (committed + staged + unstaged)${base.note ? ` (${base.note})` : ''}`;
  return { exitCode: 0, stdout: parsed.json ? renderJson(hits, basis) : renderText(hits, basis) };
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('error-context.mjs');
if (invokedDirectly) {
  const { exitCode, stdout } = run();
  if (exitCode === 0) {
    console.log(stdout);
  } else {
    console.error(stdout);
    process.exit(1);
  }
}
