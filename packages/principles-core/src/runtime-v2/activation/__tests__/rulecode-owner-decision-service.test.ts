import { describe, expect, it, vi } from 'vitest';
import { RuleCodeOwnerDecisionService } from '../rulecode-owner-decision-service.js';
import type {
  OwnerPromotionActor,
  PromotionCommitInput,
  PromotionReadinessResult,
} from '../rulecode-owner-decision-service.js';

const actor: OwnerPromotionActor = {
  principal: { kind: 'configured_owner', ownerId: 'owner-1' },
  authentication: { method: 'cli_owner_credential', credentialId: 'credential-1' },
  operator: { kind: 'local_user', operatorId: 'Administrator' },
};

const ready: PromotionReadinessResult = {
  status: 'ready',
  evaluationId: 'readiness-1',
  artifactId: 'artifact-1',
  artifactDigest: 'sha256:artifact',
  evidenceSnapshot: {
    snapshotId: 'snapshot-1',
    snapshotDigest: 'sha256:snapshot',
    artifactDigest: 'sha256:artifact',
    lineageRefs: ['task-1', 'run-1'],
    hostRuntimeVersion: 'openclaw@1',
    safetyGateResults: [{ checkId: 'host_liveness', status: 'passed' }],
    shadowSummary: { observed: 20, matched: 3, wouldBlock: 1, wouldAllow: 19, requireApproval: 0, autoCorrect: 0, errors: 0, neutralControl: 1, firstObservedAt: '2026-08-20T00:00:00.000Z', lastObservedAt: '2026-08-21T00:00:00.000Z' },
    configurationVersion: 'config-v1',
    redaction: { version: 'redaction-v1', rawParametersStored: false },
    createdAt: '2026-08-21T02:00:00.000Z',
  },
  failedChecks: [],
};

function service(input?: {
  ownerEnabled?: boolean;
  safetyEnabled?: boolean;
  readiness?: PromotionReadinessResult;
}) {
  const commitPromotion = vi.fn(async (_value: PromotionCommitInput) => ({
    activationId: 'activation-1', decisionId: 'decision-1', promotedAt: '2026-08-21T02:01:00.000Z',
  }));
  return {
    commitPromotion,
    instance: new RuleCodeOwnerDecisionService({
      ownerLiveDecisionEnabled: () => input?.ownerEnabled ?? true,
      safetyControlsEnabled: () => input?.safetyEnabled ?? true,
      evaluateReadiness: async () => input?.readiness ?? ready,
      commitPromotion,
      newDecisionId: () => 'decision-1',
      now: () => '2026-08-21T02:01:00.000Z',
    }),
  };
}

const request = {
  activationId: 'activation-1',
  expectedArtifactId: 'artifact-1',
  expectedArtifactDigest: 'sha256:artifact',
  expectedControlVersion: 1,
  idempotencyKey: 'promote-activation-1-v1',
  reasonCode: 'owner_accepts_shadow_evidence',
  note: 'Reviewed shadow evidence and host-liveness results.',
  confirmed: true,
};

