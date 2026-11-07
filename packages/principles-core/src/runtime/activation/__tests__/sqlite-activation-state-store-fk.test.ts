import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteActivationStateStore } from '../sqlite-activation-state-store.js';
import type { ActivationStatusRecord } from '../activation-types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeConnection(): SqliteConnection {
  const dir = mkdtempSync(join(tmpdir(), 'pd-activation-fk-'));
  tempDirs.push(dir);
  return new SqliteConnection(dir);
}

function insertTask(db: ReturnType<SqliteConnection['getDb']>, taskId: string): void {
  db.prepare(
    "INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'diagnosis', 'pending', ?, ?)",
  ).run(taskId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

function insertPiArtifact(
  db: ReturnType<SqliteConnection['getDb']>,
  artifactId: string,
  sourceTaskId: string,
): void {
  db.prepare(
    `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
     VALUES (?, 'principle', ?, '[]', 'pending', '{}', ?, ?)`,
  ).run(artifactId, sourceTaskId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

function makeActivationRecord(artifactId: string): ActivationStatusRecord {
  return {
    activationId: 'act_test_001',
    idempotencyKey: 'idem_test_001',
    artifactId,
    channel: 'prompt',
    action: 'inject_prompt',
    targetRef: 'thinking-os.md',
    activatedAt: '2026-01-01T00:00:00Z',
    deactivatedAt: null,
  };
}

describe('SqliteActivationStateStore FK validation (P1-3)', () => {
  it('throws when recordActivation references non-existent pi_artifact', async () => {
    const conn = makeConnection();
    conn.getDb(); // trigger initSchema
    const store = new SqliteActivationStateStore(conn);

    const record = makeActivationRecord('non_existent_artifact');

    await expect(store.recordActivation(record)).rejects.toThrow(
      /activations\.artifact_id references non-existent pi_artifact/,
    );
  });

  it('succeeds when parent pi_artifact exists', async () => {
    const conn = makeConnection();
    const db = conn.getDb();
    insertTask(db, 'task_001');
    insertPiArtifact(db, 'art_001', 'task_001');

    const store = new SqliteActivationStateStore(conn);
    const record = makeActivationRecord('art_001');

    await expect(store.recordActivation(record)).resolves.toBeUndefined();

    // Verify the record was actually inserted
    const status = await store.getActivationStatus('idem_test_001');
    expect(status).not.toBeNull();
    expect(status?.artifactId).toBe('art_001');
  });
});
