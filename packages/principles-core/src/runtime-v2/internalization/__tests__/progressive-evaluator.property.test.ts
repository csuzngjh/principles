/**
 * Property tests for the progressive evaluator (design §6.5, tasks 9.2–9.3).
 *
 * CP-21: flagged criteria equivalence (flagged ⟺ reasons non-empty; missing
 *         fields → undetermined; required-only filter on missingDimensions)
 * CP-22: deterministic forced sampling (fnv1a32, no Math.random)
 *
 * @see .kiro/specs/internalization-progressive-disclosure/design.md §6.5
 */

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';

import {
  evaluateFlaggedCriteria,
  isForcedStage2,
  fnv1a32,
  IMPLEMENTATION_FIDELITY_THRESHOLD,
  FORCED_STAGE2_SAMPLE_MODULUS,
} from '../progressive-evaluator.js';

// ── CP-21: flagged criteria equivalence ──────────────────────────────────────

describe('CP-21 — flagged criteria equivalence', () => {
  it('flagged === true iff reasons is non-empty', () => {
    // A clearly flagged output: required dim missing.
    const flagged = evaluateFlaggedCriteria({
      compressionFidelity: { missingDimensions: ['riskLevel'], optionalUncovered: [], explanation: '' },
      painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
      implementationFidelity: { score: 0.9 },
    });
    expect(flagged.flagged).toBe(true);
    expect(flagged.reasons).toHaveLength(1);
    expect(flagged.reasons).toContain('missing_dimensions');

    // A clean output: all pass.
    const clean = evaluateFlaggedCriteria({
      compressionFidelity: { missingDimensions: [], optionalUncovered: [], explanation: '' },
      painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
      implementationFidelity: { score: 0.9 },
    });
    expect(clean.flagged).toBe(false);
    expect(clean.reasons).toHaveLength(0);
  });

  it('optional/excluded dims in missingDimensions do NOT trigger flag (required-only)', () => {
    const result = evaluateFlaggedCriteria({
      compressionFidelity: { missingDimensions: ['badDecision', 'strategicPerspective', 'unknownDim'], optionalUncovered: ['badDecision'], explanation: '' },
      painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
      implementationFidelity: { score: 0.9 },
    });
    expect(result.flagged).toBe(false);
    expect(result.reasons).not.toContain('missing_dimensions');
  });

  it('painCoverage.fullyCovered === false triggers flag', () => {
    const result = evaluateFlaggedCriteria({
      compressionFidelity: { missingDimensions: [], optionalUncovered: [], explanation: '' },
      painCoverage: { fullyCovered: false, uncoveredAspects: ['x'], explanation: '' },
      implementationFidelity: { score: 0.9 },
    });
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain('pain_not_fully_covered');
  });

  it('implementationFidelity.score < threshold triggers flag', () => {
    const result = evaluateFlaggedCriteria({
      compressionFidelity: { missingDimensions: [], optionalUncovered: [], explanation: '' },
      painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
      implementationFidelity: { score: IMPLEMENTATION_FIDELITY_THRESHOLD - 0.01 },
    });
    expect(result.flagged).toBe(true);
    expect(result.reasons).toContain('implementation_fidelity_below_threshold');
  });

  it('score exactly at threshold does NOT trigger flag (boundary)', () => {
    const result = evaluateFlaggedCriteria({
      compressionFidelity: { missingDimensions: [], optionalUncovered: [], explanation: '' },
      painCoverage: { fullyCovered: true, uncoveredAspects: [], explanation: '' },
      implementationFidelity: { score: IMPLEMENTATION_FIDELITY_THRESHOLD },
    });
    expect(result.flagged).toBe(false);
  });

  it('missing fields → undetermined (never silent pass, rc-3)', () => {
    const result = evaluateFlaggedCriteria({});
    expect(result.flagged).toBe(false);
    expect(result.undetermined.length).toBeGreaterThan(0);
    expect(result.undetermined).toContain('compressionFidelity');
    expect(result.undetermined).toContain('painCoverage');
    expect(result.undetermined).toContain('implementationFidelity');
  });

  it('non-object input → all undetermined', () => {
    const result = evaluateFlaggedCriteria(null);
    expect(result.flagged).toBe(false);
    expect(result.undetermined).toContain('output_not_object');
  });

  it('property: flagged ⟺ reasons non-empty across random inputs', () => {
    const scoreGen = fc.float({ min: 0, max: 1, noNaN: true });
    const fullyCoveredGen = fc.boolean();
    const missingDimsGen = fc.array(fc.constantFrom('betterDecision', 'rationale', 'riskLevel', 'badDecision', 'strategicPerspective', 'unknownX'));

    fc.assert(
      fc.property(scoreGen, fullyCoveredGen, missingDimsGen, (score, fullyCovered, missingDims) => {
        const result = evaluateFlaggedCriteria({
          compressionFidelity: { missingDimensions: missingDims, optionalUncovered: [], explanation: '' },
          painCoverage: { fullyCovered, uncoveredAspects: [], explanation: '' },
          implementationFidelity: { score },
        });
        // flagged MUST equal reasons.length > 0.
        expect(result.flagged).toBe(result.reasons.length > 0);
      }),
      { numRuns: 200 },
    );
  });

  it('property: adversarial unknown input never throws, always returns a Result', () => {
    const adversarial = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.constant({}),
      fc.array(fc.anything()),
      fc.constant({ __proto__: { polluted: true } }),
    );
    fc.assert(
      fc.property(adversarial, (input) => {
        const result = evaluateFlaggedCriteria(input);
        expect(typeof result.flagged).toBe('boolean');
        expect(Array.isArray(result.reasons)).toBe(true);
        expect(Array.isArray(result.undetermined)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ── CP-22: deterministic forced sampling ─────────────────────────────────────

describe('CP-22 — deterministic forced sampling', () => {
  it('fnv1a32 is deterministic: same input → same output', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(fnv1a32(s)).toBe(fnv1a32(s));
      }),
      { numRuns: 100 },
    );
  });

  it('isForcedStage2 is deterministic: same taskId → same result', () => {
    fc.assert(
      fc.property(fc.string(), (taskId) => {
        expect(isForcedStage2(taskId)).toBe(isForcedStage2(taskId));
      }),
      { numRuns: 100 },
    );
  });

  it('Math.random is NOT used (replacing it with a throwing impl does not affect isForcedStage2)', () => {
    const original = Math.random;
    Math.random = () => { throw new Error('Math.random should not be called'); };
    try {
      for (const taskId of ['', 'a', 'test-123', '🎨', 'x'.repeat(1000)]) {
        expect(() => isForcedStage2(taskId)).not.toThrow();
      }
    } finally {
      Math.random = original;
    }
  });

  it('modulus=1 forces every task; modulus<=0 forces none', () => {
    expect(isForcedStage2('any-task', 1)).toBe(true);
    expect(isForcedStage2('any-task', 0)).toBe(false);
    expect(isForcedStage2('any-task', -1)).toBe(false);
  });

  it('~5% hit rate with default modulus (statistical sanity)', () => {
    let hits = 0;
    const total = 1000;
    for (let i = 0; i < total; i++) {
      if (isForcedStage2(`task-${i}`)) hits++;
    }
    // ~5% ± 3% tolerance for randomness-free deterministic distribution.
    expect(hits).toBeGreaterThan(20);
    expect(hits).toBeLessThan(80);
  });

  it('empty string / Unicode / super-long all produce finite results', () => {
    for (const s of ['', '🎨', 'x'.repeat(10000)]) {
      const hash = fnv1a32(s);
      expect(Number.isFinite(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
    }
  });
});
