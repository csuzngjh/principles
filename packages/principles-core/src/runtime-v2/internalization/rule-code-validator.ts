/**
 * Rule Code Validator — Pure forbidden-pattern detection
 *
 * PURPOSE: Check rule implementation source code for forbidden API patterns.
 * This is the pure (non-VM) part of code validation that can run without
 * filesystem, sandbox, or OpenClaw infrastructure.
 *
 * PRI-44: Pure validation logic, zero infrastructure dependency.
 * VM-dependent checks remain in the plugin layer.
 *
 * PRI-668: pattern matching examines EXECUTABLE source only — comments and
 * string-literal contents are masked first (maskNonExecutableText). A string
 * literal is DATA; it can only become code through the dynamic-evaluation
 * and bracket-access primitives, each of which is its own forbidden pattern,
 * so the masking creates no escape. Template `${...}` interpolation stays
 * un-masked (executable).
 */

import { maskNonExecutableText } from './legacy-rule-contract-scanner.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brequire\s*\(/, label: 'require' },
  { pattern: /\bimport\s+/, label: 'import' },
  // PRI-439 Phase 2: export forbidden — canonical form is bare `function evaluate(input, helpers)`
  { pattern: /\bexport\b/, label: 'export' },
  // PRI-439 Phase 2: async/await forbidden — canonical form is synchronous
  { pattern: /\basync\b/, label: 'async' },
  { pattern: /\bawait\b/, label: 'await' },
  { pattern: /\bfetch\s*\(/, label: 'fetch' },
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /\bFunction\s*\(/, label: 'Function' },
  { pattern: /\bprocess\b(?![\w])/, label: 'process' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  // Bare "global" as identifier/global. PRI-668: literal/comment occurrences
  // no longer match — the source is masked before scanning (see header), so
  // `paramsSummary.scope === 'global'` and `// global rule` are DATA, not access.
  { pattern: /\bglobal\b(?![A-Za-z])/, label: 'global' },
  { pattern: /\bReflect\b/, label: 'Reflect' },
  { pattern: /\bProxy\b/, label: 'Proxy' },
  { pattern: /\bconstructor\b/, label: 'constructor' },
  { pattern: /\bBuffer\b/, label: 'Buffer' },
  // Timers (PRI-439 Phase 2: added setImmediate, queueMicrotask)
  { pattern: /\bsetTimeout\b/, label: 'setTimeout' },
  { pattern: /\bsetInterval\b/, label: 'setInterval' },
  { pattern: /\bsetImmediate\b/, label: 'setImmediate' },
  { pattern: /\bqueueMicrotask\b/, label: 'queueMicrotask' },
  // Network (PRI-439 Phase 2: added XMLHttpRequest)
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  // Random / non-deterministic (PRI-439 Phase 2)
  { pattern: /Math\.random/, label: 'Math.random' },
  { pattern: /\bcrypto\b/, label: 'crypto' },
  // SEC-BASE-2: vm escape surface — meta-programming & shared-memory primitives
  { pattern: /\bimport\s*\.\s*meta\b/, label: 'import.meta' },
  { pattern: /\bWeakRef\b/, label: 'WeakRef' },
  { pattern: /\bFinalizationRegistry\b/, label: 'FinalizationRegistry' },
  { pattern: /\bSharedArrayBuffer\b/, label: 'SharedArrayBuffer' },
  { pattern: /\bAtomics\b/, label: 'Atomics' },
  { pattern: /\[\s*['"](require|import|import\.meta|fetch|eval|process|globalThis|global|Reflect|Proxy|Buffer|Function|setImmediate|queueMicrotask|XMLHttpRequest|crypto|WeakRef|FinalizationRegistry|SharedArrayBuffer|Atomics)\s*['"]\s*\]/, label: 'bracket access to forbidden global' },
];

/**
 * Pure forbidden-pattern check — returns labels of all forbidden patterns found.
 * No VM, no filesystem, no side effects.
 *
 * PRI-668: identifier-shaped patterns scan the MASKED source (comments +
 * string-literal contents blanked) so a literal like 'global_apply' or a
 * comment mentioning "global" is not flagged as an access. Template `${}`
 * interpolation survives masking and stays subject to every pattern.
 *
 * EXCEPTION — the bracket-access pattern scans the RAW source: it exists
 * precisely to catch forbidden-global names reached THROUGH a string literal
 * (`globalThis['WeakRef']`), so masking would defeat it. The literal is the
 * attack surface there, not incidental data.
 */
const BRACKET_ACCESS_LABEL = 'bracket access to forbidden global';

export function checkForbiddenPatterns(code: string): string[] {
  const executableSource = maskNonExecutableText(code);
  const labels: string[] = [];
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    const haystack = label === BRACKET_ACCESS_LABEL ? code : executableSource;
    if (pattern.test(haystack)) {
      labels.push(label);
    }
  }
  return labels;
}

/**
 * Best-effort static check: find `return { ... }` statements where
 * `matched: false` is paired with a decision other than 'allow'.
 *
 * PRI-439 Phase 2: when matched=false, the only valid decision is 'allow'.
 * A `return { matched: false, decision: 'block' }` is contradictory —
 * "the rule did not match, but I want to block" makes no sense.
 *
 * Only matches simple return objects without nested braces (same limitation
 * as checkReturnStatementsMissingFields). Complex returns with nested braces
 * are skipped — no false positives. The runtime validator
 * (validateRuleHostResult) is the authoritative check.
 *
 * Returns an array of violation messages (empty if no violations found).
 */
export function checkMatchedFalseDecisions(code: string): string[] {
  const violations: string[] = [];
  const returnPattern = /return\s*\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = returnPattern.exec(code)) !== null) {
    const content = match[1] ?? '';
    const hasMatchedFalse = /\bmatched\s*:\s*false\b/.test(content);
    if (!hasMatchedFalse) continue;

    // Extract the decision value from the return object.
    // Matches: decision: 'block', decision: "block", decision: `block`
    const decisionMatch = /\bdecision\s*:\s*['"`]([^'"`]+)['"`]/.exec(content);
    if (decisionMatch === null) continue;

    const [, decisionValue] = decisionMatch;
    if (decisionValue !== undefined && decisionValue !== 'allow') {
      violations.push(
        `matched=false requires decision 'allow', got '${decisionValue}' — found: return { ${content.trim()} }`,
      );
    }
  }
  return violations;
}

/**
 * Best-effort static check: find `return { ... }` statements in rule code that
 * are missing required RuleHostResult fields (decision, matched, reason).
 *
 * Only matches simple return objects without nested braces. Complex returns
 * (with nested objects like correctionProposal) are skipped — no false positives.
 * The sandbox's runtime type guard (isValidRuleHostResult) is the authoritative
 * check; this is an early-warning static layer that catches the most common
 * LLM mistake pattern (e.g. `return { matched: false }`) before VM execution.
 *
 * Returns an array of violation messages (empty if no violations found).
 */
export function checkReturnStatementsMissingFields(code: string): string[] {
  const violations: string[] = [];
  // Match `return { ... }` blocks without nested braces (multiline).
  // [^{}] ensures we only match simple objects — complex returns with nested
  // objects (e.g. correctionProposal) are skipped to avoid false positives.
  const returnPattern = /return\s*\{([^{}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = returnPattern.exec(code)) !== null) {
    const content = match[1] ?? '';
    const hasDecision = /\bdecision\s*:/.test(content);
    const hasMatched = /\bmatched\s*:/.test(content);
    const hasReason = /\breason\s*:/.test(content);
    const missing: string[] = [];
    if (!hasDecision) missing.push('decision');
    if (!hasMatched) missing.push('matched');
    if (!hasReason) missing.push('reason');
    if (missing.length > 0) {
      violations.push(
        `return statement missing required field(s): ${missing.join(', ')} — found: return { ${content.trim()} }`,
      );
    }
  }
  return violations;
}
