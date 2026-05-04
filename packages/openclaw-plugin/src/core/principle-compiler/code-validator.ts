/**
 * Code Validator — Validates LLM-generated rule implementation code
 *
 * CHECKS:
 * 1. Syntax: code parses without errors (VM)
 * 2. Forbidden patterns: delegates to core checkForbiddenPatterns (PRI-44)
 * 3. Export check: sandbox loads and exports evaluate + meta (VM)
 * 4. Return shape: evaluate(mockInput) returns { matched: boolean } (VM)
 *
 * PRI-44: Forbidden pattern detection extracted to @principles/core.
 */

import { nodeVm } from '../../utils/node-vm-polyfill.js';
import { loadRuleImplementationModule } from '../rule-implementation-runtime.js';
import { checkForbiddenPatterns, type ValidationResult } from '@principles/core/runtime-v2';

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

export type { ValidationResult } from '@principles/core/runtime-v2';

export function validateGeneratedCode(code: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // --- Check 1: Syntax ---
  const normalized = code
    .replace(/export\s+const\s+/g, 'const ')
    .replace(/export\s+function\s+/g, 'function ');
  try {
    new nodeVm.Script(normalized, { filename: 'code-validator-syntax.js' });
  } catch (err) {
    errors.push(`Syntax error: ${(err as Error).message}`);
    return { valid: false, errors, warnings };
  }

  // --- Check 2: Forbidden patterns (delegated to core) ---
  const forbiddenLabels = checkForbiddenPatterns(code);
  for (const label of forbiddenLabels) {
    errors.push(`Forbidden pattern: ${label}`);
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // --- Check 3: Sandbox load + export check ---
  let moduleExports: { meta?: unknown; evaluate?: unknown };
  try {
    moduleExports = loadRuleImplementationModule(code, 'code-validator-candidate.js');
  } catch (err) {
    errors.push(`Sandbox compilation error: ${(err as Error).message}`);
    return { valid: false, errors, warnings };
  }

  if (!moduleExports.meta || typeof moduleExports.meta !== 'object') {
    errors.push('Missing export: meta');
  }

  if (typeof moduleExports.evaluate !== 'function') {
    errors.push('Missing export: evaluate');
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // --- Check 4: Return shape ---
  try {
    const result = (moduleExports.evaluate as (input: unknown) => unknown)(MOCK_INPUT);
    if (!result || typeof result !== 'object') {
      errors.push('evaluate must return an object');
    } else if (typeof (result as Record<string, unknown>).matched !== 'boolean') {
      errors.push('evaluate must return { matched: boolean }');
    }
  } catch (evalWarning) {
    warnings.push(`evaluate() threw on mock input: ${(evalWarning as Error).message}`);
  }

  return { valid: errors.length === 0, errors, warnings };
}
