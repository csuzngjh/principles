// SPEC-PD-EXAMINER-001 v0.4 §5.3A / PRI-1035 — Phase 2a final metrics recomputation suite.
//
// Imports computePhase2aFinalMetrics (pure offline recomputation over frozen
// on-repo evidence, zero network, zero writes) and pins the load-bearing
// invariants of the final adjudication basis:
//   - 60 adopted E envelopes (rounds 7/8/10 = 12/6/42), 36 unique candidateIds, 60 unique taskTexts
//   - mechanical×review failure-set convergence: identical 20-envelope sets (OBS-D1 legacy text)
//   - B1 v2 primary comparator: 36/110 grid, zero duplicates, 36/36 pass
//   - request accounting totals and $0 free-tier metering
//   - determinism: two invocations differ only in generatedAt

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePhase2aFinalMetrics } from '../dev/principle-learning-lab/stage-g-phase2a-final-metrics.mjs';

const labRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dev/principle-learning-lab');
const studyDir = path.join(labRoot, 'challenge-studies', 'CEB-001');

describe('phase 2a final metrics recomputation', () => {
  it('recomputes the full B0/B1/E comparison from frozen evidence (offline, no writes)', { timeout: 120_000 }, () => {
    const { report } = computePhase2aFinalMetrics({ studyDir });
    // envelope accounting
    expect(report.eArmEnvelopeAccounting.adoptedTotal).toBe(60);
    expect(report.eArmEnvelopeAccounting.byRound).toEqual({ round7: 12, round8: 6, round10: 42 });
    expect(report.eArmEnvelopeAccounting.uniqueCandidateIds).toBe(36);
    expect(report.eArmEnvelopeAccounting.uniqueTaskTexts).toBe(60);
    expect(report.eArmEnvelopeAccounting.manualRevisionEvents).toBe(0);
    // arms
    const [b0, b1, e] = report.arms;
    expect(b0.arm).toBe('B0');
    expect(b1.arm).toBe('B1v2');
    expect(e.arm).toBe('E');
    expect(b0.validatorPass).toBe('36/36');
    expect(b1.validatorPass).toBe('36/36');
    expect(b1.paramGridCoverage.validOnly).toBe('36/110');
    expect(b1.duplicates).toEqual({ exact: 0, structural: 0, skeleton: 0 });
    expect(b0.duplicates.structural).toBe(12);
    expect(e.validatorPass).toBe('40/60');
    expect(e.paramGridCoverage.submitted).toBe('17/110');
    expect(e.leakGuardFailures).toBe(20);
    expect(e.mechanismFacetsCovered).toHaveLength(8);
    // convergence: identical failure sets, cross-proved by two independent methods
    expect(report.mechanicalReviewConvergence.identicalFailureSets).toBe(true);
    expect(report.mechanicalReviewConvergence.mechanicalValidatorFailures).toBe(20);
    expect(report.mechanicalReviewConvergence.reviewCriticalGateFailures).toBe(20);
    // request accounting
    expect(report.requestAccounting.grand.requestsResulted).toBe(141);
    expect(report.requestAccounting.grand.succeeded).toBe(11);
    expect(report.requestAccounting.grand.failedKnown).toBe(105);
    expect(report.requestAccounting.grand.resultUnknown).toBe(25);
    expect(report.requestAccounting.grand.meterings).toEqual({ free_tier_zero_cost: 11 });
    // eight required metrics
    const m = report.eightRequiredMetrics;
    expect(m.validRatio.E_reviewCriticalGate).toBe('40/60');
    expect(m.humanRevisionMinutes.status).toBe('NOT_MEASURED');
    expect(m.humanRevisionMinutes.manualRevisionEvents).toBe(0);
    expect(m.costPerValidCandidate.modelBudgetCostUsd).toBe(0);
    expect(m.costPerValidCandidate.candidateProducingSucceededRequests).toBe(10);
    expect(m.costPerValidCandidate.requestsPerAdoptedEnvelope).toBeCloseTo(2.35, 1);
    expect(m.decisionVariableDiversity.E_B1_substantiveOverlap).toBe(0);
    expect(m.nearDuplicateRate.E_reviewNonDuplicationPass).toBe('12/40');
    expect(m.goldLeakRate.E_mechanicalLeakGuard).toBe(20);
    // blind review cross-check block carried with limitations
    expect(report.blindReviewCrossCheck.allDimensionsPass).toBe(11);
    expect(report.blindReviewCrossCheck.counts.candidateCount).toBe(60);
  });

  it('is deterministic: two invocations produce identical values except generatedAt', { timeout: 180_000 }, () => {
    const t0 = '2026-10-28T00:00:00.000Z';
    const a = computePhase2aFinalMetrics({ studyDir, now: () => t0 });
    const b = computePhase2aFinalMetrics({ studyDir, now: () => t0 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
