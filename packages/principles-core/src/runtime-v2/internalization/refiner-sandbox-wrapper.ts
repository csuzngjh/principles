import type { GoldenTrace, GoldenTraceCase, GoldenTraceDecision } from '../golden-trace.js';
import type { ReplayEvaluateFn } from '../golden-trace-replay-validator.js';
import { diffParams } from '../golden-trace-replay-validator.js';
import { checkForbiddenPatterns, checkReturnStatementsMissingFields } from './rule-code-validator.js';
import { createSyntheticRuleHostInput } from '../golden-trace.js';
import type { RuleHostHelpers } from './rule-host-helpers.js';
import type { RuleHostResult, RuleHostDecision } from './rule-host-contracts.js';
import { validateCorrectionProposal } from './correction-proposal.js';

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
  /**
   * PRI-634 PR-A: the trace case's expected decision. Present on every REAL
   * trace-case failure (timeout / throw / mismatch); absent on system
   * sentinel failures (__compile__ / __return_shape__ / …) which have no
   * trace identity. This is the authoritative expected/actual pairing for
   * replay evidence — it supersedes reconstructing the pair from the
   * adversarial-case list, which cannot see merged positive-case failures.
   */
  expectedDecision?: GoldenTraceDecision;
  /**
   * PRI-634 PR-A: the decision the rule actually returned. Present ONLY when
   * evaluate() produced a well-formed decision that mismatched the expected
   * one. Absent for timeouts, throws, and null results — an errorType is
   * never a decision value (SPEC §14 actualDecision semantic fix).
   */
  actualDecision?: RuleHostDecision;
}

export interface RefinerSandboxResult {
  success: boolean;
  failedCases: RefinerSandboxFailedCase[];
  executionTimeMs: number;
  forbiddenPatternViolations: string[];
}

export interface RefinerSandboxOptions {
  /** Elapsed-time classification threshold (NOT hard cancellation). See evaluateInRefinerSandbox JSDoc. */
  softTimeoutMs?: number;
}

export interface RefinerSandboxDependencies {
  evaluateCode?: ReplayEvaluateFn;
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const MAX_TIMEOUT_MS = 30000;

function safeErrorMessage(err: unknown): string {
  try {
    if (typeof err === 'string') return err;
    if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') return String(err);
    if (err === null) return 'null';
    if (err === undefined) return 'undefined';
    return String(err);
  } catch {
    try {
      return Object.prototype.toString.call(err);
    } catch {
      return 'Unstringifiable thrown value';
    }
  }
}

function isSafeRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  try {
    Object.keys(value);
    return true;
  } catch {
    return false;
  }
}

function classifyError(err: unknown): { errorType: RefinerSandboxErrorType; message: string; stack?: string } {
  if (err instanceof SyntaxError) {
    return { errorType: 'syntax_error', message: err.message, stack: err.stack };
  }
  if (err instanceof Error) {
    return { errorType: 'runtime_error', message: err.message, stack: err.stack };
  }
  // PRI-634 PR-A: errors thrown inside node:vm belong to the VM realm —
  // `instanceof Error` is false for them. Detect the error shape structurally
  // so a cross-realm TypeError still classifies as runtime_error instead of
  // degrading the replay evidence to 'unknown' (SPEC §14 errorType semantics).
  if (typeof err === 'object' && err !== null && Object.prototype.toString.call(err) === '[object Error]') {
    const message = typeof Reflect.get(err, 'message') === 'string' ? Reflect.get(err, 'message') : safeErrorMessage(err);
    const stack = Reflect.get(err, 'stack');
    return {
      errorType: 'runtime_error',
      message: typeof message === 'string' ? message : safeErrorMessage(err),
      ...(typeof stack === 'string' ? { stack } : {}),
    };
  }
  return { errorType: 'unknown', message: safeErrorMessage(err) };
}

