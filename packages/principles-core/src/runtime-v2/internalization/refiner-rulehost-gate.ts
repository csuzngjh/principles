import type { GoldenTrace } from '../golden-trace.js';
import type { RefinerSandboxResult, RefinerSandboxOptions, RefinerSandboxFailedCase } from './refiner-sandbox-wrapper.js';
import type { ToolSemanticRegistry } from './tool-semantic-registry.js';
import { classifyReplayFailure, type RuleReliabilityFailure } from './rule-reliability-validation.js';

export type RefinerRuleHostGateDecision =
  | 'accepted_shadow'
  | 'rejected_validation_failed'
  | 'rejected_forbidden_pattern'
  | 'rejected_timeout'
  | 'rejected_runtime_error'
  | 'rejected_no_cases';

export interface RefinerRuleHostGateInput {
  code: string;
  goldenTrace: GoldenTrace;
  requestedMode?: 'shadow' | 'live';
  softTimeoutMs?: number;
  /**
   * PRI-634-F Phase 2: registry the production gate resolves tool semantics
   * with. Threaded into the sandbox so replay synthetic inputs derive
   * canonicalKind + extraction hints identically to production. Absent →
   * legacy replay inputs (parity disabled).
   */
  toolSemantics?: ToolSemanticRegistry;
  /**
   * PRI-634-F Phase 2: workspace root for replay path normalization — the
   * same root the production gate normalizes against. Absent → legacy
   * normalizedPath=null replay inputs.
   */
  projectDir?: string;
}

export interface RefinerRuleHostGateResult {
  decision: RefinerRuleHostGateDecision;
  applicationMode: 'shadow';
  sandboxResult: RefinerSandboxResult;
  reasons: string[];
  /**
   * PRI-634-F Phase 3: layered attribution for every rejected decision
   * ({layer, reasonCode, evidence, nextAction} — SPEC §8/§10). Absent on
   * accepted_shadow. Routing only — no repair.
   */
  failure?: RuleReliabilityFailure;
}

export interface RefinerRuleHostGateDeps {
  evaluateInSandbox: (
    code: string,
    goldenTrace: GoldenTrace,
    opts?: RefinerSandboxOptions,
  ) => RefinerSandboxResult;
}

const EMPTY_SANDBOX_RESULT: RefinerSandboxResult = {
  success: false,
  failedCases: [],
  executionTimeMs: 0,
  forbiddenPatternViolations: [],
};

function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null) {
    return 'null';
  }
  if (err === undefined) {
    return 'undefined';
  }
  if (typeof err === 'string') {
    return err;
  }
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err);
  }
  if (typeof err === 'symbol') {
    return err.toString();
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return '[unserializable]';
  }
}

function sandboxFailureFromThrow(err: unknown): RefinerSandboxResult {
  const message = safeErrorMessage(err);
  const errorType: RefinerSandboxFailedCase['errorType'] = err instanceof Error ? 'runtime_error' : 'unknown';
  return {
    success: false,
    failedCases: [{ caseId: '__sandbox__', errorType, message }],
    executionTimeMs: 0,
    forbiddenPatternViolations: [],
  };
}

interface SandboxSafeOutcome {
  result: RefinerSandboxResult;
  threw: boolean;
}

function invokeSandboxSafe(
  deps: RefinerRuleHostGateDeps,
  args: { code: string; goldenTrace: GoldenTrace; opts?: RefinerSandboxOptions },
): SandboxSafeOutcome {
  try {
    return { result: deps.evaluateInSandbox(args.code, args.goldenTrace, args.opts), threw: false };
  } catch (err: unknown) {
    return { result: sandboxFailureFromThrow(err), threw: true };
  }
}

