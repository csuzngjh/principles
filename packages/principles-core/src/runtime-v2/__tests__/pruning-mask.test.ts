/**
 * Pruning Mask Tests — Core Package
 *
 * Direct unit tests for the pruning mask module:
 * - buildMaskedPrincipleSet() — pure LWW (Last Write Wins) function
 * - getCachedMaskedPrincipleSet() — TTL-cached wrapper
 * - clearPruningMaskCache() — cache invalidation
 *
 * Tests verify:
 * - Empty/null input → empty set
 * - Single review → correct masking
 * - Multiple reviews for same principle → LWW semantics
 * - Corrupt records → skipped silently
 * - Archive-candidate → masked; keep/defer → not masked
 * - TTL cache: returns cached value within TTL, re-reads after expiry
 * - Cache keyed by workspaceDir
 * - clearPruningMaskCache resets cache state
 *
 * ERR checklist:
 * - ERR-002 / EP-03: corrupt records skipped (fail-safe)
 * - ERR-007 / EP-02: single source for LWW decision
 * - EP-07: cache keyed by workspaceDir prevents cross-workspace leakage
 */

/* eslint-disable @typescript-eslint/max-params */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  buildMaskedPrincipleSet,
  getCachedMaskedPrincipleSet,
  clearPruningMaskCache,
} from '../pruning-mask.js';
import type { PruningReviewRecord, PruningReviewDecision } from '../pruning-review-log.js';

function makeReview(
  principleId: string,
  decision: PruningReviewDecision,
  reviewedAt: string,
  overrides: Partial<PruningReviewRecord> = {},
): PruningReviewRecord {
  return {
    reviewId: `review-${principleId}-${Date.now()}`,
    principleId,
    decision,
    note: 'test note',
    reviewer: 'test-reviewer',
    reviewedAt,
    signalSnapshot: {
      principleId,
      activationCount30d: 0,
      lastTriggeredAt: null,
      painSignalCount: 0,
      confidenceScore: 0.5,
      ageDays: 1,
    },
    ...overrides,
  };
}

describe('buildMaskedPrincipleSet', () => {
  it('returns empty set for null input', () => {
    const result = buildMaskedPrincipleSet(null as unknown as PruningReviewRecord[]);
    expect(result.size).toBe(0);
  });

  it('returns empty set for empty array', () => {
    const result = buildMaskedPrincipleSet([]);
    expect(result.size).toBe(0);
  });

  it('masks principles with archive-candidate decision', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      makeReview('p2', 'keep', '2026-07-01T00:00:00.000Z'),
      makeReview('p3', 'defer', '2026-07-01T00:00:00.000Z'),
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(1);
    expect(result.has('p1')).toBe(true);
    expect(result.has('p2')).toBe(false);
    expect(result.has('p3')).toBe(false);
  });

  it('applies LWW semantics: later review overrides earlier one', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      makeReview('p1', 'keep', '2026-07-02T00:00:00.000Z'),
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(0);
    expect(result.has('p1')).toBe(false);
  });

  it('applies LWW semantics: later archive-candidate overrides earlier keep', () => {
    const reviews = [
      makeReview('p1', 'keep', '2026-07-01T00:00:00.000Z'),
      makeReview('p1', 'archive-candidate', '2026-07-02T00:00:00.000Z'),
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(1);
    expect(result.has('p1')).toBe(true);
  });

  it('handles same timestamp: later array entry wins (stable ordering)', () => {
    const reviews = [
      makeReview('p1', 'keep', '2026-07-01T00:00:00.000Z'),
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.has('p1')).toBe(true);
  });

  it('skips corrupt records with missing principleId', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      { ...makeReview('p2', 'archive-candidate', '2026-07-01T00:00:00.000Z'), principleId: '' },
      { ...makeReview('p3', 'archive-candidate', '2026-07-01T00:00:00.000Z'), principleId: undefined as unknown as string },
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(1);
    expect(result.has('p1')).toBe(true);
  });

  it('skips corrupt records with missing decision', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      { ...makeReview('p2', 'archive-candidate', '2026-07-01T00:00:00.000Z'), decision: '' as PruningReviewDecision },
      { ...makeReview('p3', 'archive-candidate', '2026-07-01T00:00:00.000Z'), decision: undefined as unknown as PruningReviewDecision },
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(1);
    expect(result.has('p1')).toBe(true);
  });

  it('skips corrupt records with missing reviewedAt', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      { ...makeReview('p2', 'archive-candidate', '2026-07-01T00:00:00.000Z'), reviewedAt: '' },
      { ...makeReview('p3', 'archive-candidate', '2026-07-01T00:00:00.000Z'), reviewedAt: undefined as unknown as string },
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(1);
    expect(result.has('p1')).toBe(true);
  });

  it('skips null/undefined entries in the array', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      null as unknown as PruningReviewRecord,
      undefined as unknown as PruningReviewRecord,
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(1);
    expect(result.has('p1')).toBe(true);
  });

  it('handles multiple principles with mixed decisions', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      makeReview('p2', 'keep', '2026-07-01T00:00:00.000Z'),
      makeReview('p3', 'defer', '2026-07-01T00:00:00.000Z'),
      makeReview('p4', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      makeReview('p2', 'archive-candidate', '2026-07-02T00:00:00.000Z'),
      makeReview('p4', 'keep', '2026-07-03T00:00:00.000Z'),
    ];

    const result = buildMaskedPrincipleSet(reviews);

    expect(result.size).toBe(2);
    expect(result.has('p1')).toBe(true);
    expect(result.has('p2')).toBe(true);
    expect(result.has('p3')).toBe(false);
    expect(result.has('p4')).toBe(false);
  });

  it('returns a new Set instance each call (no shared mutable state)', () => {
    const reviews = [makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z')];

    const result1 = buildMaskedPrincipleSet(reviews);
    const result2 = buildMaskedPrincipleSet(reviews);

    expect(result1).not.toBe(result2);
    result1.add('p999');
    expect(result2.has('p999')).toBe(false);
  });
});

