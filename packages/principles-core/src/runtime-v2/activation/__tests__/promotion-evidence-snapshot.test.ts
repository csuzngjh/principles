import { describe, expect, it } from 'vitest';
import {
  buildPromotionEvidenceSnapshot,
  computeArtifactDigest,
  normalizeOwnerIdentity,
} from '../promotion-evidence-snapshot.js';
import type { PIArtifactSnapshot } from '../activation-types.js';

const sampleArtifact: PIArtifactSnapshot = {
  artifactId: 'artifact-1',
  artifactKind: 'rule',
  sourceTaskId: 'task-100',
  lineageArtifactIds: ['parent-1', 'parent-2'],
  validationStatus: 'validated',
  contentJson: '{"code":"console.log()"}',
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:00:00.000Z',
};

describe('promotion-evidence-snapshot factory', () => {
  it('computes deterministic digest given identical inputs and fixed clock', () => {
    const input = {
      activationId: 'act-123',
      evaluationId: 'eval-456',
      checks: [{ checkId: 'bounded_scope', status: 'passed' as const }],
      artifact: sampleArtifact,
      ownerIdentity: {
        principal: { kind: 'configured_owner' as const, ownerId: 'wesley' },
        authentication: { method: 'cli_owner_credential' as const, credentialId: 'cred-1' },
      },
      hostRuntimeVersion: 'openclaw-legacy@1',
      now: () => '2026-08-21T12:00:00.000Z',
      newSnapshotId: () => 'snapshot-fixed',
    };

    const snap1 = buildPromotionEvidenceSnapshot(input);
    const snap2 = buildPromotionEvidenceSnapshot(input);

    expect(snap1.snapshotId).toBe('snapshot-fixed');
    expect(snap1.snapshotDigest).toBe(snap2.snapshotDigest);
    expect(snap1.artifactDigest).toBe(computeArtifactDigest(sampleArtifact));
    expect(snap1.lineageRefs).toEqual(['task-100', 'parent-1', 'parent-2']);
    expect(snap1.redaction).toEqual({ version: 'v1', rawParametersStored: false });
  });

  it('changes digest when activationId or evaluationId changes', () => {
    const base = {
      activationId: 'act-1',
      evaluationId: 'eval-1',
      checks: [{ checkId: 'bounded_scope', status: 'passed' as const }],
      now: () => '2026-08-21T12:00:00.000Z',
    };

    const snapBase = buildPromotionEvidenceSnapshot(base);
    const snapDiffAct = buildPromotionEvidenceSnapshot({ ...base, activationId: 'act-2' });
    const snapDiffEval = buildPromotionEvidenceSnapshot({ ...base, evaluationId: 'eval-2' });

    expect(snapBase.snapshotDigest).not.toBe(snapDiffAct.snapshotDigest);
    expect(snapBase.snapshotDigest).not.toBe(snapDiffEval.snapshotDigest);
  });

  it('changes digest when lineageRefs change (lineage is digest-bound)', () => {
    const base = {
      activationId: 'act-1',
      evaluationId: 'eval-1',
      checks: [{ checkId: 'bounded_scope', status: 'passed' as const }],
      artifact: sampleArtifact,
      now: () => '2026-08-21T12:00:00.000Z',
    };

    const snapBase = buildPromotionEvidenceSnapshot(base);
    const snapDiffLineage = buildPromotionEvidenceSnapshot({
      ...base,
      artifact: { ...sampleArtifact, lineageArtifactIds: ['parent-1'] },
      // explicit override must win over the derived list, so both differ
      lineageRefs: ['task-100', 'parent-9'],
    });
    const snapExplicit = buildPromotionEvidenceSnapshot({ ...base, lineageRefs: ['task-100', 'parent-1', 'parent-2'] });

    expect(snapBase.lineageRefs).toEqual(['task-100', 'parent-1', 'parent-2']);
    expect(snapBase.snapshotDigest).not.toBe(snapDiffLineage.snapshotDigest);
    expect(snapBase.snapshotDigest).toBe(snapExplicit.snapshotDigest);
  });

  it('changes digest when owner identity or runtime version changes', () => {
    const base = {
      activationId: 'act-1',
      evaluationId: 'eval-1',
      checks: [{ checkId: 'bounded_scope', status: 'passed' as const }],
      ownerIdentity: { principalKind: 'configured_owner', actorId: 'wesley', authenticationMethod: 'cli_owner_credential' },
      hostRuntimeVersion: 'openclaw-legacy@1',
      now: () => '2026-08-21T12:00:00.000Z',
    };

    const snapBase = buildPromotionEvidenceSnapshot(base);
    const snapDiffOwner = buildPromotionEvidenceSnapshot({
      ...base,
      ownerIdentity: { principalKind: 'configured_owner', actorId: 'other_user', authenticationMethod: 'cli_owner_credential' },
    });
    const snapDiffRuntime = buildPromotionEvidenceSnapshot({
      ...base,
      hostRuntimeVersion: 'openclaw-v2',
    });

    expect(snapBase.snapshotDigest).not.toBe(snapDiffOwner.snapshotDigest);
    expect(snapBase.snapshotDigest).not.toBe(snapDiffRuntime.snapshotDigest);
  });

  it('normalizes owner identity from OwnerPromotionActor', () => {
    const actor = {
      principal: { kind: 'configured_owner' as const, ownerId: 'wesley' },
      authentication: { method: 'console_token' as const, credentialId: 'tok-abc' },
    };
    const normalized = normalizeOwnerIdentity(actor);
    expect(normalized).toEqual({
      principalKind: 'configured_owner',
      actorId: 'wesley',
      authenticationMethod: 'console_token',
      credentialId: 'tok-abc',
    });
  });
});
