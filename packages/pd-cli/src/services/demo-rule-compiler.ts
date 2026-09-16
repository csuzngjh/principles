/**
 * Demo Rule Compiler — Minimal bridge for Story A demo runner and the
 * rulehost pipeline behavior checks.
 *
 * PURPOSE: Compile rule implementation code strings into typed evaluate
 * functions for use in `evaluateInRefinerSandbox`.
 *
 * ARCHITECTURE (PRI-809): compilation delegates to the canonical hardened
 * replay evaluator in @principles/core — the vm realm with the JSON-string
 * trust-boundary crossing (input + helpers rebuilt inside the realm), the
 * same primitive the production gate uses. The previous local vm duplicate
 * handed host-realm objects to the vm-realm evaluate function, which let
 * unapproved rule code escape via `input.constructor.constructor`.
 */

import type { RuleHostInput, RuleHostResult } from '@principles/core/runtime-v2';
import type { RuleHostHelpers } from '@principles/core/runtime-v2';
import type { ReplayEvaluateFn } from '@principles/core/runtime-v2';
import { compileHardenedRuleEvaluator, safeStringifyPreview, validateRuleHostResult } from '@principles/core/runtime-v2';

/**
 * Compile rule implementation code and return a typed evaluate function.
 *
 * @throws if the code fails to compile or does not define a function evaluate
 */
export function compileDemoRule(code: string, sourceLabel: string): ReplayEvaluateFn {
  const evaluateFn = compileHardenedRuleEvaluator(code, sourceLabel);
  return (input: RuleHostInput, helpers: RuleHostHelpers): RuleHostResult => {
    const result = evaluateFn(input, helpers);
    const validation = validateRuleHostResult(result);
    if (!validation.valid) {
      throw new Error(
        `[${sourceLabel}]: evaluate returned invalid RuleHostResult — ${validation.errors.join('; ')} (got ${
          typeof result === 'object' && result !== null ? safeStringifyPreview(result) : String(result)
        })`,
      );
    }
    return result;
  };
}
