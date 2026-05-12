import { describe, it, expect } from 'vitest';
import { replayGoldenTrace } from '../golden-trace-replay-validator.js';
import type { ReplayEvaluateFn } from '../golden-trace-replay-validator.js';
import type { GoldenTraceCase } from '../golden-trace.js';

// --- Helpers ---

function createBlockBashEvaluate(): ReplayEvaluateFn {
  return () => ({
    decision: 'block' as const,
    matched: true,
    reason: 'bash command blocked',
    confidence: 0.95,
  });
}

function createAlwaysAllowEvaluate(): ReplayEvaluateFn {
  return () => ({
    decision: 'allow' as const,
    matched: false,
    reason: 'no match',
    confidence: 1.0,
  });
}

function createAutoCorrectEvaluate(expectedParams: Record<string, unknown>): ReplayEvaluateFn {
  return () => ({
    decision: 'auto_correct' as const,
    matched: true,
    reason: 'auto-corrected params',
    confidence: 0.9,
    correctionProposal: {
      proposedParams: expectedParams,
      correctedFields: Object.keys(expectedParams).map(k => ({ field: k, original: null, proposed: expectedParams[k], reason: "corrected" })),
      applicationMode: 'shadow' as const,
      confidence: 0.9,
      ruleId: 'test-rule',
      notifyAgent: true,
    },
  });
}

function createBashBlockCases(): GoldenTraceCase[] {
  return [
    {
      caseId: 'neg-bash-rm',
      kind: 'negative',
      toolName: 'bash',
      params: { command: 'rm -rf /' },
      expectedDecision: 'block',
    },
    {
      caseId: 'neg-bash-force',
      kind: 'negative',
      toolName: 'bash',
      params: { command: 'git push --force' },
      expectedDecision: 'block',
    },
    {
      caseId: 'pos-bash-ls',
      kind: 'positive',
      toolName: 'bash',
      params: { command: 'ls -la' },
      expectedDecision: 'allow',
    },
    {
      caseId: 'pos-bash-git-status',
      kind: 'positive',
      toolName: 'bash',
      params: { command: 'git status' },
      expectedDecision: 'allow',
    },
  ];
}

// --- Tests ---

describe('replayGoldenTrace', () => {
  it('valid rule passes all positive and negative cases', () => {
    const _evaluate = createBlockBashEvaluate();
    const cases = createBashBlockCases();
    // For positive cases, block evaluate returns block, but positive expects allow.
    // Need an evaluate that allows safe commands and blocks dangerous ones.
    const smartEvaluate: ReplayEvaluateFn = (input) => {
      const cmd = input?.action?.toolName === 'bash'
        ? (input.action.paramsSummary)?.command as string
        : '';
      if (cmd.includes('rm') || cmd.includes('force')) {
        return { decision: 'block', matched: true, reason: 'dangerous', confidence: 0.95 };
      }
      return { decision: 'allow', matched: false, reason: 'safe', confidence: 1.0 };
    };
    const result = replayGoldenTrace(smartEvaluate, cases);
    expect(result.passed).toBe(true);
    expect(result.totalCases).toBe(4);
    expect(result.passedCases).toBe(4);
    expect(result.failedCases).toBe(0);
  });

  it('false positive blocked: rule that allows negative case fails', () => {
    const evaluate = createAlwaysAllowEvaluate();
    const cases = createBashBlockCases();
    const result = replayGoldenTrace(evaluate, cases);
    expect(result.passed).toBe(false);
    expect(result.failedCases).toBe(2);
    const failedIds = result.perCaseResults.filter(c => !c.passed).map(c => c.caseId);
    expect(failedIds).toContain('neg-bash-rm');
    expect(failedIds).toContain('neg-bash-force');
  });

  it('auto_correct case validates expected proposedParams', () => {
    const expectedParams = { command: 'rm -i /tmp/safe' };
    const evaluate = createAutoCorrectEvaluate(expectedParams);
    const cases: GoldenTraceCase[] = [
      {
        caseId: 'ac-bash-rm',
        kind: 'negative',
        toolName: 'bash',
        params: { command: 'rm -rf /' },
        expectedDecision: 'propose_correction',
        expectedProposedParams: expectedParams,
        expectedApplicationMode: 'shadow',
      },
    ];
    const result = replayGoldenTrace(evaluate, cases);
    expect(result.passed).toBe(true);
    expect(result.perCaseResults[0]?.proposedParamsMatch).toBe(true);
  });

  it('invalid rule returns structured failure with repair hints', () => {
    const badEvaluate: ReplayEvaluateFn = () => {
      throw new Error('rule execution failed');
    };
    const cases = createBashBlockCases();
    const result = replayGoldenTrace(badEvaluate, cases);
    expect(result.passed).toBe(false);
    expect(result.failedCases).toBe(4);
    for (const cr of result.perCaseResults) {
      expect(cr.passed).toBe(false);
      expect(cr.failureReason).toBeTruthy();
    }
  });

  it('mismatched proposedParams fails with diff', () => {
    const expectedParams = { command: 'rm -i /tmp/safe' };
    const wrongParams = { command: 'rm -rf /' };
    const evaluate = createAutoCorrectEvaluate(wrongParams);
    const cases: GoldenTraceCase[] = [
      {
        caseId: 'ac-mismatch',
        kind: 'negative',
        toolName: 'bash',
        params: { command: 'rm -rf /' },
        expectedDecision: 'propose_correction',
        expectedProposedParams: expectedParams,
        expectedApplicationMode: 'shadow',
      },
    ];
    const result = replayGoldenTrace(evaluate, cases);
    expect(result.passed).toBe(false);
    expect(result.perCaseResults[0]?.proposedParamsMatch).toBe(false);
    expect(result.perCaseResults[0]?.proposedParamsDiff).toBeTruthy();
  });

  it('empty cases returns passed=true (backward compat)', () => {
    const evaluate = createBlockBashEvaluate();
    const result = replayGoldenTrace(evaluate, []);
    expect(result.passed).toBe(true);
    expect(result.totalCases).toBe(0);
    expect(result.perCaseResults).toEqual([]);
  });

  it('partial pass reports individual failures', () => {
    const partialEvaluate: ReplayEvaluateFn = (input) => {
      const cmd = input?.action?.toolName === 'bash'
        ? (input.action.paramsSummary)?.command as string
        : '';
      // Blocks rm but allows force push (false negative for force)
      if (cmd.includes('rm')) {
        return { decision: 'block', matched: true, reason: 'dangerous', confidence: 0.95 };
      }
      return { decision: 'allow', matched: false, reason: 'safe', confidence: 1.0 };
    };
    const cases = createBashBlockCases();
    const result = replayGoldenTrace(partialEvaluate, cases);
    expect(result.passed).toBe(false);
    expect(result.passedCases).toBe(3);
    expect(result.failedCases).toBe(1);
    const failed = result.perCaseResults.find(c => !c.passed);
    expect(failed?.caseId).toBe('neg-bash-force');
  });
});
