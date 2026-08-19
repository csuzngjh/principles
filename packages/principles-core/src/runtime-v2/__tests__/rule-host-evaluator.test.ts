/**
 * PRI-45: Pure decision merge logic for RuleHost
 *
 * Tests for mergeDecisions() — the pure function that iterates
 * loaded implementations and merges their decisions (block short-circuits,
 * requireApproval collects, allow is implicit).
 */
import { describe, it, expect, vi } from 'vitest';
import type { RuleHostInput, RuleHostResult, LoadedImplementation } from '../internalization/rule-host-contracts.js';

// Helpers to build test fixtures

function makeInput(): RuleHostInput {
  return {
    action: { toolName: 'write', normalizedPath: '/foo.ts', paramsSummary: {} },
    workspace: { isRiskPath: false },
    session: { sessionId: 's1', currentGfi: 0, recentThinking: false },
    evolution: { epTier: 0 },
    derived: { estimatedLineChanges: 1, bashRisk: 'unknown' },
  };
}

function makeImpl(overrides: {
  implId?: string;
  ruleId?: string;
  evaluate: (_input: RuleHostInput) => RuleHostResult;
}): LoadedImplementation {
  return {
    implId: overrides.implId ?? 'impl-1',
    ruleId: overrides.ruleId ?? 'R_001',
    meta: { name: 'Test', version: '1.0.0', ruleId: 'R_001', coversCondition: 'test' },
    evaluate: overrides.evaluate,
  };
}

