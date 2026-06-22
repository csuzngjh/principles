#!/usr/bin/env node
/**
 * Incremental Runtime Contract Scanner — PRI-441 / Issue #996
 *
 * Checks only the lines added/modified in the current PR diff against
 * `origin/main...HEAD` (with fallbacks), and returns a non-zero exit code when
 * new violations of ERR-001 / ERR-005 / ERR-013 are introduced.
 *
 * Historical (pre-existing) code is NOT blocked — this is the key fix for the
 * dropped full-repo scanner from PR #991, which produced ~1171 warnings and
 * masked new violations.
 *
 * Exemptions (line-scoped, like eslint-disable-next-line):
 *   // runtime-contract-exempt: ERR-XXX <non-empty reason>
 *
 * Env:
 *   PD_RUNTIME_CONTRACT_SCAN=0   skip the scanner (escape hatch for emergency releases)
 *
 * Output convention matches scripts/check-error-handbook.cjs:
 *   [check:runtime-contract] <file>:<line> ERR-XXX: <title>
 *   [check:runtime-contract]   Reason: <why>
 *   [check:runtime-contract]   Next action: <fix hint>
 *
 * Runtime Contract Rules:
 *   Rule 2 — no `as` bypass: scanner validates git output with typeof only.
 *   Rule 9 — graceful degradation: base-ref failure emits reason + next action.
 *
 * CLI Gate Rule 2 — process.exit(...) is immediately followed by return.
 */

import {
  TAG,
  RULES,
  checkLine,
  parseExemption,
} from './runtime-contract-rules.js';
import {
  resolveBaseRef,
  getDiffHunks,
  buildTrustContext,
  readFileLines,
} from './runtime-contract-diff.js';

/**
 * @typedef {import('./runtime-contract-rules.js').Violation} Violation
 */

/**
 * @typedef {Object} Finding
 * @property {string} file
 * @property {number} line
 * @property {string} ruleId
 * @property {string} snippet
 * @property {string} reason
 * @property {string} nextAction
 */

const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));

/**
 * Run the scanner end-to-end and return the findings. Pure-ish (calls git + fs
 * via the imported diff module), but does not print or exit. Tests can stub the
 * diff module to drive specific scenarios.
 *
 * @param {Object} [inject] - dependency injection seam for testing
 * @param {() => import('./runtime-contract-diff.js').ResolvedBase} [inject.resolveBase]
 * @param {(ref: string) => import('./runtime-contract-diff.js').FileHunks[]} [inject.getHunks]
 * @param {(path: string) => string[]} [inject.readLines]
 * @returns {{ findings: Finding[], base: import('./runtime-contract-diff.js').ResolvedBase }}
 */
export function scan(inject) {
  const resolveBase = (inject && inject.resolveBase) || resolveBaseRef;
  const getHunks = (inject && inject.getHunks) || getDiffHunks;
  const readLines = (inject && inject.readLines) || readFileLines;

  const base = resolveBase();
  if (base.kind === 'none') {
    return { findings: [], base };
  }

  const hunks = getHunks(base.ref);
  /** @type {Finding[]} */
  const findings = [];

  for (const hunk of hunks) {
    // Trust context needs the full current file (not just the diff) because
    // the untrusted source may be declared many lines above the violating use.
    const fileLines = readLines(hunk.file);
    const ctx = buildTrustContext(fileLines);

    for (const { text, lineNo } of hunk.newLines) {
      // A malformed exemption comment on ANY line (clean or violating) is its
      // own defect — the developer thinks they exempted something but did not.
      const malformedExemption = checkMalformedExemption(text);
      if (malformedExemption) findings.push(malformedExemption(hunk.file, lineNo, text));

      const violation = checkLine(text, ctx);
      if (!violation) continue;

      // Check exemption: same line or the previous NEW line in the diff.
      // Malformed exemptions (above) do NOT suppress the violation.
      if (isExempted(violation.ruleId, text, lineNo, hunk.newLines)) continue;

      findings.push(buildFinding(hunk.file, lineNo, violation, text));
    }
  }

  return { findings, base };
}

/**
 * True if the line carries a malformed exemption comment (marker present but
 * ERR ID / reason missing). Returns a thunk that builds the Finding so the
 * caller controls file/line bookkeeping.
 *
 * @param {string} line
 * @returns {((file: string, lineNo: number, text: string) => Finding) | null}
 */
function checkMalformedExemption(line) {
  const parsed = parseExemption(line);
  if (parsed !== 'MALFORMED') return null;
  return (file, lineNo, text) =>
    buildFindingWith(
      file,
      lineNo,
      'ERR-EXEMPTION',
      text,
      'Exemption comment is malformed — missing ERR ID or non-empty reason',
      'Use: // runtime-contract-exempt: ERR-XXX <reason>',
    );
}

/**
 * Decide whether a violation on `lineNo` is exempted by a valid exemption
 * comment on the same line or on the immediately preceding NEW line of the
 * same hunk. Matches eslint-disable-next-line semantics.
 *
 * @param {string} ruleId
 * @param {string} lineText
 * @param {number} lineNo
 * @param {import('./runtime-contract-diff.js').NewLine[]} newLines
 * @returns {boolean}
 */
