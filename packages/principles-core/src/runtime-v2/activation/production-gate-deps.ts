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
import type { RuleHostInput, RuleHostResult, RuleHostDecision } from '../internalization/rule-host-contracts.js';
import type { RuleHostHelpers } from '../internalization/rule-host-helpers.js';
import type { ReplayEvaluateFn } from '../golden-trace-replay-validator.js';
import type { GoldenTrace } from '../golden-trace.js';
import type {
  RefinerRuleHostGateDeps,
} from '../internalization/refiner-rulehost-gate.js';
import type { RefinerSandboxResult, RefinerSandboxOptions } from '../internalization/refiner-sandbox-wrapper.js';
import { evaluateInRefinerSandbox } from '../internalization/refiner-sandbox-wrapper.js';
import { checkForbiddenPatterns } from '../internalization/rule-code-validator.js';
import { validateCorrectionProposal } from '../internalization/correction-proposal.js';
import { safeStringifyPreview } from '../feedback/safe-stringify.js';

/**
 * Valid decision enum values for RuleHostResult.
 * Used to validate untrusted vm sandbox output (P2 #6 fix).
 */
const VALID_DECISIONS = new Set<RuleHostDecision>(['allow', 'block', 'requireApproval', 'auto_correct']);

/**
 * Type guard: validate that a value from the untrusted vm sandbox has the
 * full RuleHostResult shape. Treats all sandbox output as unknown.
 *
 * P2 #6 fix: previously the code only checked `decision` was a string, then
 * used `as RuleHostResult` to accept the entire object. This bypassed
 * validation of the decision enum value and other required fields.
 */
function isValidRuleHostResult(value: unknown): value is RuleHostResult {
  if (typeof value !== 'object' || value === null) return false;

  // decision: required, must be one of the 4 valid enum values
  const decision = Reflect.get(value, 'decision');
  if (typeof decision !== 'string' || !VALID_DECISIONS.has(decision as RuleHostDecision)) {
    return false;
  }

  // matched: required, must be a boolean
  const matched = Reflect.get(value, 'matched');
  if (typeof matched !== 'boolean') return false;

  // reason: required, must be a string
  const reason = Reflect.get(value, 'reason');
  if (typeof reason !== 'string') return false;

  // When decision is 'auto_correct', correctionProposal must be present
  // AND pass full structural validation (P2 #6 fix: previously only checked
  // presence + typeof object, allowing malformed proposals with missing
  // required fields like proposedParams, correctedFields, applicationMode,
  // confidence, ruleId, notifyAgent to flow into the activation path).
  if (decision === 'auto_correct') {
    const correctionProposal = Reflect.get(value, 'correctionProposal');
    if (correctionProposal === undefined || correctionProposal === null) {
      return false;
    }
    const proposalValidation = validateCorrectionProposal(correctionProposal);
    if (!proposalValidation.valid) {
      return false;
    }
  }

  return true;
}

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
 * Type guard: validate that a value from the untrusted vm sandbox has the
 * expected CompiledModuleExports shape. Treats all sandbox output as unknown.
 */
function isCompiledModuleExports(value: unknown): value is CompiledModuleExports {
  return typeof value === 'object' && value !== null;
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

  // Treat sandbox output as untrusted — use Reflect.get + type guard, not `as`.
  const moduleExportsUnknown = Reflect.get(context, '__pdRuleModule');
  Reflect.deleteProperty(context, '__pdRuleModule');

  if (!isCompiledModuleExports(moduleExportsUnknown)) {
    throw new Error(`[${sourceLabel}] compiled module export shape is invalid`);
  }

  const evaluateFn = moduleExportsUnknown.evaluate;
  if (typeof evaluateFn !== 'function') {
    throw new Error(
      `[${sourceLabel}] compiled module has no evaluate function`,
    );
  }

  return (input: RuleHostInput, helpers: RuleHostHelpers): RuleHostResult => {
    const result = Reflect.apply(evaluateFn, undefined, [input, helpers]) as unknown;
    // P2 #6 fix: validate the full RuleHostResult shape, not just `decision` is a string.
    // Previously used `as RuleHostResult` which bypassed enum + required field validation.
    if (!isValidRuleHostResult(result)) {
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
      const startTime = Date.now();

      // P2 #6 fix: check forbidden patterns BEFORE compilation/execution.
      // Previously, compileRuleCode() executed the code via script.runInContext()
      // and only then did evaluateInRefinerSandbox() check forbidden patterns —
      // meaning malicious code (e.g. require('child_process')) would execute
      // before being rejected. The check must happen on the source string
      // before any vm execution.
      const forbiddenViolations = checkForbiddenPatterns(code);
      if (forbiddenViolations.length > 0) {
        return {
          success: false,
          failedCases: [],
          executionTimeMs: Date.now() - startTime,
          forbiddenPatternViolations: forbiddenViolations,
        };
      }

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
          executionTimeMs: Date.now() - startTime,
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
