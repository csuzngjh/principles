import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { SqliteConnection } from '../../store/sqlite-connection.js';
import { SqlitePIArtifactStore } from '../../store/artifact/sqlite-pi-artifact-store.js';
import { SqliteApprovalQueueStore } from '../sqlite-approval-store.js';
import { MemoryApprovalQueueStore } from '../memory-approval-store.js';
import { computeArtifactDigest } from '../promotion-evidence-snapshot.js';
import { isApprovalReviewGuard, type ApprovalReviewGuard } from '../approval-review-guard.js';

let directory: string;
let connection: SqliteConnection;
let other: SqliteConnection;
let store: SqliteApprovalQueueStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'pd-review-guard-'));
  connection = new SqliteConnection(directory);
  const db = connection.getDb();
  for (const id of ['a', 'b', 'c']) {
    db.prepare("INSERT INTO tasks(task_id,task_kind,status,created_at,updated_at) VALUES (?, 'diagnosis','pending','now','now')").run(`task-${id}`);
    db.prepare("INSERT INTO pi_artifacts(artifact_id,artifact_kind,source_task_id,lineage_artifact_ids,validation_status,content_json,created_at,updated_at) VALUES (?, 'principle', ?, ?, 'validated', ?, 'now','now')").run(id, `task-${id}`, JSON.stringify(id === 'a' ? [] : ['a']), JSON.stringify({ principleDraft: { statement: `Statement ${id}` } }));
  }
  other = new SqliteConnection(directory);
  store = new SqliteApprovalQueueStore(connection);
});
afterEach(() => { connection.close(); other.close(); rmSync(directory, { recursive: true, force: true }); });
async function reviewed() {
  const record = await store.enqueue({ artifactId: 'a', channel: 'prompt', riskLevel: 'low' }, 'now');
  const artifact = await new SqlitePIArtifactStore(connection).getArtifactById('a');
  if (!artifact) throw new Error('missing fixture artifact');
  const guard: ApprovalReviewGuard = { schemaVersion: 'approval-review-v1', artifactState: 'present', approvalId: record.approvalId, artifactId: 'a', artifactDigest: computeArtifactDigest(artifact), channel: 'prompt' };
  return { record, guard };
}
it('rejects read A -> another writer swaps B -> approve old A without any decision write', async () => {
  const { record, guard } = await reviewed();
  await new SqliteApprovalQueueStore(other).edit({ approvalId: record.approvalId, newArtifactId: 'b', editedBy: 'other', editReason: 'revision', now: 'later' });
  expect(await store.approve(record.approvalId, 'owner', undefined, guard)).toMatchObject({ ok: false, error: 'stale_review' });
  expect(await store.getById(record.approvalId)).toMatchObject({ artifactId: 'b', status: 'pending' });
  expect((await store.getById(record.approvalId))?.decidedBy).toBeUndefined();
});
it('rejects same-ID changed content for both approve and reject', async () => {
  const { record, guard } = await reviewed();
  other.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run('{"principleDraft":{"statement":"Changed"}}', 'a');
  expect(await store.approve(record.approvalId, 'owner', undefined, guard)).toMatchObject({ error: 'stale_review' });
  expect(await store.reject(record.approvalId, 'owner', 'No', guard)).toMatchObject({ error: 'stale_review' });
  expect((await store.getById(record.approvalId))?.status).toBe('pending');
});
it('serializes two edits against the same old reading and preserves the winning lineage', async () => {
  const { record, guard } = await reviewed();
  expect(await new SqliteApprovalQueueStore(other).edit({ approvalId: record.approvalId, expectedReview: guard, newArtifactId: 'b', editedBy: 'first', editReason: 'first', now: 'later' })).toMatchObject({ ok: true });
  expect(await store.edit({ approvalId: record.approvalId, expectedReview: guard, newArtifactId: 'c', editedBy: 'second', editReason: 'second', now: 'later' })).toMatchObject({ error: 'stale_review' });
  expect(await store.getById(record.approvalId)).toMatchObject({ artifactId: 'b', previousArtifactId: 'a' });
});
it('revalidates replacement eligibility and lineage inside the edit transaction', async () => {
  const { record, guard } = await reviewed();
  other.getDb().prepare("UPDATE pi_artifacts SET validation_status = 'pending' WHERE artifact_id = 'b'").run();
  expect(await store.edit({ approvalId: record.approvalId, expectedReview: guard, newArtifactId: 'b', editedBy: 'owner', editReason: 'replace', now: 'later' })).toMatchObject({ error: 'stale_review' });
  other.getDb().prepare("UPDATE pi_artifacts SET validation_status = 'validated', lineage_artifact_ids = '[]' WHERE artifact_id = 'b'").run();
  expect(await store.edit({ approvalId: record.approvalId, expectedReview: guard, newArtifactId: 'b', editedBy: 'owner', editReason: 'replace', now: 'later' })).toMatchObject({ error: 'stale_review' });
  expect((await store.getById(record.approvalId))?.artifactId).toBe('a');
});
it('checks target identity and channel and preserves legacy unguarded callers', async () => {
  const { record, guard } = await reviewed();
  expect(await store.reject(record.approvalId, 'owner', 'No', { ...guard, channel: 'defer_archive' })).toMatchObject({ error: 'stale_review' });
  expect(await store.approve(record.approvalId, 'owner', undefined, { ...guard, approvalId: 'foreign' })).toMatchObject({ error: 'stale_review' });
  expect(await store.approve(record.approvalId, 'legacy')).toMatchObject({ ok: true, record: { status: 'approved' } });
});
it('allows missing-only rejection but refuses it once the artifact becomes available', async () => {
  const { record } = await reviewed();
  const missing: ApprovalReviewGuard = { schemaVersion: 'approval-review-v1', artifactState: 'missing', approvalId: record.approvalId, artifactId: 'a', channel: 'prompt' };
  expect(await store.reject(record.approvalId, 'owner', 'No', missing)).toMatchObject({ error: 'stale_review' });
  other.getDb().prepare('DELETE FROM pi_artifacts WHERE artifact_id = ?').run('a');
  expect(await store.approve(record.approvalId, 'owner', undefined, missing)).toMatchObject({ error: 'stale_review' });
  expect(await store.reject(record.approvalId, 'owner', 'No', missing)).toMatchObject({ ok: true, record: { status: 'rejected' } });
});
it('guarded approval stores the same reviewed digest', async () => {
  const { record, guard } = await reviewed();
  expect(await store.approve(record.approvalId, 'owner', undefined, guard)).toMatchObject({ ok: true, record: { artifactDigest: guard.artifactState === 'present' ? guard.artifactDigest : '' } });
});
it('memory store checks the same artifact material and fails closed without a reader', async () => {
  const { guard } = await reviewed();
  const artifact = await new SqlitePIArtifactStore(connection).getArtifactById('a');
  if (!artifact) throw new Error('missing artifact');
  const memory = new MemoryApprovalQueueStore(() => artifact);
  const record = await memory.enqueue({ artifactId: 'a', channel: 'prompt', riskLevel: 'low' }, 'now');
  expect(await memory.approve(record.approvalId, 'owner', undefined, guard)).toMatchObject({ ok: true });
  const closed = new MemoryApprovalQueueStore();
  await closed.enqueue({ artifactId: 'a', channel: 'prompt', riskLevel: 'low' }, 'now');
  expect(await closed.reject(record.approvalId, 'owner', 'No', guard)).toMatchObject({ error: 'stale_review' });
});
it('runtime guard rejects malformed and half-present contracts', () => {
  expect(isApprovalReviewGuard({ schemaVersion: 'approval-review-v1', artifactState: 'present', approvalId: 'a', artifactId: 'b', channel: 'prompt' })).toBe(false);
  expect(isApprovalReviewGuard({ schemaVersion: 'approval-review-v1', artifactState: 'missing', approvalId: 'a', artifactId: 'b', channel: 'prompt', artifactDigest: 'sha256:' + 'a'.repeat(64) })).toBe(false);
});
