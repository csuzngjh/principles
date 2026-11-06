/**
 * GoldenTrace Replay Validator - Pure replay validation for generated L2 rules
 *
 * PRI-115: Before L2 registration, generated rule code must pass replay
 * against GoldenTrace cases. This module provides the pure validation logic.
 *
 * TRUST BOUNDARY:
 *   - Pure functions only, zero side effects
 *   - No filesystem, VM, process, or network access
 *   - Sandbox loading is injected via the adapter layer
 */

import type { GoldenTraceCase, GoldenTraceDecision } from './golden-trace.js';
import type { RuleHostDecision, RuleHostInput, RuleHostResult } from './internalization/rule-host-contracts.js';
import type { RuleHostHelpers } from './internalization/rule-host-helpers.js';
import type { ToolSemanticRegistry } from './internalization/tool-semantic-registry.js';
import { createSyntheticRuleHostInput } from './golden-trace.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReplayValidatorCaseResult {
  caseId: string;
  passed: boolean;
  expectedDecision: GoldenTraceDecision;
  actualDecision: RuleHostDecision | 'error' | 'non_deterministic';
  failureReason?: string;
  repairHint?: string;
  proposedParamsMatch?: boolean;
  proposedParamsDiff?: string[];
  applicationModeMatch?: boolean;
}

export interface ReplayValidatorResult {
  passed: boolean;
  totalCases: number;
  passedCases: number;
  failedCases: number;
  perCaseResults: readonly ReplayValidatorCaseResult[];
  failureReasons: readonly string[];
  repairHints: readonly string[];
}

export interface ReplayValidatorConfig {
  maxRepairAttempts: number;
  /**
   * Project directory for path normalization (PRI-439 Phase 3).
   * When provided, Golden Trace replay produces non-null `normalizedPath`
   * values that match the production OpenClaw Gate, enabling path-based
   * rules to be validated in replay.
   * When not provided, `normalizedPath` falls back to `null` (legacy behavior).
   */
  projectDir?: string;
  /**
   * PRI-634-F Phase 2: the ToolSemanticRegistry used by the production gate.
   * When provided, replay resolves `canonicalKind` from the same registry and
   * derives identical bash/write extraction hints (replay/production input
   * parity). Absent → legacy behavior (no canonicalKind, no derived hints).
   */
  toolSemantics?: ToolSemanticRegistry;
}

export const DEFAULT_REPLAY_VALIDATOR_CONFIG: ReplayValidatorConfig = {
  maxRepairAttempts: 0,
};

