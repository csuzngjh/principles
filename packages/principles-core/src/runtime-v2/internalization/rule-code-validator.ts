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
