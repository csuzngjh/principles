import type { GoldenTrace, GoldenTraceCase } from '../golden-trace.js';
import type { ReplayEvaluateFn } from '../golden-trace-replay-validator.js';
import { checkForbiddenPatterns } from './rule-code-validator.js';
import { createSyntheticRuleHostInput } from '../golden-trace.js';
import type { RuleHostHelpers } from './rule-host-helpers.js';
import type { RuleHostResult } from './rule-host-contracts.js';

export type RefinerSandboxErrorType =
  | 'forbidden_pattern'
  | 'syntax_error'
  | 'runtime_error'
  | 'timeout'
  | 'validation_failed'
  | 'unknown';

export interface RefinerSandboxFailedCase {
  caseId: string;
  errorType: RefinerSandboxErrorType;
  message: string;
  stack?: string;
}

export interface RefinerSandboxResult {
  success: boolean;
  failedCases: RefinerSandboxFailedCase[];
  executionTimeMs: number;
  forbiddenPatternViolations: string[];
}

export interface RefinerSandboxOptions {
  timeoutMs?: number;
}

export interface RefinerSandboxDependencies {
  evaluateCode?: ReplayEvaluateFn;
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

function classifyError(err: unknown): { errorType: RefinerSandboxErrorType; message: string; stack?: string } {
  if (err instanceof SyntaxError) {
    return { errorType: 'syntax_error', message: err.message, stack: err.stack };
  }
  if (err instanceof Error) {
    return { errorType: 'runtime_error', message: err.message, stack: err.stack };
  }
  return { errorType: 'unknown', message: String(err) };
}

function resolveTimeoutMs(timeoutMs: number): number {
  if (timeoutMs > MAX_TIMEOUT_MS) {
    return MAX_TIMEOUT_MS;
  }
  if (timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return timeoutMs;
}

function evaluateCaseWithTimeout(
  evaluateFn: ReplayEvaluateFn,
  traceCase: GoldenTraceCase,
  timeoutMs: number,
): { result: RuleHostResult | null; error: unknown; timedOut: boolean } {
  const input = createSyntheticRuleHostInput(
    { toolName: traceCase.toolName, params: traceCase.params },
  );

  const helpers: RuleHostHelpers = {
    isRiskPath: () => input.workspace.isRiskPath,
    getToolName: () => input.action.toolName,
    getEstimatedLineChanges: () => input.derived.estimatedLineChanges,
    getBashRisk: () => input.derived.bashRisk,
    hasPlanFile: () => input.workspace.hasPlanFile,
    getPlanStatus: () => input.workspace.planStatus,
    getEpTier: () => input.evolution.epTier,
  };

  const start = Date.now();
  try {
    const result = evaluateFn(input, helpers);
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      return { result: null, error: null, timedOut: true };
    }
    return { result, error: null, timedOut: false };
  } catch (err) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      return { result: null, error: null, timedOut: true };
    }
    return { result: null, error: err, timedOut: false };
  }
}

function validateCaseDecision(
  traceCase: GoldenTraceCase,
  result: RuleHostResult,
): { passed: boolean; failureReason?: string } {
  switch (traceCase.expectedDecision) {
    case 'allow':
      if (result.decision !== 'allow' && result.matched !== false) {
        return { passed: false, failureReason: `Expected allow but got ${result.decision}` };
      }
      return { passed: true };
    case 'block':
      if (result.decision !== 'block' && result.decision !== 'requireApproval') {
        return { passed: false, failureReason: `Expected block but got ${result.decision}` };
      }
      return { passed: true };
    case 'propose_correction':
      if (result.decision !== 'auto_correct') {
        return { passed: false, failureReason: `Expected auto_correct (propose_correction) but got ${result.decision}` };
      }
      return { passed: true };
    default:
      return { passed: false, failureReason: `Unknown expectedDecision: ${String(traceCase.expectedDecision)}` };
  }
}

export function evaluateInRefinerSandbox(
  code: string,
  goldenTrace: GoldenTrace,
  deps: RefinerSandboxDependencies & RefinerSandboxOptions,
): RefinerSandboxResult {
  const startTime = Date.now();
  const timeoutMs = resolveTimeoutMs(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const forbiddenViolations = checkForbiddenPatterns(code);
  if (forbiddenViolations.length > 0) {
    return {
      success: false,
      failedCases: [],
      executionTimeMs: Date.now() - startTime,
      forbiddenPatternViolations: forbiddenViolations,
    };
  }

  const evaluateFn = deps.evaluateCode;
  if (!evaluateFn) {
    return {
      success: false,
      failedCases: [{
        caseId: '__no_evaluator__',
        errorType: 'unknown',
        message: 'No evaluateCode provided in dependencies',
      }],
      executionTimeMs: Date.now() - startTime,
      forbiddenPatternViolations: [],
    };
  }

  const failedCases: RefinerSandboxFailedCase[] = [];

  for (const traceCase of goldenTrace.cases) {
    const { result, error, timedOut } = evaluateCaseWithTimeout(evaluateFn, traceCase, timeoutMs);

    if (timedOut) {
      failedCases.push({
        caseId: traceCase.caseId,
        errorType: 'timeout',
        message: `Evaluation timed out after ${timeoutMs}ms`,
      });
      continue;
    }

    if (error !== null) {
      const classified = classifyError(error);
      failedCases.push({
        caseId: traceCase.caseId,
        errorType: classified.errorType,
        message: classified.message,
        stack: classified.stack,
      });
      continue;
    }

    if (result) {
      const validation = validateCaseDecision(traceCase, result);
      if (!validation.passed) {
        failedCases.push({
          caseId: traceCase.caseId,
          errorType: 'validation_failed',
          message: validation.failureReason ?? 'Validation failed',
        });
      }
    }
  }

  return {
    success: failedCases.length === 0,
    failedCases,
    executionTimeMs: Date.now() - startTime,
    forbiddenPatternViolations: [],
  };
}
