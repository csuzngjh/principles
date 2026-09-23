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
import type { ToolSemanticRegistry } from '../internalization/tool-semantic-registry.js';
import { evaluateInRefinerSandbox } from '../internalization/refiner-sandbox-wrapper.js';
import { checkForbiddenPatterns, checkReturnStatementsMissingFields, checkMatchedFalseDecisions } from '../internalization/rule-code-validator.js';
import { validateRuleHostResult } from '../internalization/rule-host-validator.js';
import { safeStringifyPreview } from '../feedback/safe-stringify.js';

/**
 * Security audit run-1 (rulecode.replay.in-process-evaluate-no-hard-timeout):
 * hard wall-clock cap for each replay evaluate call. Mirrors the 1000ms vm
 * compile budget above; the plugin's live child-process path keeps its own
 * larger budget (EVALUATE_PROCESS_TIMEOUT_MS). A vm timeout throw surfaces as
 * a rejected replay case (fail closed for the candidate) instead of hanging
 * the replaying console server / evaluator worker / CLI process.
 */
const REPLAY_EVALUATE_HARD_TIMEOUT_MS = 2_000;

/**
 * PRI-634 PR-A (Slice A): type-narrowing adapter over the canonical
 * validateRuleHostResult — the ONE RuleHostResult semantic authority, shared
 * with the live RuleHost (rule-host-evaluator.ts). This adapter adds no
 * semantic checks of its own; verdict parity with the canonical validator is
 * structural (pure delegation) and pinned by the table-driven regression in
 * production-gate-deps.test.ts.
 */
function isValidRuleHostResult(value: unknown): value is RuleHostResult {
  return validateRuleHostResult(value).valid;
}

/**
 * Normalize rule source code: strip ES module export keywords so the code
 * can be evaluated in a vm context (which doesn't support ESM exports).
 *
 * PRI-809 trust boundary: the module's `evaluate` export is bridged through
 * a JSON-string wrapper, so the host-side call site can only ever hand the
 * realm a primitive JSON string. The call input and the helpers are rebuilt
 * INSIDE the vm realm from the context's own intrinsics — mirroring the live
 * host-runtime executor. Handing host-realm objects to the vm-realm evaluate
 * function would let unapproved rule code walk `input.constructor.constructor`
 * back to the host Function constructor and reach host process/require.
 * Untrusted input crosses as DATA (a string), never as code or objects.
 */
