import { describe, expect, it } from 'vitest';
import {
  REQUIRED_PROMOTION_CHECK_IDS,
  evaluateRuleCodePromotionReadiness,
  type PromotionEvidenceSnapshot,
} from '../index.js';

const snapshot: PromotionEvidenceSnapshot = {
  snapshotId: 'snap-1',
  snapshotDigest: 'sha256:snapshot',
  artifactDigest: 'sha256:artifact',
  lineageRefs: ['task-1', 'run-1'],
  hostRuntimeVersion: 'openclaw@1',
  safetyGateResults: [],
    shadowSummary: { observed: 20, matched: 3, wouldBlock: 1, wouldAllow: 19, requireApproval: 0, autoCorrect: 0, errors: 0, neutralControl: 1, firstObservedAt: '2026-08-20T00:00:00.000Z', lastObservedAt: '2026-08-21T00:00:00.000Z' },
  configurationVersion: 'config-v1',
  redaction: { version: 'v1', rawParametersStored: false },
  createdAt: '2026-08-21T00:00:00.000Z',
};

function passingChecks() {
  return REQUIRED_PROMOTION_CHECK_IDS.map(checkId => ({ checkId, status: 'passed' as const }));
}

describe('evaluateRuleCodePromotionReadiness', () => {
  it('returns ready only when every required hard check is present and passed', () => {
    const result = evaluateRuleCodePromotionReadiness({
      evaluationId: 'eval-1', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact',
      evidenceSnapshot: snapshot, checks: passingChecks(),
    });

    expect(result.status).toBe('ready');
    expect(result.failedChecks).toEqual([]);
    expect(result.evidenceSnapshot.safetyGateResults).toHaveLength(REQUIRED_PROMOTION_CHECK_IDS.length);
  });

  it('blocks when a hard Host Liveness check fails', () => {
    const checks = passingChecks().map(check => check.checkId === 'host_liveness_composition'
      ? { ...check, status: 'failed' as const, reasonCode: 'neutral_probe_blocked' }
      : check);
    const result = evaluateRuleCodePromotionReadiness({
      evaluationId: 'eval-2', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact',
      evidenceSnapshot: snapshot, checks,
    });

    expect(result.status).toBe('blocked');
    expect(result.failedChecks).toEqual([{ checkId: 'host_liveness_composition', reasonCode: 'neutral_probe_blocked' }]);
  });

  it('is unavailable when a required check is absent instead of treating missing evidence as pass', () => {
    const result = evaluateRuleCodePromotionReadiness({
      evaluationId: 'eval-3', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact',
      evidenceSnapshot: snapshot,
      checks: passingChecks().filter(check => check.checkId !== 'runtime_shadow_evidence'),
    });

    expect(result.status).toBe('unavailable');
    expect(result.failedChecks).toEqual([{ checkId: 'runtime_shadow_evidence', reasonCode: 'required_check_missing' }]);
  });

  it('rejects an evidence snapshot bound to a different artifact digest', () => {
    const result = evaluateRuleCodePromotionReadiness({
      evaluationId: 'eval-4', artifactId: 'artifact-1', artifactDigest: 'sha256:different',
      evidenceSnapshot: snapshot, checks: passingChecks(),
    });

    expect(result.status).toBe('unavailable');
    expect(result.failedChecks).toContainEqual({ checkId: 'evidence_binding', reasonCode: 'artifact_digest_mismatch' });
  });

  it('reports an observable reason when the shadow telemetry source is unavailable', () => {
    const result = evaluateRuleCodePromotionReadiness({
      evaluationId: 'eval-no-telemetry', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact',
      evidenceSnapshot: {
        ...snapshot,
        shadowSummary: {
          observed: null, matched: null, wouldBlock: null, wouldAllow: null,
          requireApproval: null, autoCorrect: null, errors: null, neutralControl: null,
          firstObservedAt: null, lastObservedAt: null,
        },
      },
      checks: passingChecks(),
    });

    expect(result.status).toBe('unavailable');
    expect(result.failedChecks).toContainEqual({
      checkId: 'runtime_shadow_evidence',
      reasonCode: 'shadow_telemetry_source_unavailable',
    });
  });

  it.each([
    ['less than 24 hours', { firstObservedAt: '2026-08-20T00:00:00.001Z' }],
    ['fewer than 20 eligible evaluations', { observed: 19 }],
    ['fewer than 3 matches', { matched: 2 }],
    ['no neutral-control sample', { neutralControl: 0 }],
  ])('keeps promotion evidence-insufficient when %s', (_name, shadowSummary) => {
    const result = evaluateRuleCodePromotionReadiness({
      evaluationId: 'eval-insufficient', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact',
      evidenceSnapshot: { ...snapshot, shadowSummary: { ...snapshot.shadowSummary, ...shadowSummary } },
      checks: passingChecks(),
    });

    expect(result.status).toBe('evidence_insufficient');
    expect(result.failedChecks).toEqual([]);
  });

  it('turns unresolved unhealthy shadow evidence into a non-overridable hard failure', () => {
    const result = evaluateRuleCodePromotionReadiness({
      evaluationId: 'eval-unhealthy', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact',
      evidenceSnapshot: { ...snapshot, shadowSummary: { ...snapshot.shadowSummary, errors: 1 } },
      checks: passingChecks(),
    });

    expect(result.status).toBe('blocked');
    expect(result.failedChecks).toContainEqual({
      checkId: 'runtime_shadow_evidence',
      reasonCode: 'unresolved_shadow_unhealthy_evidence',
    });
  });
});