function isExempted(ruleId, lineText, lineNo, newLines) {
  // Same-line exemption.
  const same = parseExemption(lineText);
  if (same && typeof same === 'object' && same.errId === ruleId) return true;

  // Previous NEW line in this hunk.
  const idx = newLines.findIndex((nl) => nl.lineNo === lineNo);
  if (idx > 0) {
    const prev = newLines[idx - 1];
    // `eslint-disable-next-line` semantics: the comment must be the line
    // immediately above the violation in the new file.
    if (prev.lineNo === lineNo - 1) {
      const prevParsed = parseExemption(prev.text);
      if (prevParsed && typeof prevParsed === 'object' && prevParsed.errId === ruleId) {
        return true;
      }
    }
  }
  return false;
}

/**
 * @param {string} file
 * @param {number} line
 * @param {Violation} violation
 * @param {string} snippet
 * @returns {Finding}
 */
function buildFinding(file, line, violation, snippet) {
  const rule = RULES_BY_ID.get(violation.ruleId);
  const title = rule ? rule.title : violation.ruleId;
  const nextAction = rule ? rule.autofix : 'See ERROR_PATTERN_INDEX.md';
  return buildFindingWith(file, line, violation.ruleId, snippet, title, nextAction);
}

/**
 * @param {string} file
 * @param {number} line
 * @param {string} ruleId
 * @param {string} snippet
 * @param {string} reason
 * @param {string} nextAction
 * @returns {Finding}
 */
function buildFindingWith(file, line, ruleId, snippet, reason, nextAction) {
  return {
    file,
    line,
    ruleId,
    snippet: snippet.trim(),
    reason,
    nextAction,
  };
}

/**
 * Emit findings to stderr and exit non-zero (CLI Gate Rule 2: exit then return).
 *
 * @param {Finding[]} findings
 * @param {import('./runtime-contract-diff.js').ResolvedBase} base
 */
function reportAndExit(findings, base) {
  if (base.note) {
    console.warn(`${TAG} Note: ${base.note}`);
  }

  if (findings.length === 0) {
    const scanned = base.kind === 'none' ? 'skipped' : `scanned diff ${base.ref}`;
    console.log(`${TAG} Passed - 0 new violations (${scanned}).`);
    return;
  }

  for (const f of findings) {
    console.error(`${TAG} ${f.file}:${f.line} ${f.ruleId}: ${f.reason}`);
    console.error(`${TAG}   Snippet: ${f.snippet}`);
    console.error(`${TAG}   Next action: ${f.nextAction}`);
  }
  console.error(
    `${TAG} FAILED - ${findings.length} new violation(s) introduced by this PR.`,
  );
  console.error(
    `${TAG} Next action: fix the above or add a scoped exemption:`,
  );
  console.error(
    `${TAG}   // runtime-contract-exempt: ERR-XXX <non-empty reason>`,
  );
  process.exit(1);
  // CLI Gate Rule 2 — exit then return, no further side effects below.
}

/**
 * Decide whether the env escape hatch is set. Accepts the conventional falsy
 * spellings so an operator under release pressure is not forced to remember
 * the exact literal `'0'`.
 *
 * Exported for testability — the value is read from `process.env` at call time.
 *
 * @param {string | undefined} [value] - override for testing; defaults to process.env
 * @returns {boolean}
 */
export function isEscapeHatchSet(value) {
  const v = arguments.length > 0 ? value : process.env.PD_RUNTIME_CONTRACT_SCAN;
  if (v === undefined || v === null) return false;
  const normalized = String(v).trim().toLowerCase();
  return (
    normalized === '0' ||
    normalized === 'false' ||
    normalized === 'no' ||
    normalized === 'off' ||
    normalized === ''
  );
}

/**
 * Main entry point. Guarded so importing the module for tests does not run it.
 */
function main() {
  if (isEscapeHatchSet()) {
    console.log(`${TAG} skipped (PD_RUNTIME_CONTRACT_SCAN=${process.env.PD_RUNTIME_CONTRACT_SCAN})`);
    return;
  }

  let result;
  try {
    result = scan();
  } catch (err) {
    // Runtime Contract Rule 9 — graceful degradation with reason + next action.
    // A scanner crash is NOT a silent pass: we exit non-zero so CI surfaces it
    // rather than masking a real regression. The operator can still bypass via
    // PD_RUNTIME_CONTRACT_SCAN if the crash is blocking an emergency release.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} FAILED: scanner crashed unexpectedly: ${msg}`);
    console.error(`${TAG} Next action: rerun locally or set PD_RUNTIME_CONTRACT_SCAN=0 to bypass.`);
    process.exit(1);
    return;
  }

  reportAndExit(result.findings, result.base);
}

if (process.argv[1] && process.argv[1].endsWith('check-runtime-contract.js')) {
  main();
}