export type ReplayEvaluateFn = (
  input: RuleHostInput,
  helpers: RuleHostHelpers,
) => RuleHostResult;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOLDEN_TO_HOST_BLOCK_ACCEPT: ReadonlySet<RuleHostDecision> = new Set(['block', 'requireApproval']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeObjectKeys(obj: Record<string, unknown>): string[] | null {
  try {
    return Object.keys(obj);
  } catch {
    return null;
  }
}

export function diffParams(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): string[] {
  const diffs: string[] = [];
  const expectedKeys = safeObjectKeys(expected);
  if (!expectedKeys) {
    diffs.push('cannot enumerate expected keys');
    return diffs;
  }
  const actualKeys = safeObjectKeys(actual);
  if (!actualKeys) {
    diffs.push('cannot enumerate actual keys');
    return diffs;
  }
  const expectedKeySet = new Set(expectedKeys);
  const actualKeySet = new Set(actualKeys);
  const allKeys = new Set([...expectedKeys, ...actualKeys]);
  for (const key of allKeys) {
    const inExpected = expectedKeySet.has(key);
    const inActual = actualKeySet.has(key);
    if (!inActual) {
      diffs.push(`missing field "${key}"`);
    } else if (!inExpected) {
      diffs.push(`unexpected field "${key}"`);
    } else {
      try {
        const expectedJson = JSON.stringify(expected[key]);
        const actualJson = JSON.stringify(actual[key]);
        if (expectedJson !== actualJson) {
          diffs.push(`field "${key}": expected ${expectedJson}, got ${actualJson}`);
        }
      } catch {
        diffs.push(`field "${key}": comparison failed (possibly circular reference)`);
      }
    }
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Per-case validation
// ---------------------------------------------------------------------------

function validateAllowCase(
  base: ReplayValidatorCaseResult,
  result: RuleHostResult,
): ReplayValidatorCaseResult {
  const passed = result.decision === 'allow' || result.matched === false;
  return {
    ...base,
    passed,
    failureReason: passed ? undefined : `Expected allow but got ${result.decision}`,
    repairHint: passed ? undefined : 'Rule incorrectly blocks or intervenes on benign input',
  };
}
function validateBlockCase(
  base: ReplayValidatorCaseResult,
  result: RuleHostResult,
): ReplayValidatorCaseResult {
  const passed = GOLDEN_TO_HOST_BLOCK_ACCEPT.has(result.decision);
  return {
    ...base,
    passed,
    failureReason: passed ? undefined : `Expected block but got ${result.decision}`,
    repairHint: passed ? undefined : 'Rule failed to block harmful input -- check condition matching',
  };
}
function validateProposeCorrectionCase(
  base: ReplayValidatorCaseResult,
  result: RuleHostResult,
  traceCase: GoldenTraceCase,
): ReplayValidatorCaseResult {
  if (result.decision !== 'auto_correct') {
    return {
      ...base,
      passed: false,
      failureReason: `Expected auto_correct (propose_correction) but got ${result.decision}`,
      repairHint: 'Rule must return auto_correct decision with correctionProposal',
    };
  }

  const proposal = result.correctionProposal;
  if (!proposal) {
    return {
      ...base,
      passed: false,
      failureReason: 'auto_correct decision missing correctionProposal',
      repairHint: 'Return correctionProposal with proposedParams when decision is auto_correct',
    };
  }

  const perCase: ReplayValidatorCaseResult = { ...base, passed: true };

  if (traceCase.expectedProposedParams) {
    const diffs = diffParams(
      traceCase.expectedProposedParams,
      proposal.proposedParams,
    );
    perCase.proposedParamsMatch = diffs.length === 0;
    perCase.proposedParamsDiff = diffs.length > 0 ? diffs : undefined;
    if (diffs.length > 0) {
      perCase.passed = false;
      perCase.failureReason = `proposedParams mismatch: ${diffs.join('; ')}`;
      perCase.repairHint = 'Ensure correctionProposal.proposedParams matches expected corrected params';
    }
  }

  if (traceCase.expectedApplicationMode) {
    perCase.applicationModeMatch = proposal.applicationMode === traceCase.expectedApplicationMode;
    if (!perCase.applicationModeMatch) {
      perCase.passed = false;
      perCase.failureReason = (perCase.failureReason ? perCase.failureReason + '; ' : '') +
        `applicationMode mismatch: expected ${traceCase.expectedApplicationMode}, got ${proposal.applicationMode}`;
      perCase.repairHint = (perCase.repairHint ? perCase.repairHint + '; ' : '') +
        'Set correctionProposal.applicationMode to match expected mode';
    }
  }

  return perCase;
}
function validateCase(
  evaluateFn: ReplayEvaluateFn,
  traceCase: GoldenTraceCase,
  options: { projectDir?: string; toolSemantics?: ToolSemanticRegistry } = {},
): ReplayValidatorCaseResult {
  const { projectDir, toolSemantics } = options;
  const input = createSyntheticRuleHostInput(
    { toolName: traceCase.toolName, params: traceCase.params },
    traceCase.ruleContext !== undefined ? { context: traceCase.ruleContext } : {},
    projectDir || toolSemantics
      ? { ...(projectDir ? { projectDir } : {}), ...(toolSemantics ? { toolSemantics } : {}) }
      : {},
  );

  const baseResult: ReplayValidatorCaseResult = {
    caseId: traceCase.caseId,
    passed: false,
    expectedDecision: traceCase.expectedDecision,
    actualDecision: 'error',
  };

  const evalOutcome = (() => {
    const helpers: RuleHostHelpers = {
      isRiskPath: () => input.workspace.isRiskPath,
      getToolName: () => input.action.toolName,
      getEstimatedLineChanges: () => input.derived.estimatedLineChanges,
      getBashRisk: () => input.derived.bashRisk,
      getEpTier: () => input.evolution.epTier,
    };
    try {
      return { ok: true as const, value: evaluateFn(input, helpers) };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  })();

  if (!evalOutcome.ok) {
    return {
      ...baseResult,
      actualDecision: 'error',
      failureReason: `evaluate() threw: ${evalOutcome.error}`,
      repairHint: 'Ensure evaluate() handles all input shapes without throwing',
    };
  }

  const result = evalOutcome.value;
  const caseResult = {
    ...baseResult,
    actualDecision: result.decision,
  };

  switch (traceCase.expectedDecision) {
    case 'allow':
      return validateAllowCase(caseResult, result);
    case 'block':
      return validateBlockCase(caseResult, result);
    case 'propose_correction':
      return validateProposeCorrectionCase(caseResult, result, traceCase);
    default:
      return {
        ...baseResult,
        failureReason: `Unknown expectedDecision: ${String(traceCase.expectedDecision)}`,
      };
  }
}




// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export function replayGoldenTrace(
  evaluateFn: ReplayEvaluateFn,
  cases: readonly GoldenTraceCase[],
  config?: Partial<ReplayValidatorConfig>,
): ReplayValidatorResult {
  const _config = { ...DEFAULT_REPLAY_VALIDATOR_CONFIG, ...config };

  if (cases.length === 0) {
    return {
      passed: true,
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      perCaseResults: [],
      failureReasons: [],
      repairHints: [],
    };
  }

  const perCaseResults = cases.map((traceCase) => validateCase(evaluateFn, traceCase, {
    ...(_config.projectDir !== undefined ? { projectDir: _config.projectDir } : {}),
    ...(_config.toolSemantics !== undefined ? { toolSemantics: _config.toolSemantics } : {}),
  }));
  const passedCases = perCaseResults.filter((r) => r.passed).length;
  const failedCases = perCaseResults.length - passedCases;
  const failureReasons = perCaseResults
    .filter((r) => !r.passed && r.failureReason)
    .map((r) => `[${r.caseId}] ${r.failureReason ?? ''}`);
  const repairHints = perCaseResults
    .filter((r) => !r.passed && r.repairHint)
    .map((r) => r.repairHint ?? '');

  void _config.maxRepairAttempts;

  return {
    passed: failedCases === 0,
    totalCases: perCaseResults.length,
    passedCases,
    failedCases,
    perCaseResults,
    failureReasons,
    repairHints,
  };
}