describe('getCachedMaskedPrincipleSet', () => {
  let tmpDir: string;
  let stateDir: string;
  let logPath: string;

  beforeEach(() => {
    clearPruningMaskCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pruning-mask-test-'));
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    logPath = path.join(stateDir, 'pruning_reviews.jsonl');
  });

  function writeReviews(reviews: PruningReviewRecord[]): void {
    const lines = reviews.map(r => JSON.stringify(r));
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');
  }

  it('reads from file and returns correct mask on first call', () => {
    const reviews = [
      makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z'),
      makeReview('p2', 'keep', '2026-07-01T00:00:00.000Z'),
    ];
    writeReviews(reviews);

    const result = getCachedMaskedPrincipleSet(tmpDir);

    expect(result.size).toBe(1);
    expect(result.has('p1')).toBe(true);
    expect(result.has('p2')).toBe(false);
  });

  it('returns cached value within TTL (no re-read)', () => {
    const reviews = [makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z')];
    writeReviews(reviews);

    const result1 = getCachedMaskedPrincipleSet(tmpDir, 60_000);

    const updatedReviews = [makeReview('p1', 'keep', '2026-07-02T00:00:00.000Z')];
    writeReviews(updatedReviews);

    const result2 = getCachedMaskedPrincipleSet(tmpDir, 60_000);

    expect(result2.has('p1')).toBe(true);
    expect(result2).toBe(result1);
  });

  it('re-reads after TTL expires', () => {
    vi.useFakeTimers();

    const reviews = [makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z')];
    writeReviews(reviews);

    const result1 = getCachedMaskedPrincipleSet(tmpDir, 1000);
    expect(result1.has('p1')).toBe(true);

    const updatedReviews = [makeReview('p1', 'keep', '2026-07-02T00:00:00.000Z')];
    writeReviews(updatedReviews);

    vi.advanceTimersByTime(500);
    const result2 = getCachedMaskedPrincipleSet(tmpDir, 1000);
    expect(result2.has('p1')).toBe(true);

    vi.advanceTimersByTime(600);
    const result3 = getCachedMaskedPrincipleSet(tmpDir, 1000);
    expect(result3.has('p1')).toBe(false);

    vi.useRealTimers();
  });

  it('cache is keyed by workspaceDir', () => {
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pruning-mask-other-'));
    const otherStateDir = path.join(otherDir, '.state');
    fs.mkdirSync(otherStateDir, { recursive: true });
    const otherLogPath = path.join(otherStateDir, 'pruning_reviews.jsonl');

    const reviews1 = [makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z')];
    writeReviews(reviews1);

    const reviews2 = [makeReview('p1', 'keep', '2026-07-01T00:00:00.000Z')];
    fs.writeFileSync(otherLogPath, reviews2.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const result1 = getCachedMaskedPrincipleSet(tmpDir);
    const result2 = getCachedMaskedPrincipleSet(otherDir);

    expect(result1.has('p1')).toBe(true);
    expect(result2.has('p1')).toBe(false);
  });

  it('returns empty set when no pruning_reviews.jsonl exists', () => {
    fs.rmSync(logPath, { force: true });

    const result = getCachedMaskedPrincipleSet(tmpDir);

    expect(result.size).toBe(0);
  });
});

describe('clearPruningMaskCache', () => {
  let tmpDir: string;
  let stateDir: string;
  let logPath: string;

  beforeEach(() => {
    clearPruningMaskCache();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pruning-mask-clear-'));
    stateDir = path.join(tmpDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    logPath = path.join(stateDir, 'pruning_reviews.jsonl');
  });

  function writeReviews(reviews: PruningReviewRecord[]): void {
    const lines = reviews.map(r => JSON.stringify(r));
    fs.writeFileSync(logPath, lines.join('\n') + '\n', 'utf-8');
  }

  it('clears cache so next call re-reads from disk', () => {
    const reviews = [makeReview('p1', 'archive-candidate', '2026-07-01T00:00:00.000Z')];
    writeReviews(reviews);

    const result1 = getCachedMaskedPrincipleSet(tmpDir);
    expect(result1.has('p1')).toBe(true);

    const updatedReviews = [makeReview('p1', 'keep', '2026-07-02T00:00:00.000Z')];
    writeReviews(updatedReviews);

    clearPruningMaskCache();

    const result2 = getCachedMaskedPrincipleSet(tmpDir);
    expect(result2.has('p1')).toBe(false);
  });

  it('is safe to call when cache is already empty', () => {
    expect(() => clearPruningMaskCache()).not.toThrow();
    expect(() => clearPruningMaskCache()).not.toThrow();
  });
});
