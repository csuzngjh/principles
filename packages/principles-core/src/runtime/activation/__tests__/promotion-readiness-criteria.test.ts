import { describe, expect, it } from 'vitest';
import {
  PROMOTION_EVIDENCE_THRESHOLDS,
  REQUIRED_PROMOTION_CHECK_IDS,
  evaluatePromotionEvidenceCriteria,
  evaluateRuleCodePromotionReadiness,
  explainPromotionReadiness,
  type PromotionEvidenceCriterion,
  type PromotionEvidenceCriterionId,
  type PromotionEvidenceSnapshot,
} from '../index.js';

const CREATED_AT = '2026-08-21T00:00:00.000Z';
const ONE_HOUR_MS = 60 * 60 * 1000;

function passingChecks() {
  return REQUIRED_PROMOTION_CHECK_IDS.map(checkId => ({ checkId, status: 'passed' as const }));
}

/**
 * Every numeric fixture value is derived from PROMOTION_EVIDENCE_THRESHOLDS —
 * the same source the evaluator reads. Re-declaring 20 / 3 / 1 / 24h here would
 * turn this file into a second truth for the thresholds.
 */
function snapshotWith(
  overrides: Partial<PromotionEvidenceSnapshot['shadowSummary']> = {},
): PromotionEvidenceSnapshot {
  const createdAtMs = Date.parse(CREATED_AT);
  return {
    snapshotId: 'snap-criteria',
    snapshotDigest: 'sha256:snapshot',
    artifactDigest: 'sha256:artifact',
    lineageRefs: ['task-1'],
    hostRuntimeVersion: 'openclaw@1',
    safetyGateResults: [],
    shadowSummary: {
      observed: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples,
      matched: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples,
      wouldBlock: 1,
      wouldAllow: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1,
      requireApproval: 0,
      autoCorrect: 0,
      errors: 0,
      neutralControl: PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples,
      firstObservedAt: new Date(createdAtMs - PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs).toISOString(),
      lastObservedAt: CREATED_AT,
      ...overrides,
    },
    configurationVersion: 'config-v1',
    redaction: { version: 'v1', rawParametersStored: false },
    createdAt: CREATED_AT,
  };
}

function evaluate(snapshot: PromotionEvidenceSnapshot) {
  return evaluateRuleCodePromotionReadiness({
    evaluationId: 'eval-criteria',
    artifactId: 'artifact-1',
    artifactDigest: 'sha256:artifact',
    evidenceSnapshot: snapshot,
    checks: passingChecks(),
  });
}

function criterion(
  criteria: readonly PromotionEvidenceCriterion[],
  criterionId: PromotionEvidenceCriterionId,
): PromotionEvidenceCriterion {
  const found = criteria.find(item => item.criterionId === criterionId);
  if (!found) throw new Error(`criterion ${criterionId} is missing from the explanation`);
  return found;
}

const ONE_SHORT: {
  criterionId: PromotionEvidenceCriterionId;
  label: string;
  shadowSummary: Partial<PromotionEvidenceSnapshot['shadowSummary']>;
  expectedCurrent: number;
  expectedThreshold: number;
  expectedShortfall: number;
}[] = [
  {
    criterionId: 'shadow_observed',
    label: '19 observed samples against a threshold of 20',
    shadowSummary: { observed: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1 },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples,
    expectedShortfall: 1,
  },
  {
    criterionId: 'shadow_matched',
    label: '2 matched samples against a threshold of 3',
    shadowSummary: { matched: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples - 1 },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples - 1,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples,
    expectedShortfall: 1,
  },
  {
    criterionId: 'shadow_neutral_control',
    label: '0 neutral-control samples against a threshold of 1',
    shadowSummary: { neutralControl: PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples - 1 },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples - 1,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples,
    expectedShortfall: 1,
  },
  {
    criterionId: 'shadow_age',
    label: '23 hours of shadow observation against a threshold of 24 hours',
    shadowSummary: {
      firstObservedAt: new Date(
        Date.parse(CREATED_AT) - (PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs - ONE_HOUR_MS),
      ).toISOString(),
    },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs - ONE_HOUR_MS,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs,
    expectedShortfall: ONE_HOUR_MS,
  },
];

describe('promotion evidence criteria', () => {
  it.each(ONE_SHORT)('reports exactly what is missing for $label', testCase => {
    const snapshot = snapshotWith(testCase.shadowSummary);
    const entry = criterion(evaluatePromotionEvidenceCriteria(snapshot), testCase.criterionId);

    expect(entry.current).toBe(testCase.expectedCurrent);
    expect(entry.threshold).toBe(testCase.expectedThreshold);
    expect(entry.shortfall).toBe(testCase.expectedShortfall);
    expect(evaluate(snapshot).status).toBe('evidence_insufficient');
  });

  it('does not describe a gap when every numeric criterion is met', () => {
    const snapshot = snapshotWith();
    const criteria = evaluatePromotionEvidenceCriteria(snapshot);

    expect(criteria).toHaveLength(4);
    for (const entry of criteria) {
      expect(entry.current).toBeGreaterThanOrEqual(entry.threshold);
      expect(Object.hasOwn(entry, 'shortfall')).toBe(false);
    }
    expect(evaluate(snapshot).status).toBe('ready');
    expect(explainPromotionReadiness(snapshot, 'ready')).toBeNull();
  });

  it('explains gaps only for an evidence-insufficient result', () => {
    const snapshot = snapshotWith({ matched: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples - 1 });

    expect(explainPromotionReadiness(snapshot, 'blocked')).toBeNull();
    expect(explainPromotionReadiness(snapshot, 'unavailable')).toBeNull();

    const explained = explainPromotionReadiness(snapshot, 'evidence_insufficient') ?? [];
    expect(criterion(explained, 'shadow_matched').shortfall).toBe(1);
  });

  it('keeps the telemetry-source-unavailable branch out of the numeric criteria', () => {
    const snapshot = snapshotWith({
      observed: null,
      matched: null,
      neutralControl: null,
      firstObservedAt: null,
      lastObservedAt: null,
    });
    const result = evaluate(snapshot);

    expect(result.status).toBe('unavailable');
    expect(result.failedChecks).toContainEqual({
      checkId: 'runtime_shadow_evidence',
      reasonCode: 'shadow_telemetry_source_unavailable',
    });
    expect(explainPromotionReadiness(snapshot, result.status)).toBeNull();
    expect(evaluatePromotionEvidenceCriteria(snapshot).map(entry => entry.criterionId)).toEqual([
      'shadow_observed',
      'shadow_matched',
      'shadow_neutral_control',
      'shadow_age',
    ]);
  });

  it('defines the four numeric thresholds once, as a frozen source', () => {
    expect(Object.keys(PROMOTION_EVIDENCE_THRESHOLDS).sort()).toEqual([
      'minMatchedSamples',
      'minNeutralControlSamples',
      'minObservedSamples',
      'minShadowAgeMs',
    ]);
    expect(Object.isFrozen(PROMOTION_EVIDENCE_THRESHOLDS)).toBe(true);

    const derived = snapshotWith({ observed: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1 });
    expect(criterion(evaluatePromotionEvidenceCriteria(derived), 'shadow_observed').shortfall).toBe(1);
  });
});
