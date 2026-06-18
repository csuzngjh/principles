/**
 * Production Gate Deps Factory — Story A (PRI-408)
 *
 * PURPOSE: Provide a production-grade RefinerRuleHostGateDeps factory that
 * compiles rule implementation code using node:vm and evaluates it against
 * golden traces via evaluateInRefinerSandbox. This is the canonical
 * production compilation path — not a demo duplicate.
 *
 * ARCHITECTURE: This lives in principles-core because:
 *   1. node:vm is a pure computation primitive (no fs/network/db I/O)
 *   2. principles-core already uses node:crypto (randomUUID, createHash)
 *   3. Both pd-cli (compileDemoRule) and openclaw-plugin
 *      (loadRuleImplementationModule) duplicate this logic — placing it
 *      here eliminates duplication and makes it available to all packages
 *      that depend on @principles/core (including pd-console).
 *
 * ERR checklist:
 * - ERR-001: Rule code is string-validated before compilation
 * - ERR-002: Compilation failures produce structured error results
 * - ERR-005: Module exports validated with typeof checks, not `as`
 */

import * as vm from 'node:vm';
import type { RuleHostInput, RuleHostResult } from '../internalization/rule-host-contracts.js';
import type { RuleHostHelpers } from '../internalization/rule-host-helpers.js';
import type { ReplayEvaluateFn } from '../golden-trace-replay-validator.js';
import type { GoldenTrace } from '../golden-trace.js';
import type {
  RefinerRuleHostGateDeps,
} from '../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxResult, RefinerSandboxOptions } from '../internalization/refiner-sandbox-wrapper.js';
import { evaluateInRefinerSandbox } from '../internalization/refiner-sandbox-wrapper.js';
import { safeStringifyPreview } from '../feedback/safe-stringify.js';

/**
 * Normalize rule source code: strip ES module export keywords so the code
 * can be evaluated in a vm context (which doesn't support ESM exports).
 */
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

interface CompiledModuleExports {
  meta?: unknown;
  evaluate?: unknown;
}

/**
 * Compile rule implementation code in a node:vm sandbox and return a typed
 * evaluate function. Mirrors the compilation logic used by the production
 * openclaw-plugin RuleHost (rule-implementation-runtime.ts).
 *
 * @throws if the code fails to compile or does not define a function evaluate
 */
function compileRuleCode(code: string, sourceLabel: string): ReplayEvaluateFn {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error(`[${sourceLabel}] rule code is empty or not a string`);
  }

  const context = vm.createContext(Object.create(null));
  const script = new vm.Script(normalizeSource(code), { filename: sourceLabel });

  script.runInContext(context, { timeout: 1000, displayErrors: true });

  const moduleExports = (context as { __pdRuleModule?: CompiledModuleExports }).__pdRuleModule;
  delete (context as { __pdRuleModule?: unknown }).__pdRuleModule;

  if (!moduleExports || typeof moduleExports.evaluate !== 'function') {
    throw new Error(
      `[${sourceLabel}] compiled module has no evaluate function`,
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

/**
 * Create a production-grade RefinerRuleHostGateDeps that compiles rule code
 * using node:vm and evaluates it against golden traces.
 *
 * This factory is the canonical production gateDeps provider. It replaces
 * the demo-only createSandboxGateDeps() in pd-cli and makes the gateDeps
 * available to all packages that depend on @principles/core.
 */
export function createProductionGateDeps(): RefinerRuleHostGateDeps {
  return {
    evaluateInSandbox: (
      code: string,
      goldenTrace: GoldenTrace,
      opts?: RefinerSandboxOptions,
    ): RefinerSandboxResult => {
      let evaluateCode: ReplayEvaluateFn;
      try {
        evaluateCode = compileRuleCode(code, 'production-gate-deps');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          failedCases: [{
            caseId: '__compile__',
            errorType: 'syntax_error',
            message,
          }],
          executionTimeMs: 0,
          forbiddenPatternViolations: [],
        };
      }

      return evaluateInRefinerSandbox(code, goldenTrace, {
        evaluateCode,
        ...opts,
      });
    },
  };
}
