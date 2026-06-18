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
import { safeStringifyPreview } from '@principles/core/runtime-v2';

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

/**
 * Compile rule implementation code and return a typed evaluate function.
 * Mirrors `createReplayEvaluateFromCode` in openclaw-plugin.
 *
 * @throws if the code fails to compile or does not define a function evaluate
 */
export function compileDemoRule(code: string, sourceLabel: string): ReplayEvaluateFn {
  const context = vm.createContext(Object.create(null));
  const script = new vm.Script(normalizeSource(code), { filename: sourceLabel });

  script.runInContext(context, { timeout: 1000, displayErrors: true });

  const moduleExports = (context as { __pdRuleModule?: { meta?: unknown; evaluate?: unknown } })
    .__pdRuleModule;
  delete (context as { __pdRuleModule?: unknown }).__pdRuleModule;

  if (!moduleExports || typeof moduleExports.evaluate !== 'function') {
    throw new Error(
      `[compileDemoRule] ${sourceLabel}: compiled module has no evaluate function`,
    );
  }

  const evaluateFn = moduleExports.evaluate as (
    input: RuleHostInput,
    helpers: RuleHostHelpers,
  ) => RuleHostResult;

  return (input: RuleHostInput, helpers: RuleHostHelpers): RuleHostResult => {
    const result = evaluateFn(input, helpers);
    if (typeof result !== 'object' || result === null || !Object.hasOwn(result, 'decision')) {
      throw new Error(
        `[${sourceLabel}]: evaluate returned invalid RuleHostResult (got ${typeof result === 'object' && result !== null ? safeStringifyPreview(result) : String(result)})`,
      );
    }
    return result;
  };
}
