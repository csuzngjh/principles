import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteActivationSafetyStore } from '../sqlite-activation-safety-store.js';
import { SqliteActivationStateStore } from '../sqlite-activation-state-store.js';
import type { ActivationDecisionRecord } from '../activation-control-types.js';
import type { PromotionCommitInput } from '../rulecode-owner-decision-service.js';
import type { ActivationStatusRecord } from '../activation-types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pd-activation-safety-'));
  tempDirs.push(dir);
  return dir;
}

function seedArtifact(connection: SqliteConnection): void {
  const db = connection.getDb();
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-1', 'diagnosis', 'pending', ?, ?)")
    .run('2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
  db.prepare(`
    INSERT INTO pi_artifacts
      (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES ('artifact-1', 'rule', 'task-1', '[]', 'passed', '{}', ?, ?)
  `).run('2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
}

function liveActivation(): ActivationStatusRecord {
  return {
    activationId: 'activation-1',
    idempotencyKey: 'activation-1-key',
    artifactId: 'artifact-1',
    channel: 'code_tool_hook',
    action: 'code_tool_hook_live_activate',
    targetRef: 'impl://rule-1',
    activatedAt: '2026-08-21T00:01:00.000Z',
    promotedAt: '2026-08-21T00:02:00.000Z',
    deactivatedAt: null,
  };
}

function isolateDecision(): ActivationDecisionRecord {
  return {
    decisionId: 'decision-1',
    subject: {
      kind: 'activation',
      activationId: 'activation-1',
      artifactId: 'artifact-1',
      artifactDigest: 'sha256:abc123',
    },
    decision: 'safety_isolate',
    principal: { kind: 'system_safety', policyVersion: 'safety-policy-v1' },
    authentication: { method: 'system' },
    reasonCode: 'host_liveness_risk',
    note: 'Synthetic probe observed broad tool blocking.',
    evidenceSnapshotId: 'evidence-1',
    decidedAt: '2026-08-21T00:03:00.000Z',
  };
}

function promotionCommit(): PromotionCommitInput {
  return {
    decision: {
      decisionId: 'decision-promote-1',
      subject: { kind: 'activation', activationId: 'activation-1', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact' },
      decision: 'promote_live',
      principal: { kind: 'configured_owner', ownerId: 'owner-1' },
      authentication: { method: 'cli_owner_credential', credentialId: 'credential-1' },
      operator: { kind: 'local_user', operatorId: 'Administrator' },
      reasonCode: 'owner_accepts_shadow_evidence',
      note: 'Reviewed the evidence.',
      evidenceSnapshotId: 'snapshot-1',
      decidedAt: '2026-08-21T03:00:00.000Z',
    },
    evidenceSnapshot: {
      snapshotId: 'snapshot-1', snapshotDigest: 'sha256:snapshot', artifactDigest: 'sha256:artifact',
      lineageRefs: ['task-1', 'run-1'], hostRuntimeVersion: 'openclaw@1',
      safetyGateResults: [{ checkId: 'host_liveness', status: 'passed' }],
    shadowSummary: { observed: 20, matched: 3, wouldBlock: 1, wouldAllow: 19, requireApproval: 0, autoCorrect: 0, errors: 0, neutralControl: 1, firstObservedAt: '2026-08-20T00:00:00.000Z', lastObservedAt: '2026-08-21T00:00:00.000Z' },
      configurationVersion: 'config-v1', redaction: { version: 'redaction-v1', rawParametersStored: false },
      createdAt: '2026-08-21T02:59:00.000Z',
    },
    readinessEvaluationId: 'readiness-1',
    evidenceSnapshotDigest: 'sha256:snapshot',
    expectedControlVersion: 1,
    idempotencyKey: 'promote-activation-1-v1',
  };
}

describe('SqliteActivationSafetyStore', () => {
  it('initializes an explicit eligible control row for every RuleCode activation', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);

    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());

    await expect(new SqliteActivationSafetyStore(connection).getControlState('activation-1')).resolves.toEqual({
      activationId: 'activation-1',
      enforcement: 'eligible',
      isolationDecisionId: null,
      version: 1,
      updatedAt: '2026-08-21T00:01:00.000Z',
    });
    connection.close();
  });

  it('atomically records an immutable decision and isolates enforcement', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());
    const store = new SqliteActivationSafetyStore(connection);

    await expect(store.safetyIsolate(isolateDecision(), 1)).resolves.toEqual({
      activationId: 'activation-1',
      enforcement: 'safety_isolated',
      isolationDecisionId: 'decision-1',
      version: 2,
      updatedAt: '2026-08-21T00:03:00.000Z',
    });
    await expect(store.listDecisions('activation-1')).resolves.toEqual([isolateDecision()]);

    expect(() => connection.getDb().prepare("UPDATE activation_decisions SET note = 'tampered' WHERE decision_id = 'decision-1'").run())
      .toThrow(/immutable/i);
    expect(() => connection.getDb().prepare("DELETE FROM activation_decisions WHERE decision_id = 'decision-1'").run())
      .toThrow(/immutable/i);
    connection.close();
  });

  it('rolls back the decision when the expected control version is stale', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());
    const store = new SqliteActivationSafetyStore(connection);

    await expect(store.safetyIsolate(isolateDecision(), 9)).rejects.toThrow(/expected version 9/i);
    await expect(store.listDecisions('activation-1')).resolves.toEqual([]);
    await expect(store.getControlState('activation-1')).resolves.toMatchObject({ enforcement: 'eligible', version: 1 });
    connection.close();
  });

  it('rejects decision lineage that does not match the active artifact', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());
    const decision = isolateDecision();
    if (decision.subject.kind !== 'activation') throw new Error('test fixture must target activation');
    const mismatched: ActivationDecisionRecord = {
      ...decision,
      subject: { ...decision.subject, artifactId: 'artifact-other' },
    };

    await expect(new SqliteActivationSafetyStore(connection).safetyIsolate(mismatched, 1))
      .rejects.toThrow(/subject mismatch/i);
    connection.close();
  });

  it('retains safety isolation after the database is closed and reopened', async () => {
    const workspace = makeWorkspace();
    const first = new SqliteConnection(workspace);
    seedArtifact(first);
    await new SqliteActivationStateStore(first).recordActivation(liveActivation());
    await new SqliteActivationSafetyStore(first).safetyIsolate(isolateDecision(), 1);
    first.close();

    const reopened = new SqliteConnection(workspace);
    await expect(new SqliteActivationSafetyStore(reopened).getControlState('activation-1')).resolves.toMatchObject({
      enforcement: 'safety_isolated',
      isolationDecisionId: 'decision-1',
      version: 2,
    });
    reopened.close();
  });

  it('atomically persists evidence and Owner decision while promoting shadow to live', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    const shadow = { ...liveActivation(), action: 'code_tool_hook_shadow_activate' };
    await new SqliteActivationStateStore(connection).recordActivation(shadow);

    await expect(new SqliteActivationSafetyStore(connection).commitPromotion(promotionCommit())).resolves.toEqual({
      activationId: 'activation-1', decisionId: 'decision-promote-1', promotedAt: '2026-08-21T03:00:00.000Z',
    });

    const db = connection.getDb();
    expect(db.prepare("SELECT action, promoted_at FROM activations WHERE activation_id = 'activation-1'").get())
      .toEqual({ action: 'code_tool_hook_live_activate', promoted_at: '2026-08-21T03:00:00.000Z' });
    expect(db.prepare("SELECT snapshot_digest, artifact_digest FROM activation_evidence_snapshots WHERE snapshot_id = 'snapshot-1'").get())
      .toEqual({ snapshot_digest: 'sha256:snapshot', artifact_digest: 'sha256:artifact' });
    await expect(new SqliteActivationSafetyStore(connection).listDecisions('activation-1')).resolves.toEqual([promotionCommit().decision]);
    connection.close();
  });

  it('rolls back evidence and decision when promotion control version is stale', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation({ ...liveActivation(), action: 'code_tool_hook_shadow_activate' });
    const input = { ...promotionCommit(), expectedControlVersion: 9 };

    await expect(new SqliteActivationSafetyStore(connection).commitPromotion(input)).rejects.toThrow(/expected control version 9/i);
    const db = connection.getDb();
    expect(db.prepare('SELECT COUNT(*) AS count FROM activation_decisions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM activation_evidence_snapshots').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT action FROM activations WHERE activation_id = 'activation-1'").get())
      .toEqual({ action: 'code_tool_hook_shadow_activate' });
    connection.close();
  });

  it('atomically supersedes the prior live version for the same Principle', async () => {
    const connection = new SqliteConnection(makeWorkspace()); seedArtifact(connection); const db = connection.getDb();
    db.prepare("UPDATE pi_artifacts SET source_principle_id = 'principle-1' WHERE artifact_id = 'artifact-1'").run();
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());
    db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES ('task-2', 'diagnosis', 'pending', ?, ?)").run('2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
    db.prepare("INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES ('artifact-2', 'rule', 'task-2', 'principle-1', '[]', 'passed', '{}', ?, ?)").run('2026-08-21T00:00:00.000Z', '2026-08-21T00:00:00.000Z');
    await new SqliteActivationStateStore(connection).recordActivation({ ...liveActivation(), activationId: 'activation-2', idempotencyKey: 'activation-2-key', artifactId: 'artifact-2', action: 'code_tool_hook_shadow_activate', promotedAt: null });
    const input = promotionCommit(); input.decision = { ...input.decision, decisionId: 'decision-promote-2', subject: { kind: 'activation', activationId: 'activation-2', artifactId: 'artifact-2', artifactDigest: 'sha256:artifact' } }; input.idempotencyKey = 'promote-2';
    await new SqliteActivationSafetyStore(connection).commitPromotion(input);
    expect(db.prepare("SELECT activation_id FROM activations WHERE action = 'code_tool_hook_live_activate' AND deactivated_at IS NULL").all()).toEqual([{ activation_id: 'activation-2' }]);
    expect(db.prepare("SELECT decision FROM activation_decisions WHERE activation_id = 'activation-1'").get()).toEqual({ decision: 'supersede' }); connection.close();
  });

  it('atomically pauses every current live RuleCode and persists the affected snapshot', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());
    const store = new SqliteActivationSafetyStore(connection);
    const decision: ActivationDecisionRecord = {
      decisionId: 'pause-decision-1', subject: { kind: 'all_live_rulecode' }, decision: 'global_emergency_pause',
      principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' },
      reasonCode: 'owner_emergency_stop', note: null, evidenceSnapshotId: null, decidedAt: '2026-08-21T04:00:00.000Z',
    };

    await expect(store.pauseAllLive(decision, 'pause-1', 'pause-key-1')).resolves.toMatchObject({
      pauseId: 'pause-1', status: 'paused', affectedActivationIds: ['activation-1'], version: 1,
    });
    await expect(store.getControlState('activation-1')).resolves.toMatchObject({ enforcement: 'eligible' });
    await expect(store.getActiveGlobalPause()).resolves.toMatchObject({ pauseId: 'pause-1', status: 'paused' });
    connection.close();
  });

  it('releasing the global latch preserves per-rule isolation and leaves eligible rules eligible', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());
    const store = new SqliteActivationSafetyStore(connection);
    await store.safetyIsolate(isolateDecision(), 1);
    await store.pauseAllLive({
      decisionId: 'pause-decision-1', subject: { kind: 'all_live_rulecode' }, decision: 'global_emergency_pause',
      principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' }, authentication: { method: 'local_break_glass' },
      reasonCode: 'owner_emergency_stop', note: null, evidenceSnapshotId: null, decidedAt: '2026-08-21T04:00:00.000Z',
    }, 'pause-1', 'pause-key-1');
    const release: ActivationDecisionRecord = {
      decisionId: 'release-decision-1', subject: { kind: 'all_live_rulecode' }, decision: 'global_emergency_pause_release',
      principal: { kind: 'configured_owner', ownerId: 'owner-1' }, authentication: { method: 'console_token', credentialId: 'console-1' },
      reasonCode: 'incident_reviewed', note: 'Release latch only.', evidenceSnapshotId: null, decidedAt: '2026-08-21T04:05:00.000Z',
    };

    await expect(store.releaseGlobalPause(release, { pauseId: 'pause-1', expectedVersion: 1, idempotencyKey: 'release-key-1' })).resolves.toMatchObject({ status: 'released', version: 2 });
    await expect(store.getControlState('activation-1')).resolves.toMatchObject({ enforcement: 'safety_isolated' });
    await expect(store.getActiveGlobalPause()).resolves.toBeNull();
    connection.close();
  });

  it('atomically rejects a shadow rule without deleting its evidence', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation({ ...liveActivation(), action: 'code_tool_hook_shadow_activate' });
    const store = new SqliteActivationSafetyStore(connection);
    const decision: ActivationDecisionRecord = {
      decisionId: 'reject-decision-1', subject: { kind: 'activation', activationId: 'activation-1', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact' },
      decision: 'reject_after_shadow', principal: { kind: 'configured_owner', ownerId: 'owner-1' },
      authentication: { method: 'console_token', credentialId: 'console-1' }, reasonCode: 'scope_too_broad',
      note: 'Would block unrelated tools.', evidenceSnapshotId: null, decidedAt: '2026-08-21T05:00:00.000Z',
    };

    await expect(store.deactivateWithDecision(decision, 'reject-key-1')).resolves.toMatchObject({ activationId: 'activation-1', decisionId: 'reject-decision-1' });
    expect(connection.getDb().prepare("SELECT deactivated_at FROM activations WHERE activation_id = 'activation-1'").get())
      .toEqual({ deactivated_at: '2026-08-21T05:00:00.000Z' });
    await expect(store.listDecisions('activation-1')).resolves.toEqual([decision]);
    connection.close();
  });

  it('allows local break-glass emergency deactivation but not governance rejection', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation());
    const store = new SqliteActivationSafetyStore(connection);
    const emergency: ActivationDecisionRecord = {
      decisionId: 'emergency-1', subject: { kind: 'activation', activationId: 'activation-1', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact' },
      decision: 'emergency_deactivate', principal: { kind: 'break_glass', reason: 'local_no_auth_emergency' },
      authentication: { method: 'local_break_glass' }, reasonCode: 'host_at_risk', note: null,
      evidenceSnapshotId: null, decidedAt: '2026-08-21T05:10:00.000Z',
    };
    await expect(store.deactivateWithDecision(emergency, 'emergency-key-1')).resolves.toMatchObject({ decisionId: 'emergency-1' });
    await expect(store.deactivateWithDecision({ ...emergency, decisionId: 'bad-1', decision: 'reject_after_shadow' }, 'bad-key'))
      .rejects.toThrow(/authorized/i);
    connection.close();
  });

  it('records continue-observing intent without changing shadow state', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation({ ...liveActivation(), action: 'code_tool_hook_shadow_activate' });
    const decision: ActivationDecisionRecord = {
      decisionId: 'observe-1', subject: { kind: 'activation', activationId: 'activation-1', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact' },
      decision: 'continue_observing', principal: { kind: 'configured_owner', ownerId: 'owner-1' },
      authentication: { method: 'console_token', credentialId: 'console-1' }, reasonCode: 'collect_more_evidence',
      note: 'Observe another day.', evidenceSnapshotId: null, decidedAt: '2026-08-21T05:20:00.000Z',
    };
    const store = new SqliteActivationSafetyStore(connection);
    await expect(store.recordOwnerDecision(decision, 'observe-key-1')).resolves.toEqual({ decisionId: 'observe-1' });
    expect(connection.getDb().prepare("SELECT action, deactivated_at FROM activations WHERE activation_id = 'activation-1'").get())
      .toEqual({ action: 'code_tool_hook_shadow_activate', deactivated_at: null });
    connection.close();
  });

  it('recovers an isolated live rule only to a new linked shadow activation', async () => {
    const connection = new SqliteConnection(makeWorkspace()); seedArtifact(connection);
    await new SqliteActivationStateStore(connection).recordActivation(liveActivation()); const store = new SqliteActivationSafetyStore(connection);
    await store.safetyIsolate(isolateDecision(), 1);
    const recovery: ActivationDecisionRecord = { decisionId: 'recover-1', subject: { kind: 'activation', activationId: 'activation-1', artifactId: 'artifact-1', artifactDigest: 'sha256:artifact' }, decision: 'recover_to_shadow', principal: { kind: 'configured_owner', ownerId: 'owner-1' }, authentication: { method: 'console_token', credentialId: 'console-1' }, reasonCode: 'owner_requests_revalidation', note: 'Collect fresh shadow evidence.', evidenceSnapshotId: null, decidedAt: '2026-08-21T06:00:00.000Z' };
    await expect(store.recoverToShadow(recovery, { expectedControlVersion: 2, newActivationId: 'activation-recovery-1', idempotencyKey: 'recover-key-1' })).resolves.toMatchObject({ sourceActivationId: 'activation-1', shadowActivationId: 'activation-recovery-1' });
    expect(connection.getDb().prepare("SELECT action FROM activations WHERE activation_id = 'activation-recovery-1'").get()).toEqual({ action: 'code_tool_hook_shadow_activate' });
    await expect(store.getControlState('activation-1')).resolves.toMatchObject({ enforcement: 'safety_isolated' });
    await expect(store.getControlState('activation-recovery-1')).resolves.toMatchObject({ enforcement: 'eligible' }); connection.close();
  });

  it('commitPromotion rolls back all changes when the activation_decisions INSERT fails (P0-3 rollback)', async () => {
    const connection = new SqliteConnection(makeWorkspace());
    seedArtifact(connection);
    // Insert a shadow activation directly (no promotedAt)
    const db = connection.getDb();
    db.prepare(`
      INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
      VALUES ('activation-1', 'activation-1-key', 'artifact-1', 'code_tool_hook', 'code_tool_hook_shadow_activate', 'impl://rule-1', '2026-08-21T00:01:00.000Z', NULL, NULL)
    `).run();
    // Insert matching control row
    db.prepare(`
      INSERT INTO activation_control_states (activation_id, enforcement, isolation_decision_id, version, updated_at)
      VALUES ('activation-1', 'eligible', NULL, 1, '2026-08-21T00:01:00.000Z')
    `).run();

    // Force every INSERT into activation_decisions to abort the transaction
    db.prepare(`
      CREATE TRIGGER force_decision_fail
      BEFORE INSERT ON activation_decisions
      BEGIN
        SELECT RAISE(ABORT, 'forced failure for rollback test');
      END
    `).run();

    const store = new SqliteActivationSafetyStore(connection);
    await expect(store.commitPromotion(promotionCommit())).rejects.toThrow();

    // activation row must not have been promoted
    const row = db.prepare("SELECT action, promoted_at FROM activations WHERE activation_id = 'activation-1'").get() as { action: string; promoted_at: string | null };
    expect(row.action).toBe('code_tool_hook_shadow_activate');
    expect(row.promoted_at).toBeNull();

    // no orphan decision row
    const decisionCount = (db.prepare("SELECT COUNT(*) AS n FROM activation_decisions WHERE decision_id = 'decision-promote-1'").get() as { n: number }).n;
    expect(decisionCount).toBe(0);

    // no orphan evidence snapshot (inserted before the failing decision INSERT)
    const snapshotCount = (db.prepare('SELECT COUNT(*) AS n FROM activation_evidence_snapshots').get() as { n: number }).n;
    expect(snapshotCount).toBe(0);

    // control state untouched by the aborted transaction
    const control = db.prepare("SELECT enforcement, version FROM activation_control_states WHERE activation_id = 'activation-1'").get() as { enforcement: string; version: number };
    expect(control.enforcement).toBe('eligible');
    expect(control.version).toBe(1);

    connection.close();
  });
});
