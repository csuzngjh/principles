import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, afterEach } from 'vitest';
import { SqliteConnection } from '../../sqlite-connection.js';
import { SqlitePIArtifactStore } from '../sqlite-pi-artifact-store.js';
import type { PIArtifactRecord } from '../../../internalization/pi-artifact.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function makeConnection(): SqliteConnection {
  const dir = mkdtempSync(join(tmpdir(), 'pd-pi-artifact-fk-'));
  tempDirs.push(dir);
  return new SqliteConnection(dir);
}

function insertTask(db: ReturnType<SqliteConnection['getDb']>, taskId: string): void {
  db.prepare(
    "INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'diagnosis', 'pending', ?, ?)",
  ).run(taskId, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
}

function makeArtifactRecord(sourceTaskId: string): PIArtifactRecord {
  return {
    artifactId: 'art_test_001',
    artifactKind: 'principle',
    sourceTaskId,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: '{}',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

describe('SqlitePIArtifactStore FK validation (P1-3)', () => {
  it('throws when createArtifact references non-existent task', async () => {
    const conn = makeConnection();
    conn.getDb(); // trigger initSchema
    const store = new SqlitePIArtifactStore(conn);

    const record = makeArtifactRecord('non_existent_task');

    await expect(store.createArtifact(record)).rejects.toThrow(
      /pi_artifacts\.source_task_id references non-existent task/,
    );
  });

  it('succeeds when parent task exists', async () => {
    const conn = makeConnection();
    const db = conn.getDb();
    insertTask(db, 'task_001');

    const store = new SqlitePIArtifactStore(conn);
    const record = makeArtifactRecord('task_001');

    const result = await store.createArtifact(record);
    expect(result.artifactId).toBe('art_test_001');
    expect(result.sourceTaskId).toBe('task_001');
  });
});
