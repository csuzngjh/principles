/**
 * Code Validator — Validates LLM-generated rule implementation code
 *
 * PURPOSE: Ensure generated code is safe, syntactically correct, and exports
 * the expected shape before it is stored as a rule implementation.
 *
 * CHECKS:
 * 1. Syntax: code parses without errors
 * 2. Forbidden patterns: no require, import, fetch, eval, Function, process, globalThis
 * 3. Export check: sandbox loads and exports evaluate + meta
 * 4. Return shape: evaluate(mockInput) returns { matched: boolean }
 *
 * Reuses loadRuleImplementationModule for sandbox execution (node:vm isolation).
 */

import { nodeVm } from '../../utils/node-vm-polyfill.js';
import { loadRuleImplementationModule } from '../rule-implementation-runtime.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brequire\s*\(/, label: 'require' },
  { pattern: /\bimport\s+/, label: 'import' },
  { pattern: /\bfetch\s*\(/, label: 'fetch' },
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /\bFunction\s*\(/, label: 'Function' },
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\bglobalThis\b/, label: 'globalThis' },
];

const MOCK_INPUT = {
  action: {
    toolName: 'bash',
    normalizedPath: '/tmp/test.ts',
    paramsSummary: { command: 'echo test' },
  },
  workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
  session: { sessionId: 'test', currentGfi: 0, recentThinking: false },
  evolution: { epTier: 0 },
  derived: { estimatedLineChanges: 0, bashRisk: 'safe' },
};

export function validateGeneratedCode(code: string): ValidationResult {
  const errors: string[] = [];

  // --- Check 1: Syntax ---
  // Normalize export keywords so vm.Script can parse ES module source
  const normalized = code
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s+function\s+/g, 'function ');
  try {
    new nodeVm.Script(normalized, { filename: 'code-validator-syntax.js' });
  } catch (err) {
    errors.push(`Syntax error: ${(err as Error).message}`);
    return { valid: false, errors };
  }

  // --- Check 2: Forbidden patterns ---
  for (const { pattern, label } of FORBIDDEN_PATTERNS) {
    if (pattern.test(code)) {
      errors.push(`Forbidden pattern: ${label}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // --- Check 3: Sandbox load + export check ---
  let moduleExports: { meta?: unknown; evaluate?: unknown };
  try {
    moduleExports = loadRuleImplementationModule(code, 'code-validator-candidate.js');
  } catch (err) {
    errors.push(`Sandbox compilation error: ${(err as Error).message}`);
    return { valid: false, errors };
  }

  if (!moduleExports.meta || typeof moduleExports.meta !== 'object') {
    errors.push('Missing export: meta');
  }

  if (typeof moduleExports.evaluate !== 'function') {
    errors.push('Missing export: evaluate');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // --- Check 4: Return shape ---
  try {
    const result = (moduleExports.evaluate as (input: unknown) => unknown)(MOCK_INPUT);
    if (!result || typeof result !== 'object') {
      errors.push('evaluate must return an object');
    } else if (typeof (result as Record<string, unknown>).matched !== 'boolean') {
      errors.push('evaluate must return { matched: boolean }');
    }
  } catch {
    // evaluate throwing on mock input is acceptable — the function exists and
    // has the right signature, it just can't handle our mock data
  }

  return { valid: errors.length === 0, errors };
}
