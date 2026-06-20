/**
 * Rule Code Validator — Pure forbidden-pattern detection
 *
 * PURPOSE: Check rule implementation source code for forbidden API patterns.
 * This is the pure (non-VM) part of code validation that can run without
 * filesystem, sandbox, or OpenClaw infrastructure.
 *
 * PRI-44: Pure validation logic, zero infrastructure dependency.
 * VM-dependent checks remain in the plugin layer.
 */

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brequire\s*\(/, label: 'require' },
  { pattern: /\bimport\s+/, label: 'import' },
  { pattern: /\bfetch\s*\(/, label: 'fetch' },
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /\bFunction\s*\(/, label: 'Function' },
  { pattern: /\bprocess\b(?![\w])/, label: 'process' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
  // Only match bare "global" as identifier/global, not in comments like "// global rule" or "the global scope"
  { pattern: /\bglobal\b(?![A-Za-z])/, label: 'global' },
  { pattern: /\bReflect\b/, label: 'Reflect' },
  { pattern: /\bProxy\b/, label: 'Proxy' },
  { pattern: /\bconstructor\b/, label: 'constructor' },
  { pattern: /\bBuffer\b/, label: 'Buffer' },
  { pattern: /\bsetTimeout\b/, label: 'setTimeout' },
  { pattern: /\bsetInterval\b/, label: 'setInterval' },
  { pattern: /\[\s*['"](require|import|fetch|eval|process|globalThis|global|Reflect|Proxy|Buffer|Function)\s*['"]\s*\]/, label: 'bracket access to forbidden global' },
];

/**
 * Pure forbidden-pattern check — returns labels of all forbidden patterns found.
 * No VM, no filesystem, no side effects.
 */
export function checkForbiddenPatterns(code: string): string[] {
  const labels: string[] = [];
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      labels.push(label);
    }
  }
  return labels;
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