export function evaluateRefinerRuleHostGate(
  input: RefinerRuleHostGateInput,
  deps: RefinerRuleHostGateDeps,
): RefinerRuleHostGateResult {
  const reasons: string[] = [];

  if (input.requestedMode === 'live') {
    reasons.push('requestedMode=live is not supported in PRI-173; applicationMode forced to shadow');
  }

  if (input.goldenTrace.cases.length === 0) {
    const decision = 'rejected_no_cases' as const;
    return {
      decision,
      applicationMode: 'shadow',
      sandboxResult: EMPTY_SANDBOX_RESULT,
      reasons: ['goldenTrace.cases is empty — no test cases to validate against', ...reasons],
      failure: classifyReplayFailure(decision, EMPTY_SANDBOX_RESULT),
    };
  }

  const sandboxOpts: RefinerSandboxOptions | undefined = {
    ...(input.softTimeoutMs !== undefined ? { softTimeoutMs: input.softTimeoutMs } : {}),
    ...(input.toolSemantics !== undefined ? { toolSemantics: input.toolSemantics } : {}),
    ...(input.projectDir !== undefined ? { projectDir: input.projectDir } : {}),
  };

  const sandboxOutcome = invokeSandboxSafe(deps, { code: input.code, goldenTrace: input.goldenTrace, opts: sandboxOpts });
  if (sandboxOutcome.threw) {
    const decision = 'rejected_runtime_error' as const;
    return {
      decision,
      applicationMode: 'shadow',
      sandboxResult: sandboxOutcome.result,
      reasons: ['sandbox adapter failure: evaluateInSandbox threw', ...reasons],
      failure: classifyReplayFailure(decision, sandboxOutcome.result),
    };
  }
  const sandboxResult = sandboxOutcome.result;

  if (sandboxResult.forbiddenPatternViolations.length > 0) {
    const decision = 'rejected_forbidden_pattern' as const;
    return {
      decision,
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        `forbidden patterns detected: ${sandboxResult.forbiddenPatternViolations.join(', ')}`,
        ...reasons,
      ],
      failure: classifyReplayFailure(decision, sandboxResult),
    };
  }

  if (sandboxResult.failedCases.length === 0) {
    if (!sandboxResult.success) {
      const decision = 'rejected_runtime_error' as const;
      return {
        decision,
        applicationMode: 'shadow',
        sandboxResult,
        reasons: ['sandbox reported success=false with no failedCases or forbiddenPatternViolations — fail closed', ...reasons],
        failure: classifyReplayFailure(decision, sandboxResult),
      };
    }
    return {
      decision: 'accepted_shadow',
      applicationMode: 'shadow',
      sandboxResult,
      reasons,
    };
  }

  const errorTypes = new Set(sandboxResult.failedCases.map((c) => c.errorType));

  if (errorTypes.has('timeout')) {
    const decision = 'rejected_timeout' as const;
    const timeoutCases = sandboxResult.failedCases.filter((c) => c.errorType === 'timeout');
    return {
      decision,
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        ...timeoutCases.map((c) => `case ${c.caseId}: timeout — ${c.message}`),
        ...reasons,
      ],
      failure: classifyReplayFailure(decision, sandboxResult),
    };
  }

  const runtimeErrorTypes: ReadonlySet<string> = new Set(['runtime_error', 'syntax_error', 'unknown']);
  const hasRuntimeError = [...errorTypes].some((t) => runtimeErrorTypes.has(t));
  if (hasRuntimeError) {
    const decision = 'rejected_runtime_error' as const;
    const runtimeCases = sandboxResult.failedCases.filter((c) => runtimeErrorTypes.has(c.errorType));
    return {
      decision,
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        ...runtimeCases.map((c) => `case ${c.caseId}: ${c.errorType} — ${c.message}`),
        ...reasons,
      ],
      failure: classifyReplayFailure(decision, sandboxResult),
    };
  }

  if (errorTypes.has('validation_failed')) {
    const decision = 'rejected_validation_failed' as const;
    const validationCases = sandboxResult.failedCases.filter((c) => c.errorType === 'validation_failed');
    return {
      decision,
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        ...validationCases.map((c) => `case ${c.caseId}: validation_failed — ${c.message}`),
        ...reasons,
      ],
      failure: classifyReplayFailure(decision, sandboxResult),
    };
  }

  const fallbackDecision = 'rejected_runtime_error' as const;
  return {
    decision: fallbackDecision,
    applicationMode: 'shadow',
    sandboxResult,
    reasons: [
      ...sandboxResult.failedCases.map((c) => `case ${c.caseId}: ${c.errorType} — ${c.message}`),
      ...reasons,
    ],
    failure: classifyReplayFailure(fallbackDecision, sandboxResult),
  };
}
