import { describe, expect, it } from 'vitest';
import { computeDecisionReadiness, gapAnchorId, type DecisionReadinessInput } from '../../src/ui/utils/approval-readiness.js';

const ready: DecisionReadinessInput = {
  status: 'pending',
  hasSubject: true,
  artifactState: 'present',
  exactBodyAvailable: true,
  materialAvailability: 'available',
  revisionMatches: true,
  revisionReviewUnavailable: false,
  materialBlockCount: 0,
  sourceUnlinked: false,
};

describe('computeDecisionReadiness — Owner decisions 2026-11-11', () => {
  it('makes 批准 primary when every material is present', () => {
    const result = computeDecisionReadiness(ready);
    expect(result.missing).toEqual([]);
    expect(result.approveReady).toBe(true);
    expect(result.primary).toBe('approve');
    expect(result.recommendation).toBe('approve');
  });

  it('Owner decision 1: incomplete material disables approve and makes 「查看缺什么」 primary', () => {
    const result = computeDecisionReadiness({
      ...ready,
      materialAvailability: 'partial',
      exactBodyAvailable: false,
    });
    expect(result.approveReady).toBe(false);
    expect(result.canApprove).toBe(false);
    expect(result.primary).toBe('look_at_gaps');
    expect(result.recommendation).toBe('none');
    expect(result.missing.map(item => item.key)).toEqual(['body', 'material']);
    // Fixable gaps must be presented as something the Owner can close.
    expect(result.missing.every(item => item.fixable)).toBe(true);
  });

  it('Owner decision 2: recommends 拒绝 when the only blockers cannot be fixed here', () => {
    const result = computeDecisionReadiness({
      ...ready,
      revisionMatches: false,
      sourceUnlinked: true,
    });
    expect(result.approveReady).toBe(false);
    expect(result.primary).toBe('reject');
    expect(result.recommendation).toBe('reject');
    expect(result.canReject).toBe(true);
  });

  it('does not recommend reject when a fixable gap is also present', () => {
    const result = computeDecisionReadiness({
      ...ready,
      revisionMatches: false,
      exactBodyAvailable: false,
    });
    expect(result.primary).toBe('look_at_gaps');
    expect(result.recommendation).toBe('none');
    expect(result.missing.some(item => item.fixable)).toBe(true);
  });

  it('respects backend-allowed actions', () => {
    const result = computeDecisionReadiness({ ...ready, allowedActions: ['reject'] });
    expect(result.canApprove).toBe(false);
    // Approve is not allowed at all, so the surface must not offer it.
    expect(result.approveReady).toBe(false);
    expect(result.canReject).toBe(true);
    expect(result.primary).toBe('look_at_gaps');
  });

  it('offers no decision for a non-pending approval', () => {
    const result = computeDecisionReadiness({ ...ready, status: 'approved' });
    expect(result.primary).toBe('none');
    expect(result.missing).toEqual([]);
    expect(result.canApprove).toBe(false);
  });

  it('counts backend material gates as a gap', () => {
    const result = computeDecisionReadiness({ ...ready, materialBlockCount: 2 });
    expect(result.approveReady).toBe(false);
    expect(result.missing.map(item => item.key)).toContain('gate');
  });

  it('keeps reading order stable for the gap list', () => {
    const result = computeDecisionReadiness({
      ...ready,
      hasSubject: false,
      artifactState: 'missing',
      exactBodyAvailable: false,
      materialAvailability: 'unavailable',
    });
    expect(result.missing.map(item => item.key)).toEqual(['subject', 'artifact', 'body', 'material']);
  });

  it('produces DOM anchors for the 「查看缺什么」 jump', () => {
    expect(gapAnchorId('material')).toBe('approval-gap-material');
  });
});
