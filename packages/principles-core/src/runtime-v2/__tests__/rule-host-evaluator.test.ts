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
    workspace: { isRiskPath: false, planStatus: 'NONE', hasPlanFile: false },
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
  it('block short-circuits even if later impls would return requireApproval', async () => {
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
    expect(result?.diagnostics).toEqual({ path: '/secrets', content: 'key' });
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
