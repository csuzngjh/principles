import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteActivationSafetyStore } from '../sqlite-activation-safety-store.js';
import { SqliteActivationStateStore } from '../sqlite-activation-state-store.js';
import type { ActivationDecisionRecord } from '../activation-control-types.js';
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
});