describe('mergeDecisions', () => {
  async function getModule() {
    return import('../internalization/rule-host-evaluator.js');
  }

  // 1. Empty implementations
  it('returns undefined for empty implementations array', async () => {
    const { mergeDecisions } = await getModule();
    expect(mergeDecisions([], makeInput())).toBeUndefined();
  });

  // 2. Single impl with matched: false
  it('returns undefined when all implementations return matched: false', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl({
        evaluate: () => ({ decision: 'allow', matched: false, reason: 'no match' }),
      }),
    ];
    expect(mergeDecisions(impls, makeInput())).toBeUndefined();
  });

  // 3. Single block short-circuits
  it('returns block result when an implementation returns block', async () => {
    const { mergeDecisions } = await getModule();
    const blockResult = { decision: 'block' as const, matched: true, reason: 'dangerous' };
    const impls = [
      makeImpl({ evaluate: () => blockResult }),
    ];
    const result = mergeDecisions(impls, makeInput());
    expect(result).toEqual(blockResult);
  });

  // 4. Single requireApproval
  it('returns merged requireApproval from single approval impl', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl({
        evaluate: () => ({
          decision: 'requireApproval' as const,
          matched: true,
          reason: 'risky write',
          diagnostics: { toolName: 'write' },
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput());
    expect(result?.decision).toBe('requireApproval');
    expect(result?.reason).toBe('risky write');
  });

  // 5. Block short-circuits before later approvals
  it('block takes precedence over earlier collected approvals', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl({
        implId: 'approval-first',
        evaluate: () => ({ decision: 'requireApproval' as const, matched: true, reason: 'needs review' }),
      }),
      makeImpl({
        implId: 'block-second',
        evaluate: () => ({ decision: 'block' as const, matched: true, reason: 'dangerous' }),
      }),
      makeImpl({
        implId: 'never-called',
        evaluate: () => ({ decision: 'allow' as const, matched: true, reason: 'ok' }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput());
    expect(result?.decision).toBe('block');
  });

  // 6. Multiple approvals merged
  it('merges multiple requireApproval results', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl({
        implId: 'a1',
        evaluate: () => ({
          decision: 'requireApproval' as const,
          matched: true,
          reason: 'risky path',
          diagnostics: { path: '/secrets' },
        }),
      }),
      makeImpl({
        implId: 'a2',
        evaluate: () => ({
          decision: 'requireApproval' as const,
          matched: true,
          reason: 'sensitive content',
          diagnostics: { content: 'key' },
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput());
    expect(result?.decision).toBe('requireApproval');
    expect(result?.reason).toBe('risky path; sensitive content');
    expect(result?.diagnostics).toEqual({ approval_0_path: '/secrets', approval_1_content: 'key' });
  });

  // 7. Allow results ignored
  it('allow results are ignored (returns undefined)', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl({
        evaluate: () => ({ decision: 'allow' as const, matched: true, reason: 'safe' }),
      }),
    ];
    expect(mergeDecisions(impls, makeInput())).toBeUndefined();
  });

  // 8. Individual impl throwing — logs warning, continues
  it('logs warning and continues when individual impl throws', async () => {
    const { mergeDecisions } = await getModule();
    const logger = { warn: vi.fn() };
    const impls = [
      makeImpl({
        implId: 'broken',
        evaluate: () => { throw new Error('impl crashed'); },
      }),
      makeImpl({
        implId: 'working',
        evaluate: () => ({
          decision: 'requireApproval' as const,
          matched: true,
          reason: 'still works',
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput(), logger);
    expect(result?.decision).toBe('requireApproval');
    expect(result?.reason).toBe('still works');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn?.mock?.calls?.[0]?.[0]).toContain('broken');
  });

  // 9. Outer error — conservative degradation D-08
  it('returns undefined on outer error (conservative degradation D-08)', async () => {
    const { mergeDecisions } = await getModule();
    const logger = { warn: vi.fn() };
    // Pass a non-array iterable that throws
    const throwingIterable = {
      [Symbol.iterator]: () => { throw new Error('iteration failed'); },
    };
    const result = mergeDecisions(
      throwingIterable as unknown as readonly LoadedImplementation[],
      makeInput(),
      logger,
    );
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  // 10. Logger optional
  it('does not throw when logger is undefined', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl({
        implId: 'broken',
        evaluate: () => { throw new Error('crash'); },
      }),
    ];
    expect(() => mergeDecisions(impls, makeInput())).not.toThrow();
  });

  // 11. Block in first position short-circuits immediately
  it('first block short-circuits before any approvals are collected', async () => {
    const { mergeDecisions } = await getModule();
    let approvalCalled = false;
    const impls = [
      makeImpl({
        implId: 'blocker',
        evaluate: () => ({ decision: 'block' as const, matched: true, reason: 'nope' }),
      }),
      makeImpl({
        implId: 'approver',
        evaluate: () => {
          approvalCalled = true;
          return { decision: 'requireApproval' as const, matched: true, reason: 'wait' };
        },
      }),
    ];
    const result = mergeDecisions(impls, makeInput());
    expect(result?.decision).toBe('block');
    expect(approvalCalled).toBe(false);
  });

  // 12. allow with matched:true returns undefined
  it('allow with matched:true returns undefined (no opinion)', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl({
        evaluate: () => ({ decision: 'allow' as const, matched: true, reason: 'explicit allow' }),
      }),
    ];
    expect(mergeDecisions(impls, makeInput())).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PRI-114: auto_correct merge tests
// ---------------------------------------------------------------------------

describe('mergeDecisions — auto_correct (PRI-114)', () => {
  async function getModule() {
    return import('../internalization/rule-host-evaluator.js');
  }

  function makeInput114(): RuleHostInput {
    return {
      action: { toolName: 'write', normalizedPath: '/foo.ts', paramsSummary: {} },
      workspace: { isRiskPath: false },
      session: { sessionId: 's1', currentGfi: 0, recentThinking: false },
      evolution: { epTier: 0 },
      derived: { estimatedLineChanges: 1, bashRisk: 'unknown' },
    };
  }

  function makeImpl114(overrides: {
    implId?: string;
    ruleId?: string;
    evaluate: (_input: RuleHostInput) => RuleHostResult;
  }): LoadedImplementation {
    return {
      implId: overrides.implId ?? 'impl-1',
      ruleId: overrides.ruleId ?? 'R_001',
      meta: { name: 'Test', version: '1.0.0', ruleId: 'R_001', coversCondition: 'test' },
      evaluate: overrides.evaluate,
    };
  }

  // 13. Single auto_correct returns the proposal
  it('returns auto_correct result when single impl returns auto_correct', async () => {
    const { mergeDecisions } = await getModule();
    const proposal = {
      proposedParams: { content: 'fixed' },
      correctedFields: [{ field: 'content', original: 'broken', proposed: 'fixed', reason: 'fix' }],
      applicationMode: 'shadow' as const,
      confidence: 0.9,
      ruleId: 'R_auto_001',
      notifyAgent: true,
    };
    const impls = [
      makeImpl114({
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'fix typo',
          correctionProposal: proposal,
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114());
    expect(result?.decision).toBe('auto_correct');
    expect(result?.correctionProposal).toEqual(proposal);
  });

  // 14. auto_correct + allow -> auto_correct wins
  it('auto_correct takes precedence over allow', async () => {
    const { mergeDecisions } = await getModule();
    const proposal = {
      proposedParams: { content: 'fixed' },
      correctedFields: [{ field: 'content', original: 'bad', proposed: 'fixed', reason: 'fix' }],
      applicationMode: 'shadow' as const,
      confidence: 0.8,
      ruleId: 'R_auto_002',
      notifyAgent: false,
    };
    const impls = [
      makeImpl114({
        implId: 'allow-1',
        evaluate: () => ({ decision: 'allow' as const, matched: true, reason: 'ok' }),
      }),
      makeImpl114({
        implId: 'ac-1',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'fix content',
          correctionProposal: proposal,
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114());
    expect(result?.decision).toBe('auto_correct');
  });

  // 15. auto_correct + requireApproval -> auto_correct wins
  it('auto_correct takes precedence over requireApproval', async () => {
    const { mergeDecisions } = await getModule();
    const proposal = {
      proposedParams: { content: 'fixed' },
      correctedFields: [{ field: 'content', original: 'bad', proposed: 'fixed', reason: 'fix' }],
      applicationMode: 'shadow' as const,
      confidence: 0.8,
      ruleId: 'R_auto_003',
      notifyAgent: false,
    };
    const impls = [
      makeImpl114({
        implId: 'approval-1',
        evaluate: () => ({ decision: 'requireApproval' as const, matched: true, reason: 'needs review' }),
      }),
      makeImpl114({
        implId: 'ac-1',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'fix it',
          correctionProposal: proposal,
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114());
    expect(result?.decision).toBe('auto_correct');
  });

  // 16. block + auto_correct -> block short-circuits
  it('block short-circuits before auto_correct is evaluated', async () => {
    const { mergeDecisions } = await getModule();
    let acCalled = false;
    const impls = [
      makeImpl114({
        implId: 'blocker',
        evaluate: () => ({ decision: 'block' as const, matched: true, reason: 'dangerous' }),
      }),
      makeImpl114({
        implId: 'ac-never',
        evaluate: () => {
          acCalled = true;
          return {
            decision: 'auto_correct' as const,
            matched: true,
            reason: 'fix',
            correctionProposal: {
              proposedParams: {},
              correctedFields: [],
              applicationMode: 'shadow',
              confidence: 0.5,
              ruleId: 'R_x',
              notifyAgent: false,
            },
          };
        },
      }),
    ];
    const result = mergeDecisions(impls, makeInput114());
    expect(result?.decision).toBe('block');
    expect(acCalled).toBe(false);
  });

  // 17. auto_correct with invalid proposal -> skipped, falls through
  it('invalid auto_correct proposal is skipped with warning', async () => {
    const { mergeDecisions } = await getModule();
    const logger = { warn: vi.fn() };
    const impls = [
      makeImpl114({
        implId: 'bad-ac',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'fix',
          correctionProposal: {
            proposedParams: 'not-an-object' as unknown as Record<string, unknown>,
          } as RuleHostResult['correctionProposal'],
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114(), logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  // 18. auto_correct with missing correctionProposal -> skipped
  it('auto_correct without correctionProposal is skipped with warning', async () => {
    const { mergeDecisions } = await getModule();
    const logger = { warn: vi.fn() };
    const impls = [
      makeImpl114({
        implId: 'no-proposal',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'fix but no proposal',
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114(), logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  // 19. Multiple auto_correct -> first valid one wins
  it('first valid auto_correct proposal wins among multiple', async () => {
    const { mergeDecisions } = await getModule();
    const proposal1 = {
      proposedParams: { content: 'fix1' },
      correctedFields: [{ field: 'content', original: 'bad', proposed: 'fix1', reason: 'first' }],
      applicationMode: 'shadow' as const,
      confidence: 0.7,
      ruleId: 'R_first',
      notifyAgent: false,
    };
    const proposal2 = {
      proposedParams: { content: 'fix2' },
      correctedFields: [{ field: 'content', original: 'bad', proposed: 'fix2', reason: 'second' }],
      applicationMode: 'shadow' as const,
      confidence: 0.8,
      ruleId: 'R_second',
      notifyAgent: true,
    };
    const impls = [
      makeImpl114({
        implId: 'ac-first',
        ruleId: 'R_first',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'first fix',
          correctionProposal: proposal1,
        }),
      }),
      makeImpl114({
        implId: 'ac-second',
        ruleId: 'R_second',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'second fix',
          correctionProposal: proposal2,
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114());
    expect(result?.decision).toBe('auto_correct');
    expect(result?.correctionProposal?.ruleId).toBe('R_first');
  });

  // 20. auto_correct with matched:false -> ignored
  it('auto_correct with matched:false is ignored', async () => {
    const { mergeDecisions } = await getModule();
    const impls = [
      makeImpl114({
        implId: 'unmatched-ac',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: false,
          reason: 'not applicable',
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114());
    expect(result).toBeUndefined();
  });

  // 21. All auto_correct invalid -> falls through to requireApproval
  it('all auto_correct invalid falls through to requireApproval', async () => {
    const { mergeDecisions } = await getModule();
    const logger = { warn: vi.fn() };
    const impls = [
      makeImpl114({
        implId: 'bad-ac',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'fix',
          correctionProposal: { proposedParams: null } as unknown as RuleHostResult['correctionProposal'],
        }),
      }),
      makeImpl114({
        implId: 'approval',
        evaluate: () => ({
          decision: 'requireApproval' as const,
          matched: true,
          reason: 'needs review',
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114(), logger);
    expect(result?.decision).toBe('requireApproval');
  });


  // 22. auto_correct with throwing getter proposal — does not crash merge
  it('auto_correct with throwing getter proposal does not crash mergeDecisions', async () => {
    const { mergeDecisions } = await getModule();
    const logger = { warn: vi.fn() };
    const maliciousProposal = new Proxy({}, {
      get(_target, prop) { if (prop === 'proposedParams') throw new Error('getter boom'); return undefined; }
    });
    const impls = [
      makeImpl114({
        implId: 'malicious',
        evaluate: () => ({
          decision: 'auto_correct' as const,
          matched: true,
          reason: 'fix',
          correctionProposal: maliciousProposal as unknown as RuleHostResult['correctionProposal'],
        }),
      }),
      makeImpl114({
        implId: 'approval-fallback',
        evaluate: () => ({
          decision: 'requireApproval' as const,
          matched: true,
          reason: 'needs review',
        }),
      }),
    ];
    const result = mergeDecisions(impls, makeInput114(), logger);
    // Should not throw, falls through to requireApproval (fail-closed)
    expect(result?.decision).toBe('requireApproval');
    expect(logger.warn).toHaveBeenCalled();
  });

});
