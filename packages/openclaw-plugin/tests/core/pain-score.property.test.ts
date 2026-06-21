/**
 * Property-based tests for Pain Score computation
 *
 * These tests verify INVARIANTS - mathematical properties that MUST hold
 * for ALL possible inputs, not just a few hand-picked examples.
 *
 * Using fast-check for property-based testing.
 *
 * Target functions (packages/openclaw-plugin/src/core/pain.ts):
 *   computePainScore(rc, isSpiral, missingTestCommand, softScore, projectDir?)
 *   painSeverityLabel(painScore, isSpiral?, projectDir?)
 *
 * When projectDir is omitted, ConfigService is bypassed and the default
 * penalties/thresholds apply:
 *   exit_code_penalty = 70, spiral_penalty = 40, missing_test_command_penalty = 30
 *   severity thresholds: high=70, medium=40, low=20
 *
 * All tests below omit projectDir so behavior is deterministic without filesystem I/O.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computePainScore, painSeverityLabel } from '../../src/core/pain';

describe('Property: Pain Score Range Invariant', () => {
  it('score is always in [0, 100] for any rc, flags, and softScore', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -255, max: 255 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: -1000, max: 1000 }),
        (rc, isSpiral, missingTestCommand, softScore) => {
          const score = computePainScore(rc, isSpiral, missingTestCommand, softScore);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
        },
      ),
    );
  });

  it('negative softScore is clamped to a 0 base (never produces a negative score)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1000, max: -1 }),
        fc.integer({ min: -255, max: 255 }),
        fc.boolean(),
        fc.boolean(),
        (softScore, rc, isSpiral, missingTestCommand) => {
          const negativeScore = computePainScore(rc, isSpiral, missingTestCommand, softScore);
          const zeroScore = computePainScore(rc, isSpiral, missingTestCommand, 0);
          // A negative softScore is floored to 0 by Math.max(0, ...), so the
          // resulting pain score must equal the score produced with softScore=0.
          expect(negativeScore).toBe(zeroScore);
          expect(negativeScore).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});

describe('Property: Pain Score Exit Code Consistency', () => {
  it('with all flags false and softScore=0, score is 0 for rc=0 and 70 for rc!=0', () => {
    fc.assert(
      fc.property(fc.integer({ min: -255, max: 255 }), (rc) => {
        const score = computePainScore(rc, false, false, 0);
        if (rc === 0) {
          expect(score).toBe(0);
        } else {
          expect(score).toBe(70);
        }
      }),
    );
  });
});

describe('Property: Pain Score Monotonicity', () => {
  it('non-zero exit code yields >= score than zero exit code (same other inputs)', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: -255, max: 255 }).filter((rc) => rc !== 0),
        (isSpiral, missingTestCommand, softScore, nonZeroRc) => {
          const withZero = computePainScore(0, isSpiral, missingTestCommand, softScore);
          const withNonZero = computePainScore(nonZeroRc, isSpiral, missingTestCommand, softScore);
          expect(withNonZero).toBeGreaterThanOrEqual(withZero);
        },
      ),
    );
  });

  it('isSpiral=true yields >= score than isSpiral=false (same other inputs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -255, max: 255 }),
        fc.boolean(),
        fc.integer({ min: -1000, max: 1000 }),
        (rc, missingTestCommand, softScore) => {
          const withoutSpiral = computePainScore(rc, false, missingTestCommand, softScore);
          const withSpiral = computePainScore(rc, true, missingTestCommand, softScore);
          expect(withSpiral).toBeGreaterThanOrEqual(withoutSpiral);
        },
      ),
    );
  });

  it('missingTestCommand=true yields >= score than missingTestCommand=false (same other inputs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -255, max: 255 }),
        fc.boolean(),
        fc.integer({ min: -1000, max: 1000 }),
        (rc, isSpiral, softScore) => {
          const without = computePainScore(rc, isSpiral, false, softScore);
          const withMissing = computePainScore(rc, isSpiral, true, softScore);
          expect(withMissing).toBeGreaterThanOrEqual(without);
        },
      ),
    );
  });

  it('higher softScore never decreases the score (same other inputs)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -255, max: 255 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: -1000, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (rc, isSpiral, missingTestCommand, softScoreLow, delta) => {
          const softScoreHigh = softScoreLow + delta;
          const low = computePainScore(rc, isSpiral, missingTestCommand, softScoreLow);
          const high = computePainScore(rc, isSpiral, missingTestCommand, softScoreHigh);
          expect(high).toBeGreaterThanOrEqual(low);
        },
      ),
    );
  });
});

describe('Property: Pain Score Cap Invariant', () => {
  it('score saturates at 100 when penalties + softScore exceed 100', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -255, max: 255 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer({ min: 100, max: 1000 }),
        (rc, isSpiral, missingTestCommand, softScore) => {
          const score = computePainScore(rc, isSpiral, missingTestCommand, softScore);
          // softScore alone is already >= 100, and penalties only add, so the
          // result must be clamped to exactly 100.
          expect(score).toBe(100);
        },
      ),
    );
  });
});

describe('Property: Pain Severity Label Consistency', () => {
  it('isSpiral=true always returns "critical" regardless of score', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (score) => {
        expect(painSeverityLabel(score, true)).toBe('critical');
      }),
    );
  });

  it('label is always one of the four canonical values when not spiral', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 1000 }), (score) => {
        const label = painSeverityLabel(score, false);
        expect(['high', 'medium', 'low', 'info']).toContain(label);
      }),
    );
  });

  it('label matches default thresholds (high>=70, medium>=40, low>=20, info<20) when not spiral', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (score) => {
        const label = painSeverityLabel(score, false);
        if (score >= 70) {
          expect(label).toBe('high');
        } else if (score >= 40) {
          expect(label).toBe('medium');
        } else if (score >= 20) {
          expect(label).toBe('low');
        } else {
          expect(label).toBe('info');
        }
      }),
    );
  });

  it('severity label is consistent with computePainScore output (no spiral, no test command, softScore only)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (softScore) => {
        const score = computePainScore(0, false, false, softScore);
        // softScore in [0,100] with no penalties => score === softScore.
        expect(score).toBe(softScore);
        const label = painSeverityLabel(score, false);
        if (score >= 70) {
          expect(label).toBe('high');
        } else if (score >= 40) {
          expect(label).toBe('medium');
        } else if (score >= 20) {
          expect(label).toBe('low');
        } else {
          expect(label).toBe('info');
        }
      }),
    );
  });
});
