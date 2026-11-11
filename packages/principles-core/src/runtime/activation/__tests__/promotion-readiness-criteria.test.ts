import { describe, expect, it } from 'vitest';
import {
  PROMOTION_EVIDENCE_THRESHOLDS,
  REQUIRED_PROMOTION_CHECK_IDS,
  evaluatePromotionEvidenceCriteria,
  evaluateRuleCodePromotionReadiness,
  explainPromotionReadiness,
  projectPromotionReadinessCriteria,
  type PromotionEvidenceCriterion,
  type PromotionEvidenceCriterionId,
  type PromotionEvidenceSnapshot,
  type PromotionReadinessCheck,
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

function evaluate(snapshot: PromotionEvidenceSnapshot, checks: PromotionReadinessCheck[] = passingChecks()) {
  return evaluateRuleCodePromotionReadiness({
    evaluationId: 'eval-criteria',
    artifactId: 'artifact-1',
    artifactDigest: 'sha256:artifact',
    evidenceSnapshot: snapshot,
    checks,
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

const ONE_SHORT_CASES: {
  criterionId: PromotionEvidenceCriterionId;
  shadowSummary: Partial<PromotionEvidenceSnapshot['shadowSummary']>;
  expectedCurrent: number;
  expectedThreshold: number;
}[] = [
  {
    criterionId: 'shadow_observed',
    shadowSummary: { observed: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1 },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples,
  },
  {
    criterionId: 'shadow_matched',
    shadowSummary: { matched: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples - 1 },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples - 1,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minMatchedSamples,
  },
  {
    criterionId: 'shadow_neutral_control',
    shadowSummary: { neutralControl: PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples - 1 },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples - 1,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minNeutralControlSamples,
  },
  {
    criterionId: 'shadow_age',
    shadowSummary: {
      firstObservedAt: new Date(
        Date.parse(CREATED_AT) - (PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs - ONE_HOUR_MS),
      ).toISOString(),
    },
    expectedCurrent: PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs - ONE_HOUR_MS,
    expectedThreshold: PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs,
  },
];

// Labels and shortfalls are derived too: a literal "19 against 20" or a literal
// "1" here would be a second truth that silently lies once a threshold changes.
const ONE_SHORT = ONE_SHORT_CASES.map(testCase => ({
  ...testCase,
  label: `${testCase.criterionId} at ${testCase.expectedCurrent} against ${testCase.expectedThreshold}`,
  expectedShortfall: testCase.expectedThreshold - testCase.expectedCurrent,
}));

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

  it('never reports a negative shortfall when a criterion is exceeded', () => {
    const snapshot = snapshotWith({ observed: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples + 5 });
    const entry = criterion(evaluatePromotionEvidenceCriteria(snapshot), 'shadow_observed');

    expect(entry.current).toBe(PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples + 5);
    expect(Object.hasOwn(entry, 'shortfall')).toBe(false);
    expect(evaluate(snapshot).status).toBe('ready');
  });

  it('treats a missing first observation as a full age shortfall, not as satisfied', () => {
    const snapshot = snapshotWith({ firstObservedAt: null });
    const entry = criterion(evaluatePromotionEvidenceCriteria(snapshot), 'shadow_age');

    expect(entry.current).toBeNull();
    expect(entry.shortfall).toBe(PROMOTION_EVIDENCE_THRESHOLDS.minShadowAgeMs);
    expect(evaluate(snapshot).status).toBe('evidence_insufficient');
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

describe('promotion readiness criteria projection', () => {
  it('projects exactly one line per required hard check plus the measured evidence', () => {
    const result = evaluate(snapshotWith());
    const criteria = result.criteria ?? [];
    const hardChecks = criteria.filter(item => item.kind === 'hard_check');
    const evidence = criteria.filter(item => item.kind === 'evidence');

    expect(hardChecks.map(item => item.criterionId)).toEqual([...REQUIRED_PROMOTION_CHECK_IDS]);
    expect(hardChecks.every(item => item.status === 'passed')).toBe(true);
    expect(evidence.map(item => item.criterionId)).toEqual([
      'shadow_observed',
      'shadow_matched',
      'shadow_neutral_control',
      'shadow_age',
    ]);
    expect(evidence.every(item => item.status === 'passed')).toBe(true);
  });

  it('keeps a blocked result blocked and names the failing check with its reason', () => {
    const checks: PromotionReadinessCheck[] = REQUIRED_PROMOTION_CHECK_IDS.map(checkId => ({
      checkId,
      ...(checkId === 'golden_trace'
        ? { status: 'failed' as const, reasonCode: 'hard_check_failed' }
        : { status: 'passed' as const }),
    }));
    const result = evaluate(snapshotWith(), checks);

    expect(result.status).toBe('blocked');
    expect((result.criteria ?? []).filter(item => item.kind === 'hard_check' && item.status !== 'passed')).toEqual([
      { criterionId: 'golden_trace', kind: 'hard_check', status: 'failed', reasonCode: 'hard_check_failed' },
    ]);
    expect((result.criteria ?? []).some(item => item.kind === 'evidence' && item.status === 'passed')).toBe(true);
  });

  it('marks checks the evaluation never reached as not_evaluated instead of passed', () => {
    const projected = projectPromotionReadinessCriteria({
      safetyGateResults: [{ checkId: 'activation_eligibility', status: 'failed', reasonCode: 'activation_not_unique' }],
      failedChecks: [{ checkId: 'activation_eligibility', reasonCode: 'activation_not_unique' }],
      evidenceSnapshot: snapshotWith({
        observed: null, matched: null, neutralControl: null, firstObservedAt: null, lastObservedAt: null,
      }),
    });

    expect(projected).toHaveLength(REQUIRED_PROMOTION_CHECK_IDS.length);
    expect(projected[0]).toEqual({
      criterionId: 'activation_eligibility', kind: 'hard_check', status: 'failed', reasonCode: 'activation_not_unique',
    });
    expect(projected.slice(1).every(item => item.status === 'not_evaluated')).toBe(true);
  });

  it('honours an evaluator-recorded duplicate failure over a passing gate result', () => {
    const checks = passingChecks();
    const projected = projectPromotionReadinessCriteria({
      safetyGateResults: checks,
      failedChecks: [{ checkId: 'runtime_shadow_evidence', reasonCode: 'duplicate_check_result' }],
      evidenceSnapshot: snapshotWith(),
    });

    expect(projected.find(item => item.criterionId === 'runtime_shadow_evidence')).toEqual({
      criterionId: 'runtime_shadow_evidence', kind: 'hard_check', status: 'failed', reasonCode: 'duplicate_check_result',
    });
  });

  it('does not invent evidence lines while the telemetry source is unavailable', () => {
    const result = evaluate(snapshotWith({
      observed: null, matched: null, neutralControl: null, firstObservedAt: null, lastObservedAt: null,
    }));

    expect(result.status).toBe('unavailable');
    expect((result.criteria ?? []).filter(item => item.kind === 'evidence')).toEqual([]);
    expect(result.criteria).toContainEqual({
      criterionId: 'runtime_shadow_evidence', kind: 'hard_check', status: 'failed',
      reasonCode: 'shadow_telemetry_source_unavailable',
    });
  });

  it('reports the shortfall next to the measured value without changing the verdict', () => {
    const result = evaluate(snapshotWith({
      observed: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1,
    }));

    expect(result.status).toBe('evidence_insufficient');
    expect((result.criteria ?? []).find(item => item.criterionId === 'shadow_observed')).toEqual({
      criterionId: 'shadow_observed',
      kind: 'evidence',
      status: 'failed',
      current: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples - 1,
      threshold: PROMOTION_EVIDENCE_THRESHOLDS.minObservedSamples,
      shortfall: 1,
    });
  });
});
