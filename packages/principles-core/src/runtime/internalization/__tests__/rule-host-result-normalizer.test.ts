/**
 * B1: normalizeRuleHostResult — the single fail-closed reading of rule output.
 *
 * Proves the contract that replaced three divergent treatments (throw /
 * warn+drop / cast). The counterexample that motivated it is exercised in
 * host-runtime (gate) and openclaw-plugin (legacy RuleHost) suites.
 */
import { describe, it, expect } from 'vitest';
import { normalizeRuleHostResult } from '../rule-host-result-normalizer.js';
import { validateRuleHostResult } from '../rule-host-validator.js';

describe('normalizeRuleHostResult', () => {
  it('returns a valid result unchanged (identity preserved for merge attribution)', () => {
    const valid = { decision: 'block' as const, matched: true, reason: 'deny' };
    expect(normalizeRuleHostResult(valid)).toBe(valid);
  });

  it('leaves a valid matched=false allow untouched', () => {
    const valid = { decision: 'allow' as const, matched: false, reason: 'neutral' };
    const normalized = normalizeRuleHostResult(valid);
    expect(normalized).toBe(valid);
    expect(normalized.degraded).toBeUndefined();
  });

  it('normalizes a contradictory matched=false decision to allow (no opinion)', () => {
    const normalized = normalizeRuleHostResult({ decision: 'auto_correct', matched: false, reason: 'not applicable' });
    expect(normalized).toEqual({ decision: 'allow', matched: false, reason: 'not applicable' });
    expect(normalized.degraded).toBeUndefined();
  });

  it('fails closed for a result missing matched (the real LLM failure mode)', () => {
    const normalized = normalizeRuleHostResult({ decision: 'block', reason: 'deny' });
    expect(normalized.decision).toBe('requireApproval');
    expect(normalized.matched).toBe(true);
    expect(normalized.reason).toBe('invalid RuleHostResult: matched is required');
    expect(normalized.degraded).toEqual({
      reasonCode: 'invalid_result',
      notes: 'matched is required',
    });
  });

  it('fails closed for an unknown decision value instead of dropping the rule', () => {
    const normalized = normalizeRuleHostResult({ decision: 'deny', matched: true, reason: 'deny' });
    expect(normalized.decision).toBe('requireApproval');
    expect(normalized.degraded?.reasonCode).toBe('invalid_result');
    expect(normalized.degraded?.notes).toContain('decision must be one of');
  });

  it('fails closed for non-object output', () => {
    const normalized = normalizeRuleHostResult('block');
    expect(normalized.decision).toBe('requireApproval');
    expect(normalized.degraded?.notes).toBe('result must be a plain object, got string');
  });

  it('produces a result that re-validates (round trip through the trust boundary)', () => {
    const normalized = normalizeRuleHostResult({ decision: 'block' });
    expect(validateRuleHostResult(normalized)).toEqual({ valid: true, errors: [] });
  });

  it('rejects a malformed degraded marker on otherwise valid output', () => {
    const validation = validateRuleHostResult({
      decision: 'requireApproval', matched: true, reason: 'x',
      degraded: { reasonCode: 'something_else' },
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors.join('; ')).toContain('degraded.reasonCode must be "invalid_result"');
  });
});
