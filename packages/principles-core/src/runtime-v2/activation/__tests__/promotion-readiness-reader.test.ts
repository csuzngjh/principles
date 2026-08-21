import { describe, expect, it } from 'vitest';
import { PromotionReadinessReader, REQUIRED_PROMOTION_CHECK_IDS } from '../index.js';
import type { ActivationStatusRecord, PIArtifactSnapshot } from '../index.js';

const activation: ActivationStatusRecord = {
  activationId: 'act-1', idempotencyKey: 'key-1', artifactId: 'art-1', channel: 'code_tool_hook',
  action: 'code_tool_hook_shadow_activate', targetRef: 'impl://rule-1', activatedAt: '2026-08-21T00:00:00Z', deactivatedAt: null,
};
const artifact: PIArtifactSnapshot = {
  artifactId: 'art-1', artifactKind: 'rule', sourceTaskId: 'task-1', lineageArtifactIds: ['parent-1'],
  validationStatus: 'validated', contentJson: '{"implementationCode":"code"}',
  createdAt: '2026-08-21T00:00:00Z', updatedAt: '2026-08-21T00:00:00Z',
};

describe('PromotionReadinessReader', () => {
  it('returns granular unavailable checks when host facts are absent', async () => {
    const reader = new PromotionReadinessReader({
      listCodeToolHookActivations: async () => [activation],
      getArtifactById: async () => artifact,
      computeArtifactDigest: () => 'sha256:artifact',
      validateProductionArtifact: async () => ({ ok: true, riskLevel: 'high' }),
      collectHostChecks: async () => [],
      buildEvidenceSnapshot: checks => ({
        snapshotId: 'snap-1', snapshotDigest: 'sha256:snapshot', artifactDigest: 'sha256:artifact',
        lineageRefs: ['task-1', 'parent-1'], hostRuntimeVersion: 'unavailable', safetyGateResults: checks,
        shadowSummary: { observed: 0, matched: 0, wouldBlock: 0, wouldAllow: 0, requireApproval: 0, autoCorrect: 0, errors: 0, neutralControl: 0, firstObservedAt: null, lastObservedAt: null }, configurationVersion: 'config-v1',
        redaction: { version: 'v1', rawParametersStored: false }, createdAt: '2026-08-21T00:00:00Z',
      }),
      newEvaluationId: () => 'eval-1',
    });

    const result = await reader.evaluate({ activationId: 'act-1', expectedArtifactId: 'art-1', expectedArtifactDigest: 'sha256:artifact' });

    expect(result.status).toBe('unavailable');
    expect(result.failedChecks.map(check => check.checkId)).toEqual(
      expect.arrayContaining(REQUIRED_PROMOTION_CHECK_IDS.filter(id => !['activation_eligibility', 'lineage_binding', 'production_compile_load', 'golden_trace'].includes(id))),
    );
  });

  it('blocks a stale artifact binding before production validation', async () => {
    let validationCalls = 0;
    const reader = new PromotionReadinessReader({
      listCodeToolHookActivations: async () => [activation], getArtifactById: async () => artifact,
      computeArtifactDigest: () => 'sha256:current',
      validateProductionArtifact: async () => { validationCalls += 1; return { ok: true, riskLevel: 'high' }; },
      collectHostChecks: async () => [],
      buildEvidenceSnapshot: checks => ({ snapshotId: 'snap', snapshotDigest: 'digest', artifactDigest: 'sha256:current', lineageRefs: [], hostRuntimeVersion: 'unavailable', safetyGateResults: checks, shadowSummary: { observed: 0, matched: 0, wouldBlock: 0, wouldAllow: 0, requireApproval: 0, autoCorrect: 0, errors: 0, neutralControl: 0, firstObservedAt: null, lastObservedAt: null }, configurationVersion: 'v1', redaction: { version: 'v1', rawParametersStored: false }, createdAt: 'now' }),
      newEvaluationId: () => 'eval-2',
    });

    const result = await reader.evaluate({ activationId: 'act-1', expectedArtifactId: 'art-1', expectedArtifactDigest: 'sha256:stale' });
    expect(result.status).toBe('blocked');
    expect(result.failedChecks).toContainEqual({ checkId: 'lineage_binding', reasonCode: 'artifact_digest_mismatch' });
    expect(validationCalls).toBe(0);
  });
});
