import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqliteApprovalQueueStore } from '../sqlite-approval-store.js';
import type { ApprovalEnqueueInput } from '../activation-types.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeConnection(): SqliteConnection {
  const dir = mkdtempSync(join(tmpdir(), 'pd-approval-fk-'));
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

describe('SqliteApprovalQueueStore FK validation (P1-3)', () => {
  it('throws when enqueue references non-existent pi_artifact', async () => {
    const conn = makeConnection();
    conn.getDb(); // trigger initSchema
    const store = new SqliteApprovalQueueStore(conn);

    const input: ApprovalEnqueueInput = {
      artifactId: 'non_existent_artifact',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    };

    await expect(store.enqueue(input, '2026-01-01T00:00:00Z')).rejects.toThrow(
      /approvals\.artifact_id references non-existent pi_artifact/,
    );
  });

  it('succeeds when parent pi_artifact exists', async () => {
    const conn = makeConnection();
    const db = conn.getDb();
    insertTask(db, 'task_001');
    insertPiArtifact(db, 'art_001', 'task_001');

    const store = new SqliteApprovalQueueStore(conn);
    const input: ApprovalEnqueueInput = {
      artifactId: 'art_001',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    };

    const record = await store.enqueue(input, '2026-01-01T00:00:00Z');
    expect(record.artifactId).toBe('art_001');
    expect(record.status).toBe('pending');
  });
});