function normalizeSource(sourceCode: string): string {
  const withoutExports = sourceCode
    .replace(/export\s+const\s+meta\s*=/, 'const meta =')
    .replace(/export\s+function\s+evaluate\s*\(/, 'function evaluate(');

  return `${withoutExports}
globalThis.__pdRuleModule = {
  meta: typeof meta === 'undefined' ? undefined : meta,
  evaluate: typeof evaluate === 'undefined' ? undefined : function (__pdJsonBridge) {
    var __pdCallInput = JSON.parse(__pdJsonBridge);
    var __pdCallHelpers = Object.freeze({
      isRiskPath: function () { return __pdCallInput.workspace.isRiskPath; },
      getToolName: function () { return __pdCallInput.action.toolName; },
      getEstimatedLineChanges: function () { return __pdCallInput.derived.estimatedLineChanges; },
      getBashRisk: function () { return __pdCallInput.derived.bashRisk; },
      getEpTier: function () { return __pdCallInput.evolution.epTier; }
    });
    return evaluate(__pdCallInput, __pdCallHelpers);
  },
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
 * PRI-809: compile rule implementation code in a node:vm sandbox and return
 * a hardened evaluate function for pre-activation replay. This is the shared
 * primitive for every in-process RuleCode execution path (production gate
 * deps, pd-cli demo compile, story-a demo): the host side hands the realm
 * ONLY a JSON string primitive and the vm-realm bridge (see normalizeSource)
 * rebuilds the call input + helpers inside the realm — the same crossing the
 * live host-runtime executor makes inside its child process.
 *
 * Precise boundary contract (what this does and does NOT claim):
 * - INBOUND: host-realm objects never cross. A rule walking
 *   `.constructor.constructor` (top-level, nested, or on helpers) lands on
 *   the REALM's Function, where `process`/`require` do not exist.
 * - OUTBOUND: the result crosses back as a vm-realm object and is consumed
 *   only through the canonical validateRuleHostResult (field reads + JSON
 *   preview) — the host never invokes functions on it.
 * - TIMEOUT: compilation is hard-bounded (runInContext timeout), and since the
 *   security-audit run-1 fix each evaluate call is ALSO hard-bounded — the
 *   call runs through a precompiled vm script with
 *   REPLAY_EVALUATE_HARD_TIMEOUT_MS, so a non-terminating candidate is
 *   interrupted (and its replay case fails) instead of hanging the replaying
 *   process. The soft elapsed-time classification in
 *   refiner-sandbox-wrapper.ts remains layered on top as the core-side
 *   contract; hard cancellation for the LIVE path stays a plugin/child-process
 *   responsibility.
 * - LOCKSTEP: the helper contract here (five getters over the JSON input)
 *   mirrors the live plugin executor's EVALUATION_PROCESS_SOURCE in
 *   openclaw-plugin/src/core/rule-implementation-runtime.ts. The two copies
 *   are intentionally kept (live path owns process isolation; this file owns
 *   in-process replay) but MUST stay semantically identical — change both or
 *   neither.
 *
 * @throws if the code fails to compile or does not define a function evaluate
 */
export function compileHardenedRuleEvaluator(code: string, sourceLabel: string): ReplayEvaluateFn {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error(`[${sourceLabel}] rule code is empty or not a string`);
  }

  const context = vm.createContext(Object.create(null));
  const script = new vm.Script(normalizeSource(code), { filename: sourceLabel });

  script.runInContext(context, { timeout: 1000, displayErrors: true });

  // Treat sandbox output as untrusted — use Reflect.get + type guard, not `as`.
  const moduleExportsUnknown = Reflect.get(context, '__pdRuleModule');

  if (!isCompiledModuleExports(moduleExportsUnknown)) {
    throw new Error(`[${sourceLabel}] compiled module export shape is invalid`);
  }

  if (typeof moduleExportsUnknown.evaluate !== 'function') {
    throw new Error(
      `[${sourceLabel}] compiled module has no evaluate function`,
    );
  }

  // Security audit run-1 (rulecode.replay.in-process-evaluate-no-hard-timeout):
  // the evaluate call must be HARD-bounded. The module stays on the realm
  // global and each replay runs through a precompiled vm script whose
  // runInContext timeout interrupts even a synchronous `while (true)` inside
  // the rule — previously the call was a bare host-frame function invocation
  // that an LLM-authored looping candidate could hang forever (the console
  // server, evaluator worker, or CLI process). The module object is a
  // realm-internal value (created inside this context); it never crosses to
  // the host except through the field-reading result validator below, so the
  // PRI-809 inbound DATA-only crossing is unchanged.
  const evaluateCallScript = new vm.Script('__pdRuleModule.evaluate(__pdCallJson)', {
    filename: `${sourceLabel}#evaluate`,
  });

  return (input: RuleHostInput, _helpers: RuleHostHelpers): RuleHostResult => {
    // Trust-boundary crossing: serialize host-built input to a JSON string
    // primitive. The vm-realm bridge parses it with the realm's own
    // intrinsics — a rule walking `.constructor.constructor` lands on the
    // realm's Function (where `process` does not exist), never on the host.
    let inputJson: string;
    try {
      inputJson = JSON.stringify(input);
    } catch (err: unknown) {
      throw new Error(
        `[${sourceLabel}] replay input is not JSON-serializable (trust-boundary crossing requires plain data): ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
    context.__pdCallJson = inputJson;
    let result: unknown;
    try {
      result = evaluateCallScript.runInContext(context, {
        timeout: REPLAY_EVALUATE_HARD_TIMEOUT_MS,
        displayErrors: true,
      });
    } finally {
      Reflect.deleteProperty(context, '__pdCallJson');
    }
    // PRI-634 PR-A (Slice A): canonical RuleHostResult authority. The failure
    // message carries the canonical validator's specific errors so the
    // write-test-fix loop receives actionable evidence (P-03).
    if (!isValidRuleHostResult(result)) {
      const { errors } = validateRuleHostResult(result);
      throw new Error(
        `[${sourceLabel}]: evaluate returned invalid RuleHostResult (${errors.join('; ')}) — got ${typeof result === 'object' && result !== null ? safeStringifyPreview(result) : String(result)}`,
      );
    }
    return result;
  };
}

export interface ProductionGateDepsOptions {
  /**
   * PRI-634-F Phase 2: the ToolSemanticRegistry the constructing host resolves
   * tool semantics with (baseline-only when omitted). Threaded into sandbox
   * replay so golden-trace synthetic inputs derive canonicalKind + extraction
   * hints identically to the production gate — replay/production input parity.
   */
  toolSemantics?: ToolSemanticRegistry;
  /**
   * PRI-634-F Phase 2: workspace root the production gate normalizes paths
   * against. Used as the replay normalization default so callers that don't
   * thread a per-call projectDir still replay with production-identical
   * normalizedPath values.
   */
  projectDir?: string;
}

/**
 * Create a production-grade RefinerRuleHostGateDeps that compiles rule code
 * using node:vm and evaluates it against golden traces.
 *
 * This factory is the canonical production gateDeps provider. It replaces
 * the demo-only createSandboxGateDeps() in pd-cli and makes the gateDeps
 * available to all packages that depend on @principles/core.
 */
export function createProductionGateDeps(options: ProductionGateDepsOptions = {}): RefinerRuleHostGateDeps {
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

      // Static check: catch return statements missing required RuleHostResult
      // fields (decision, matched, reason) before VM execution. This catches
      // the most common LLM mistake (e.g. `return { matched: false }`) and
      // feeds a specific error message back into the write-test-fix loop.
      const returnShapeViolations = checkReturnStatementsMissingFields(code);
      if (returnShapeViolations.length > 0) {
        return {
          success: false,
          failedCases: returnShapeViolations.map((msg) => ({
            caseId: '__return_shape__',
            errorType: 'validation_failed' as const,
            message: msg,
          })),
          executionTimeMs: Date.now() - startTime,
          forbiddenPatternViolations: [],
        };
      }

      // PRI-439 Phase 2: static check for matched=false paired with a
      // non-allow decision. The runtime validator (validateRuleHostResult)
      // enforces this authoritatively, but this early-warning layer catches
      // the most common LLM mistake before VM execution.
      const matchedFalseViolations = checkMatchedFalseDecisions(code);
      if (matchedFalseViolations.length > 0) {
        return {
          success: false,
          failedCases: matchedFalseViolations.map((msg) => ({
            caseId: '__matched_false_decision__',
            errorType: 'validation_failed' as const,
            message: msg,
          })),
          executionTimeMs: Date.now() - startTime,
          forbiddenPatternViolations: [],
        };
      }

      let evaluateCode: ReplayEvaluateFn;
      try {
        evaluateCode = compileHardenedRuleEvaluator(code, 'production-gate-deps');
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
        // PRI-634-F: caller-supplied opts take precedence; the factory default
        // fills the registry/root when the gate caller passed none (legacy callers).
        toolSemantics: opts?.toolSemantics ?? options.toolSemantics,
        projectDir: opts?.projectDir ?? options.projectDir,
      });
    },
  };
}
