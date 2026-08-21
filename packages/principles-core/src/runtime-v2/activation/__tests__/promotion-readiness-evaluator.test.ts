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
  shadowSummary: { observed: 20, wouldBlock: 1, errors: 0 },
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
});
