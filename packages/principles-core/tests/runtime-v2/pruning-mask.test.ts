import { describe, it, expect } from 'vitest';
import type { PruningReviewRecord } from '../../src/runtime-v2/pruning-review-log.js';
import { buildMaskedPrincipleSet } from '../../src/runtime-v2/pruning-mask.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReview(overrides: Partial<PruningReviewRecord> = {}): PruningReviewRecord {
  return {
    reviewId: overrides.reviewId ?? 'rv-001',
    principleId: overrides.principleId ?? 'P_001',
    decision: overrides.decision ?? 'archive-candidate',
    note: overrides.note ?? 'test',
    reviewer: overrides.reviewer ?? 'operator',
    reviewedAt: overrides.reviewedAt ?? '2026-05-01T00:00:00.000Z',
    signalSnapshot: overrides.signalSnapshot ?? {
      principleId: 'P_001',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      derivedCandidateIds: [],
      derivedPainCount: 0,
      matchedCandidateCount: 0,
      recentCandidateCount: 0,
      orphanCandidateCount: 0,
      ageDays: 120,
      riskLevel: 'review',
      reasons: ['review: old'],
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildMaskedPrincipleSet', () => {
  it('includes principle with archive-candidate decision', () => {
    const reviews = [makeReview({ principleId: 'P1', decision: 'archive-candidate' })];
    const result = buildMaskedPrincipleSet(reviews);
    expect(result).toEqual(new Set(['P1']));
  });

  it('excludes principle with keep decision', () => {
    const reviews = [makeReview({ principleId: 'P1', decision: 'keep' })];
    const result = buildMaskedPrincipleSet(reviews);
    expect(result).toEqual(new Set());
  });

  it('excludes principle with defer decision', () => {
    const reviews = [makeReview({ principleId: 'P1', decision: 'defer' })];
    const result = buildMaskedPrincipleSet(reviews);
    expect(result).toEqual(new Set());
  });

  it('LWW: later keep overrides earlier archive-candidate', () => {
    const reviews = [
      makeReview({ principleId: 'P1', decision: 'archive-candidate', reviewedAt: '2026-05-01T00:00:00.000Z' }),
      makeReview({ principleId: 'P1', decision: 'keep', reviewedAt: '2026-05-02T00:00:00.000Z' }),
    ];
    const result = buildMaskedPrincipleSet(reviews);
    expect(result).toEqual(new Set());
  });

  it('LWW: later archive-candidate overrides earlier keep', () => {
    const reviews = [
      makeReview({ principleId: 'P1', decision: 'keep', reviewedAt: '2026-05-01T00:00:00.000Z' }),
      makeReview({ principleId: 'P1', decision: 'archive-candidate', reviewedAt: '2026-05-02T00:00:00.000Z' }),
    ];
    const result = buildMaskedPrincipleSet(reviews);
    expect(result).toEqual(new Set(['P1']));
  });

  it('returns empty set for empty input', () => {
    const result = buildMaskedPrincipleSet([]);
    expect(result).toEqual(new Set());
  });

  it('skips corrupt records without crashing', () => {
    const reviews = [
      {} as unknown as PruningReviewRecord,
      { garbage: true } as unknown as PruningReviewRecord,
      makeReview({ principleId: 'P1', decision: 'archive-candidate' }),
    ];
    const result = buildMaskedPrincipleSet(reviews);
    expect(result).toEqual(new Set(['P1']));
  });

  it('handles multiple principles with mixed decisions', () => {
    const reviews = [
      makeReview({ principleId: 'P1', decision: 'archive-candidate' }),
      makeReview({ principleId: 'P2', decision: 'keep' }),
      makeReview({ principleId: 'P3', decision: 'defer' }),
    ];
    const result = buildMaskedPrincipleSet(reviews);
    expect(result).toEqual(new Set(['P1']));
  });
});
