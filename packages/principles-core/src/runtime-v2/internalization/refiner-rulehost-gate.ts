import type { GoldenTrace } from '../golden-trace.js';
import type { RefinerSandboxResult, RefinerSandboxOptions, RefinerSandboxFailedCase } from './refiner-sandbox-wrapper.js';

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
}

export interface RefinerRuleHostGateResult {
  decision: RefinerRuleHostGateDecision;
  applicationMode: 'shadow';
  sandboxResult: RefinerSandboxResult;
  reasons: string[];
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
    return JSON.stringify(err);
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
    return {
      decision: 'rejected_no_cases',
      applicationMode: 'shadow',
      sandboxResult: EMPTY_SANDBOX_RESULT,
      reasons: ['goldenTrace.cases is empty — no test cases to validate against', ...reasons],
    };
  }

  const sandboxOpts: RefinerSandboxOptions | undefined =
    input.softTimeoutMs !== undefined ? { softTimeoutMs: input.softTimeoutMs } : undefined;

  const sandboxOutcome = invokeSandboxSafe(deps, { code: input.code, goldenTrace: input.goldenTrace, opts: sandboxOpts });
  if (sandboxOutcome.threw) {
    return {
      decision: 'rejected_runtime_error',
      applicationMode: 'shadow',
      sandboxResult: sandboxOutcome.result,
      reasons: ['sandbox adapter failure: evaluateInSandbox threw', ...reasons],
    };
  }
  const sandboxResult = sandboxOutcome.result;

  if (sandboxResult.forbiddenPatternViolations.length > 0) {
    return {
      decision: 'rejected_forbidden_pattern',
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        `forbidden patterns detected: ${sandboxResult.forbiddenPatternViolations.join(', ')}`,
        ...reasons,
      ],
    };
  }

  if (sandboxResult.failedCases.length === 0) {
    if (!sandboxResult.success) {
      return {
        decision: 'rejected_runtime_error',
        applicationMode: 'shadow',
        sandboxResult,
        reasons: ['sandbox reported success=false with no failedCases or forbiddenPatternViolations — fail closed', ...reasons],
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
    const timeoutCases = sandboxResult.failedCases.filter((c) => c.errorType === 'timeout');
    return {
      decision: 'rejected_timeout',
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        ...timeoutCases.map((c) => `case ${c.caseId}: timeout — ${c.message}`),
        ...reasons,
      ],
    };
  }

  const runtimeErrorTypes: ReadonlySet<string> = new Set(['runtime_error', 'syntax_error', 'unknown']);
  const hasRuntimeError = [...errorTypes].some((t) => runtimeErrorTypes.has(t));
  if (hasRuntimeError) {
    const runtimeCases = sandboxResult.failedCases.filter((c) => runtimeErrorTypes.has(c.errorType));
    return {
      decision: 'rejected_runtime_error',
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        ...runtimeCases.map((c) => `case ${c.caseId}: ${c.errorType} — ${c.message}`),
        ...reasons,
      ],
    };
  }

  if (errorTypes.has('validation_failed')) {
    const validationCases = sandboxResult.failedCases.filter((c) => c.errorType === 'validation_failed');
    return {
      decision: 'rejected_validation_failed',
      applicationMode: 'shadow',
      sandboxResult,
      reasons: [
        ...validationCases.map((c) => `case ${c.caseId}: validation_failed — ${c.message}`),
        ...reasons,
      ],
    };
  }

  return {
    decision: 'rejected_runtime_error',
    applicationMode: 'shadow',
    sandboxResult,
    reasons: [
      ...sandboxResult.failedCases.map((c) => `case ${c.caseId}: ${c.errorType} — ${c.message}`),
      ...reasons,
    ],
  };
}
