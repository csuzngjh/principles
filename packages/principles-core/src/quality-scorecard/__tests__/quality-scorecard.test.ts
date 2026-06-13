/**
 * PRI-361 Quality Scorecard — Tests
 */
import { describe, it, expect } from 'vitest';
import {
  RUBRIC_DIMENSIONS,
  RUBRIC_LABELS,
  meetsMvpThreshold,
  type RubricDimension,
  type RubricScore,
} from '../types.js';
import { needsAdjudication, determineFinalLabel, skippedAdjudication } from '../strong-model-gate.js';
import { extractLogStats } from '../data-extractor.js';

// ── Rubric Tests ───────────────────────────────────────────────────

describe('Rubric definitions', () => {
  it('has exactly 7 dimensions (G1-G7)', () => {
    expect(RUBRIC_DIMENSIONS).toHaveLength(7);
    expect(RUBRIC_DIMENSIONS).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']);
  });

  it('every dimension has a label', () => {
    for (const dim of RUBRIC_DIMENSIONS) {
      expect(RUBRIC_LABELS[dim]).toBeTruthy();
    }
  });
});

describe('meetsMvpThreshold', () => {
  const perfectScores: Record<RubricDimension, RubricScore> = {
    G1: 2, G2: 2, G3: 2, G4: 2, G5: 2, G6: 2, G7: 2,
  };

  it('passes with perfect scores', () => {
    expect(meetsMvpThreshold(perfectScores)).toBe(true);
  });

  it('passes when G1=2, G2=2, G5=2, G3=1, total=10', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G3: 1 as RubricScore, G4: 0 as RubricScore, G6: 0 as RubricScore, G7: 0 as RubricScore };
    // total = 2+2+1+0+2+0+0 = 7, not enough
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('passes when G1=2, G2=2, G5=2, G3=1, total=10 exactly', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G3: 1 as RubricScore, G7: 1 as RubricScore };
    // total = 2+2+1+2+2+2+1 = 12
    expect(meetsMvpThreshold(scores)).toBe(true);
  });

  it('fails when G1 < 2', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G1: 1 as RubricScore };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when G2 < 2', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G2: 1 as RubricScore };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when G5 < 2', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G5: 1 as RubricScore };
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when G3 = 0 (must be >= 1)', () => {
    const scores: Record<RubricDimension, RubricScore> = { ...perfectScores, G3: 0 as RubricScore };
    // total = 12, but G3 = 0
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails when total < 10', () => {
    const scores: Record<RubricDimension, RubricScore> = { G1: 2 as RubricScore, G2: 2 as RubricScore, G3: 1 as RubricScore, G4: 0 as RubricScore, G5: 2 as RubricScore, G6: 0 as RubricScore, G7: 0 as RubricScore };
    // total = 7
    expect(meetsMvpThreshold(scores)).toBe(false);
  });

  it('fails with all zeros', () => {
    const zeros = Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 0])) as Record<RubricDimension, RubricScore>;
    expect(meetsMvpThreshold(zeros)).toBe(false);
  });
});

// ── Adjudication Decision Tests ────────────────────────────────────

function makeLocalEval(overrides: Partial<{ totalScore: number; mvpMet: boolean; flags: string[] }> = {}) {
  const allTwos = Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, 2])) as Record<RubricDimension, RubricScore>;
  const allTwosRationales = Object.fromEntries(RUBRIC_DIMENSIONS.map(d => [d, ''])) as Record<RubricDimension, string>;
  return {
    model: 'test-model',
    dimensionScores: allTwos,
    dimensionRationales: allTwosRationales,
    totalScore: overrides.totalScore ?? 14,
    maxScore: 14,
    mvpMet: overrides.mvpMet ?? true,
    flags: overrides.flags ?? [],
  };
}

function makeEpisode(overrides = {}) {
  return {
    episodeId: 'EP-1',
    summary: 'Test episode',
    source: 'manual',
    score: 80,
    severity: 'severe',
    createdAt: '2026-06-12T00:00:00Z',
    evolutionTaskResolution: null,
    linkedPrinciples: [],
    gateBlockCount: 0,
    ...overrides,
  };
}