function resolveTimeoutMs(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
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
): { result: RuleHostResult | null; error: unknown; timedOut: boolean; threw: boolean } {
  const input = createSyntheticRuleHostInput(
    { toolName: traceCase.toolName, params: traceCase.params },
    traceCase.ruleContext !== undefined ? { context: traceCase.ruleContext } : {},
  );

  const helpers: RuleHostHelpers = {
    isRiskPath: () => input.workspace.isRiskPath,
    getToolName: () => input.action.toolName,
    getEstimatedLineChanges: () => input.derived.estimatedLineChanges,
    getBashRisk: () => input.derived.bashRisk,
    getEpTier: () => input.evolution.epTier,
  };

  const start = Date.now();
  try {
    const result = evaluateFn(input, helpers);
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      return { result: null, error: null, timedOut: true, threw: false };
    }
    return { result, error: null, timedOut: false, threw: false };
  } catch (err) {
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      return { result: null, error: null, timedOut: true, threw: false };
    }
    return { result: null, error: err, timedOut: false, threw: true };
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
      if (!result.correctionProposal) {
        return { passed: false, failureReason: 'auto_correct decision missing correctionProposal' };
      }
      {
        const proposalValidation = validateCorrectionProposal(result.correctionProposal);
        if (!proposalValidation.valid) {
          return { passed: false, failureReason: `correctionProposal invalid: ${proposalValidation.errors.join('; ')}` };
        }
        const proposal = result.correctionProposal;
        const reasons: string[] = [];
        if (traceCase.expectedProposedParams !== undefined) {
          if (!isSafeRecord(traceCase.expectedProposedParams)) {
            reasons.push('expectedProposedParams is not a safe record');
          } else if (!isSafeRecord(proposal.proposedParams)) {
            reasons.push('proposedParams is not a safe record');
          } else {
            try {
              const diffs = diffParams(traceCase.expectedProposedParams, proposal.proposedParams);
              if (diffs.length > 0) {
                reasons.push(`proposedParams mismatch: ${diffs.join('; ')}`);
              }
            } catch (err) {
              reasons.push(`proposedParams comparison failed: ${safeErrorMessage(err)}`);
            }
          }
        }
        if (traceCase.expectedApplicationMode !== undefined) {
          if (proposal.applicationMode !== traceCase.expectedApplicationMode) {
            reasons.push(`applicationMode mismatch: expected ${traceCase.expectedApplicationMode}, got ${proposal.applicationMode}`);
          }
        }
        if (reasons.length > 0) {
          return { passed: false, failureReason: reasons.join('; ') };
        }
      }
      return { passed: true };
    default:
      return { passed: false, failureReason: `Unknown expectedDecision: ${String(traceCase.expectedDecision)}` };
  }
}

/**
 * Evaluate rule code against GoldenTrace cases with structured error reporting.
 *
 * **Timeout semantics**: `softTimeoutMs` is an elapsed-time classification
 * threshold, NOT a hard cancellation mechanism. If `evaluateCode` blocks
 * synchronously (infinite loop, long computation), this wrapper cannot
 * interrupt it — the timeout is only detected after `evaluateCode` returns.
 * Hard cancellation requires `node:vm` or `AbortController` at the
 * plugin/sandbox-adapter layer, which is out of scope for core.
 */
export function evaluateInRefinerSandbox(
  code: string,
  goldenTrace: GoldenTrace,
  deps: RefinerSandboxDependencies & RefinerSandboxOptions,
): RefinerSandboxResult {
  const startTime = Date.now();
  const timeoutMs = resolveTimeoutMs(deps.softTimeoutMs ?? DEFAULT_TIMEOUT_MS);

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
  // fields before execution. Mirrors the check in production-gate-deps.ts.
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
    const { result, error, timedOut, threw } = evaluateCaseWithTimeout(evaluateFn, traceCase, timeoutMs);

    if (timedOut) {
      failedCases.push({
        caseId: traceCase.caseId,
        errorType: 'timeout',
        message: `Evaluation timed out after ${timeoutMs}ms`,
        expectedDecision: traceCase.expectedDecision,
      });
      continue;
    }

    if (threw) {
      const classified = classifyError(error);
      failedCases.push({
        caseId: traceCase.caseId,
        errorType: classified.errorType,
        message: classified.message,
        stack: classified.stack,
        expectedDecision: traceCase.expectedDecision,
      });
      continue;
    }

    if (!result) {
      failedCases.push({
        caseId: traceCase.caseId,
        errorType: 'validation_failed',
        message: 'Evaluator returned null/undefined result',
        expectedDecision: traceCase.expectedDecision,
      });
      continue;
    }

    const validation = validateCaseDecision(traceCase, result);
    if (!validation.passed) {
      failedCases.push({
        caseId: traceCase.caseId,
        errorType: 'validation_failed',
        message: validation.failureReason ?? 'Validation failed',
        expectedDecision: traceCase.expectedDecision,
        // The rule produced a well-formed decision that mismatched — record
        // the real decision. Throws/timeouts above carry NO actualDecision.
        actualDecision: result.decision,
      });
    }
  }

  return {
    success: failedCases.length === 0,
    failedCases,
    executionTimeMs: Date.now() - startTime,
    forbiddenPatternViolations: [],
  };
}
