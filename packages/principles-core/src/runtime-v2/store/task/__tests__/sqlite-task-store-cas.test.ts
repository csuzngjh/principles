/**
 * PRI-629 — SqliteTaskStore.updateTaskIfDiagnosticJsonUnchanged (narrow CAS)。
 *
 * 单 SQL conditional mutation: diagnostic_json 前置字节比较。并发语义:
 *   - expected 与当前一致 → 应用 patch 并返回更新后的行
 *   - 不一致 / 任务缺失 → 返回 null (调用方重读重估,无 partial write)
 *   - NULL 列与 expected=null 匹配 (SQLite IS 语义)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SqliteConnection } from '../../sqlite-connection.js';
import { SqliteTaskStore } from '../sqlite-task-store.js';

describe('SqliteTaskStore.updateTaskIfDiagnosticJsonUnchanged (PRI-629 CAS)', () => {
  let dir: string;
  let store: SqliteTaskStore;
  let connection: SqliteConnection;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cas-test-'));
    connection = new SqliteConnection(dir);
    connection.getDb();
    store = new SqliteTaskStore(connection);
  });

  afterEach(async () => {
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function createTask(diagnosticJson?: string): Promise<string> {
    const record = await store.createTask({
      taskId: `task-cas-${Math.random().toString(36).slice(2, 8)}`,
      taskKind: 'evaluator',
      status: 'needs_human_review',
      attemptCount: 2,
      maxAttempts: 3,
      diagnosticJson,
    });
    return record.taskId;
  }

  it('applies the patch when diagnostic_json matches the expectation', async () => {
    const taskId = await createTask('{"pi_metadata":{"v":1}}');
    const updated = await store.updateTaskIfDiagnosticJsonUnchanged(taskId, '{"pi_metadata":{"v":1}}', {
      status: 'pending',
      attemptCount: 0,
      diagnosticJson: '{"pi_metadata":{"v":2}}',
    });
    expect(updated?.status).toBe('pending');
    expect(updated?.attemptCount).toBe(0);
    expect((await store.getTask(taskId))?.diagnosticJson).toBe('{"pi_metadata":{"v":2}}');
  });

  it('returns null (no write) when diagnostic_json changed concurrently', async () => {
    const taskId = await createTask('{"pi_metadata":{"v":1}}');
    // 另一个写入者先改了 diagnostic_json
    await store.updateTask(taskId, { diagnosticJson: '{"pi_metadata":{"v":"other-writer"}}' });
    const result = await store.updateTaskIfDiagnosticJsonUnchanged(taskId, '{"pi_metadata":{"v":1}}', {
      status: 'pending',
      diagnosticJson: '{"pi_metadata":{"v":2}}',
    });
    expect(result).toBeNull();
    // 行保持并发写者的内容 — 无 partial write
    const row = await store.getTask(taskId);
    expect(row?.status).toBe('needs_human_review');
    expect(row?.diagnosticJson).toBe('{"pi_metadata":{"v":"other-writer"}}');
  });

  it('matches expected=null against a NULL column and rejects string-expected on NULL', async () => {
    const taskId = await createTask(undefined);
    const ok = await store.updateTaskIfDiagnosticJsonUnchanged(taskId, null, { status: 'pending' });
    expect(ok?.status).toBe('pending');
    const taskId2 = await createTask(undefined);
    const mismatch = await store.updateTaskIfDiagnosticJsonUnchanged(taskId2, 'not-null', { status: 'pending' });
    expect(mismatch).toBeNull();
  });

  it('returns null for a missing task (no throw, no partial state)', async () => {
    const result = await store.updateTaskIfDiagnosticJsonUnchanged('task-does-not-exist', null, { status: 'pending' });
    expect(result).toBeNull();
  });

  it('does not write when bound evidence content or lineage changed after review', async () => {
    const taskId = await createTask('{"pi_metadata":{"v":1}}');
    const db = connection.getDb();
    db.prepare(`
      INSERT INTO pi_artifacts (
        artifact_id, artifact_kind, source_task_id, lineage_artifact_ids,
        validation_status, content_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'artifact-bound', 'principle', taskId, '["scribe-a"]',
      'pending', '{"summary":"Evidence A"}', '2026-08-31T00:00:00.000Z', '2026-08-31T00:00:00.000Z',
    );

    const expectedEvidence = [{
      artifactId: 'artifact-bound',
      sourceTaskId: taskId,
      lineageArtifactIdsJson: '["scribe-a"]',
      contentJson: '{"summary":"Evidence A"}',
    }];
    db.prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?')
      .run('{"summary":"Evidence B"}', 'artifact-bound');

    const contentRace = await store.updateTaskIfDiagnosticJsonAndArtifactsUnchanged({
      taskId,
      expectedDiagnosticJson: '{"pi_metadata":{"v":1}}',
      artifacts: expectedEvidence,
      patch: { status: 'pending' },
    });
    expect(contentRace).toBeNull();
    expect((await store.getTask(taskId))?.status).toBe('needs_human_review');

    db.prepare('UPDATE pi_artifacts SET content_json = ?, lineage_artifact_ids = ? WHERE artifact_id = ?')
      .run('{"summary":"Evidence A"}', '["scribe-b"]', 'artifact-bound');
    const lineageRace = await store.updateTaskIfDiagnosticJsonAndArtifactsUnchanged({
      taskId,
      expectedDiagnosticJson: '{"pi_metadata":{"v":1}}',
      artifacts: expectedEvidence,
      patch: { status: 'pending' },
    });
    expect(lineageRace).toBeNull();
    expect((await store.getTask(taskId))?.status).toBe('needs_human_review');
  });
});
