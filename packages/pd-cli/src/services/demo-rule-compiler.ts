/**
 * Demo Rule Compiler — Minimal bridge for Story A demo runner
 *
 * PURPOSE: Compile rule implementation code strings into typed evaluate
 * functions for use in `evaluateInRefinerSandbox`. This allows the demo
 * to perform REAL canActivate validation instead of always returning success.
 *
 * ARCHITECTURE: This intentionally duplicates the compilation logic from
 * `openclaw-plugin/src/core/rule-implementation-runtime.ts` because pd-cli
 * cannot depend on the bundled openclaw-plugin package. The compilation
 * logic is identical: normalize exports → vm compile → extract evaluate.
 *
 * NOT for production use — the openclaw-plugin's RuleHost uses its own
 * `loadRuleImplementationModule` for production code_tool_hook evaluation.
 */

import * as vm from 'node:vm';
import type { RuleHostInput, RuleHostResult } from '@principles/core/runtime-v2';
import type { RuleHostHelpers } from '@principles/core/runtime-v2';
import type { ReplayEvaluateFn } from '@principles/core/runtime-v2';
import { safeStringifyPreview, validateCorrectionProposal } from '@principles/core/runtime-v2';

function normalizeSource(sourceCode: string): string {
  const withoutExports = sourceCode
    .replace(/export\s+const\s+meta\s*=/, 'const meta =')
    .replace(/export\s+function\s+evaluate\s*\(/, 'function evaluate(');

  return `${withoutExports}
globalThis.__pdRuleModule = {
  meta: typeof meta === 'undefined' ? undefined : meta,
  evaluate: typeof evaluate === 'undefined' ? undefined : evaluate,
};`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRuleEvaluator(value: unknown): value is (input: RuleHostInput, helpers: RuleHostHelpers) => unknown {
  return typeof value === 'function';
}

function isRuleHostResult(value: unknown): value is RuleHostResult {
  if (!isRecord(value)) return false;
  const decision = Object.hasOwn(value, 'decision') ? value.decision : undefined;
  const matched = Object.hasOwn(value, 'matched') ? value.matched : undefined;
  const reason = Object.hasOwn(value, 'reason') ? value.reason : undefined;
  if (decision !== 'allow' && decision !== 'block' && decision !== 'requireApproval' && decision !== 'auto_correct') {
    return false;
  }
  if (typeof matched !== 'boolean' || typeof reason !== 'string') return false;
  if (decision === 'auto_correct') {
    const proposal = Object.hasOwn(value, 'correctionProposal') ? value.correctionProposal : undefined;
    return validateCorrectionProposal(proposal).valid;
  }
  return true;
}
/**
 * Compile rule implementation code and return a typed evaluate function.
 * Mirrors `createReplayEvaluateFromCode` in openclaw-plugin.
 *
 * @throws if the code fails to compile or does not define a function evaluate
 */
export function compileDemoRule(code: string, sourceLabel: string): ReplayEvaluateFn {
  const context = vm.createContext(Object.create(null));
  const script = new vm.Script(normalizeSource(code), {
    filename: sourceLabel,
  });

  script.runInContext(context, { timeout: 1000, displayErrors: true });

  const moduleExports = (context as { __pdRuleModule?: { meta?: unknown; evaluate?: unknown } }).__pdRuleModule;
  delete (context as { __pdRuleModule?: unknown }).__pdRuleModule;

  if (!moduleExports || !isRuleEvaluator(moduleExports.evaluate)) {
    throw new Error(`[compileDemoRule] ${sourceLabel}: compiled module has no evaluate function`);
  }

  const evaluateFn = moduleExports.evaluate;
  return (input: RuleHostInput, helpers: RuleHostHelpers): RuleHostResult => {
    const result = evaluateFn(input, helpers);
    if (!isRuleHostResult(result)) {
      throw new Error(
        `[${sourceLabel}]: evaluate returned invalid RuleHostResult (got ${
          typeof result === 'object' && result !== null ? safeStringifyPreview(result) : String(result)
        })`,
      );
    }
    return result;
  };
}