describe('needsAdjudication', () => {
  it('returns critical when fabricated_evidence flag present', () => {
    const decision = needsAdjudication(makeEpisode(), makeLocalEval({ flags: ['fabricated_evidence'] }));
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('critical');
  });

  it('returns high when MVP not met', () => {
    const local = makeLocalEval({ mvpMet: false, totalScore: 5 });
    // Override dimension scores to have zeros
    local.dimensionScores = { G1: 0 as RubricScore, G2: 2 as RubricScore, G3: 0 as RubricScore, G4: 0 as RubricScore, G5: 0 as RubricScore, G6: 1 as RubricScore, G7: 0 as RubricScore };
    const decision = needsAdjudication(makeEpisode(), local);
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('high');
  });

  it('returns high when totalScore <= 8', () => {
    const local = makeLocalEval({ totalScore: 8, mvpMet: true });
    local.dimensionScores = { G1: 2 as RubricScore, G2: 2 as RubricScore, G3: 1 as RubricScore, G4: 1 as RubricScore, G5: 0 as RubricScore, G6: 1 as RubricScore, G7: 1 as RubricScore };
    const decision = needsAdjudication(makeEpisode(), local);
    expect(decision.shouldAdjudicate).toBe(true);
    expect(decision.priority).toBe('high');
  });

  it('returns low (no adjudication) when score >= 12 with MVP met', () => {
    const decision = needsAdjudication(makeEpisode(), makeLocalEval({ totalScore: 12, mvpMet: true }));
    expect(decision.shouldAdjudicate).toBe(false);
    expect(decision.priority).toBe('low');
  });
});

describe('determineFinalLabel', () => {
  it('returns local-pass when high score and no adjudication', () => {
    const local = makeLocalEval({ totalScore: 13, mvpMet: true });
    const label = determineFinalLabel(local, null);
    expect(label).toBe('local-pass');
  });

  it('returns local-fail when very low score and no adjudication', () => {
    const local = makeLocalEval({ totalScore: 3, mvpMet: false });
    local.dimensionScores = { G1: 0 as RubricScore, G2: 0 as RubricScore, G3: 0 as RubricScore, G4: 1 as RubricScore, G5: 0 as RubricScore, G6: 1 as RubricScore, G7: 1 as RubricScore };
    const label = determineFinalLabel(local, null);
    expect(label).toBe('local-fail');
  });

  it('returns needs-review when moderate score and no adjudication', () => {
    const local = makeLocalEval({ totalScore: 8, mvpMet: false });
    local.dimensionScores = { G1: 2 as RubricScore, G2: 2 as RubricScore, G3: 1 as RubricScore, G4: 0 as RubricScore, G5: 1 as RubricScore, G6: 1 as RubricScore, G7: 1 as RubricScore };
    const label = determineFinalLabel(local, null);
    expect(label).toBe('needs-review');
  });

  it('returns strong model verdict when adjudication is present', () => {
    const local = makeLocalEval({ totalScore: 10, mvpMet: true });
    const adj = { model: 'strong', adjudicationStatus: 'pass' as const, confirmedScores: null, confirmedMvpMet: true, rationale: 'OK', nextAction: null };
    const label = determineFinalLabel(local, adj);
    expect(label).toBe('pass');
  });

  it('returns needs-review when adjudication is skipped', () => {
    const local = makeLocalEval({ totalScore: 8, mvpMet: false });
    const adj = skippedAdjudication('test');
    const label = determineFinalLabel(local, adj);
    expect(label).toBe('needs-review');
  });
});

// ── Log Stats Tests ────────────────────────────────────────────────

describe('extractLogStats', () => {
  it('returns zeros when directory does not exist', () => {
    const stats = extractLogStats('/nonexistent/path');
    expect(stats.totalEvents).toBe(0);
    expect(stats.painSignalCount).toBe(0);
  });
});