describe('RuleCodeOwnerDecisionService promotion authority', () => {
  it('refuses promotion when the Owner decision feature is disabled without calling legacy mutation', async () => {
    const { instance, commitPromotion } = service({ ownerEnabled: false });
    await expect(instance.promote(request, actor)).resolves.toMatchObject({
      ok: false, reasonCode: 'feature_not_enabled', nextAction: expect.stringContaining('rulecode_owner_live_decision'),
    });
    expect(commitPromotion).not.toHaveBeenCalled();
  });

  it('refuses promotion when safety authority is unavailable', async () => {
    const { instance, commitPromotion } = service({ safetyEnabled: false });
    await expect(instance.promote(request, actor)).resolves.toMatchObject({
      ok: false, reasonCode: 'safety_controls_unavailable', nextAction: expect.any(String),
    });
    expect(commitPromotion).not.toHaveBeenCalled();
  });

  it('refuses local break-glass identity from writing an Owner governance decision', async () => {
    const { instance, commitPromotion } = service();
    await expect(instance.promote(request, {
      principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' },
      authentication: { method: 'local_break_glass' },
    })).resolves.toMatchObject({ ok: false, reasonCode: 'owner_authentication_required' });
    expect(commitPromotion).not.toHaveBeenCalled();
  });

  it('refuses blocked or unavailable readiness without committing', async () => {
    for (const status of ['blocked', 'unavailable'] as const) {
      const { instance, commitPromotion } = service({ readiness: {
        ...ready, status, failedChecks: [{ checkId: 'host_liveness', reasonCode: 'host_contract_unavailable' }],
      } });
      await expect(instance.promote(request, actor)).resolves.toMatchObject({
        ok: false, reasonCode: status === 'blocked' ? 'promotion_safety_gate_blocked' : 'promotion_readiness_unavailable',
        failedChecks: [{ checkId: 'host_liveness', reasonCode: 'host_contract_unavailable' }],
      });
      expect(commitPromotion).not.toHaveBeenCalled();
    }
  });

  it('requires a note for every CLI Owner promotion before readiness evaluation', async () => {
    const { instance, commitPromotion } = service();
    await expect(instance.promote({ ...request, note: '   ' }, actor)).resolves.toMatchObject({
      ok: false, reasonCode: 'cli_owner_note_required', nextAction: expect.stringContaining('note'),
    });
    expect(commitPromotion).not.toHaveBeenCalled();
  });

  it('binds authenticated Owner identity and evidence into the sole atomic commit', async () => {
    const { instance, commitPromotion } = service();
    await expect(instance.promote(request, actor)).resolves.toEqual({
      ok: true, decision: 'promoted', activationId: 'activation-1', decisionId: 'decision-1', promotedAt: '2026-08-21T02:01:00.000Z',
    });
    expect(commitPromotion).toHaveBeenCalledOnce();
    expect(commitPromotion).toHaveBeenCalledWith(expect.objectContaining({
      expectedControlVersion: 1,
      idempotencyKey: 'promote-activation-1-v1',
      evidenceSnapshot: ready.evidenceSnapshot,
      decision: expect.objectContaining({
        decisionId: 'decision-1', decision: 'promote_live', principal: actor.principal,
        authentication: actor.authentication, operator: actor.operator,
        evidenceSnapshotId: 'snapshot-1',
      }),
    }));
  });

  it('evaluates a dry-run but never commits a live decision', async () => {
    const { instance, commitPromotion } = service();
    await expect(instance.promote({ ...request, confirmed: false, dryRun: true }, actor)).resolves.toEqual({
      ok: true,
      decision: 'would_promote',
      activationId: 'activation-1',
      readinessEvaluationId: 'readiness-1',
      evidenceSnapshotDigest: 'sha256:snapshot',
    });
    expect(commitPromotion).not.toHaveBeenCalled();
  });

  it('refuses an evidence-insufficient promotion without an approved override reason', async () => {
    const { instance, commitPromotion } = service({ readiness: { ...ready, status: 'evidence_insufficient' } });

    await expect(instance.promote({ ...request, reasonCode: 'looks_safe' }, actor)).resolves.toMatchObject({
      ok: false,
      reasonCode: 'evidence_override_reason_required',
    });
    expect(commitPromotion).not.toHaveBeenCalled();
  });

  it('allows an evidence-insufficient promotion only with a predefined reason and note', async () => {
    const { instance, commitPromotion } = service({ readiness: { ...ready, status: 'evidence_insufficient' } });

    await expect(instance.promote({
      ...request,
      reasonCode: 'controlled_rollout',
      note: 'Limited rollout with immediate emergency controls verified.',
    }, actor)).resolves.toMatchObject({ ok: true, decision: 'promoted' });
    expect(commitPromotion).toHaveBeenCalledOnce();
  });

  it('returns structured refusal with promotion_commit_failed when commitPromotion throws (P0-3)', async () => {
    const failingCommit = vi.fn().mockRejectedValue(new Error('SQLite write failed'));
    const instance = new RuleCodeOwnerDecisionService({
      ownerLiveDecisionEnabled: () => true,
      safetyControlsEnabled: () => true,
      evaluateReadiness: async () => ready,
      commitPromotion: failingCommit,
      newDecisionId: () => 'decision-fail',
      now: () => '2026-08-21T02:01:00.000Z',
    });
    const result = await instance.promote(request, actor);
    expect(result).toMatchObject({
      ok: false,
      reasonCode: 'promotion_commit_failed',
      summary: expect.stringContaining('durable safety store'),
      nextAction: expect.stringContaining('retry'),
    });
    expect(result.ok === false && result.summary.includes('SQLite write failed')).toBe(true);
    expect(failingCommit).toHaveBeenCalledOnce();
  });
});
