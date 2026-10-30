import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteConnection, SqliteApprovalQueueStore, isApprovalReviewGuard } from '@principles/core/runtime-v2';
import { ApprovalsConsoleModel } from '../../src/server/models/ApprovalsConsoleModel.js';
import { handleApprovalsRoute, disposeApprovalsModels } from '../../src/server/routes/approvals.js';

let directory: string;
let connection: SqliteConnection;
let server: Server;
let base: string;
let model: ApprovalsConsoleModel;
let approvalId: string;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), 'pd-console-guard-'));
  connection = new SqliteConnection(directory);
  const db = connection.getDb();
  for (const id of ['a', 'b', 'c']) {
    db.prepare("INSERT INTO tasks(task_id,task_kind,status,created_at,updated_at) VALUES (?, 'diagnosis','pending','now','now')").run(`task-${id}`);
    db.prepare("INSERT INTO pi_artifacts(artifact_id,artifact_kind,source_task_id,lineage_artifact_ids,validation_status,content_json,created_at,updated_at) VALUES (?, 'principle', ?, ?, 'validated', ?, 'now','now')").run(id, `task-${id}`, JSON.stringify(id === 'a' ? [] : ['a']), JSON.stringify({ principleDraft: { statement: `Statement ${id}`, rationale: 'Reason', applicability: ['local'] }, risks: [`Risk ${id}`], secret: 'not-for-ui' }));
  }
  approvalId = (await new SqliteApprovalQueueStore(connection).enqueue({ artifactId: 'a', channel: 'defer_archive', riskLevel: 'low' }, 'now')).approvalId;
  model = new ApprovalsConsoleModel(directory);
  server = createServer((req, res) => { void handleApprovalsRoute(req, res, directory, (req.url ?? '/').replace('/api/v1/approvals', '')).catch(() => { res.statusCode = 500; res.end(); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing server port');
  base = `http://127.0.0.1:${address.port}/api/v1/approvals/${approvalId}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); disposeApprovalsModels(); model.dispose(); connection.close(); rmSync(directory, { recursive: true, force: true }); });
async function review() {
  const detail = await model.getApprovalDetail(approvalId);
  if (!detail) throw new Error('missing approval review');
  expect(detail.writeGuardVersion).toBe('approval-review-v1');
  expect(isApprovalReviewGuard(detail.review.expectedReview)).toBe(true);
  return detail;
}
async function post(action: string, body: unknown) { return fetch(`${base}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
it('GET returns same-object exact material and guard without raw private metadata', async () => {
  const response = await fetch(base);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ data: { writeGuardVersion: 'approval-review-v1', review: { expectedReview: { artifactState: 'present', artifactId: 'a' }, material: { exactBody: { kind: 'principle', text: 'Statement a' }, rationale: 'Reason', scope: ['local'], risks: ['Risk a'] } } } });
  expect(JSON.stringify(body)).not.toContain('not-for-ui');
});
it('route rejects stale approve, reject and edit without changing the winner', async () => {
  const detail = await review();
  expect(await model.editApproval({ approvalId, newArtifactId: 'b', editedBy: 'other', editReason: 'revision' })).toMatchObject({ ok: true });
  for (const [action, fields] of [['approve', {}], ['reject', { reason: 'No' }], ['edit', { newArtifactId: 'c', editReason: 'replace' }]]) {
    const response = await post(String(action), { ...fields, expectedReview: detail.review.expectedReview });
    expect(response.status, String(action) + await response.clone().text()).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'stale_review' });
  }
  const current = await model.getApprovalDetail(approvalId);
  expect(current).toMatchObject({ artifactId: 'b', status: 'pending' });
  expect(current?.decidedAt).toBeUndefined();
  expect(connection.getDb().prepare('SELECT COUNT(*) AS count FROM activations').get()).toMatchObject({ count: 0 });
});
it('rejects changed same-ID content through the real HTTP route', async () => {
  const detail = await review();
  connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run('{"principleDraft":{"statement":"Changed"}}', 'a');
  const response = await post('reject', { reason: 'No', expectedReview: detail.review.expectedReview });
  expect(response.status).toBe(409);
  expect((await review()).status).toBe('pending');
});
it('supports current guarded replacement and guarded rejection', async () => {
  const before = await review();
  expect((await post('edit', { newArtifactId: 'b', editReason: 'replace', expectedReview: before.review.expectedReview })).status).toBe(200);
  const after = await review();
  expect(after.review.material.exactBody?.text).toBe('Statement b');
  expect((await post('reject', { reason: 'No', expectedReview: after.review.expectedReview })).status).toBe(200);
  expect((await review()).status).toBe('rejected');
});
it('rejects malformed, half-present and wrong-target guard contracts instead of legacy fallback', async () => {
  const detail = await review();
  for (const guard of [null, {}, { ...detail.review.expectedReview, approvalId: 'foreign' }]) {
    expect((await post('reject', { reason: 'No', expectedReview: guard })).status).toBe(400);
  }
  expect((await review()).status).toBe('pending');
});
it('allows missing artifact rejection only and rejects stale missing snapshots after restoration', async () => {
  connection.getDb().prepare('DELETE FROM pi_artifacts WHERE artifact_id = ?').run('a');
  const missing = await review();
  expect(missing.review.expectedReview.artifactState).toBe('missing');
  expect((await post('approve', { expectedReview: missing.review.expectedReview })).status).toBe(400);
  expect((await post('edit', { newArtifactId: 'b', editReason: 'replace', expectedReview: missing.review.expectedReview })).status).toBe(400);
  connection.getDb().prepare("INSERT INTO pi_artifacts(artifact_id,artifact_kind,source_task_id,lineage_artifact_ids,validation_status,content_json,created_at,updated_at) VALUES ('a','principle','task-a','[]','validated','{}','now','now')").run();
  expect((await post('reject', { reason: 'No', expectedReview: missing.review.expectedReview })).status).toBe(409);
  connection.getDb().prepare("DELETE FROM pi_artifacts WHERE artifact_id = 'a'").run();
  expect((await post('reject', { reason: 'No', expectedReview: missing.review.expectedReview })).status).toBe(200);
});

it('storage guard still refuses changes after the service precheck, with no activation', async () => {
  const detail = await review();
  const original = SqliteApprovalQueueStore.prototype.approve;
  const spy = vi.spyOn(SqliteApprovalQueueStore.prototype, 'approve').mockImplementationOnce(async function (this: SqliteApprovalQueueStore, ...args: Parameters<typeof original>) {
    connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run('{"principleDraft":{"statement":"Changed after precheck"}}', 'a');
    return original.apply(this, args);
  });
  try {
    const response = await post('approve', { expectedReview: detail.review.expectedReview });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'stale_review' });
    expect((await review()).status).toBe('pending');
    expect(connection.getDb().prepare('SELECT COUNT(*) AS count FROM activations').get()).toMatchObject({ count: 0 });
  } finally { spy.mockRestore(); }
});

it('refuses a replacement changed after service validation but before the edit transaction', async () => {
  const detail = await review();
  const original = SqliteApprovalQueueStore.prototype.edit;
  const spy = vi.spyOn(SqliteApprovalQueueStore.prototype, 'edit').mockImplementationOnce(async function (this: SqliteApprovalQueueStore, input: Parameters<typeof original>[0]) {
    connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run('{"principleDraft":{"statement":"Changed replacement"}}', 'b');
    return original.call(this, input);
  });
  try {
    const response = await post('edit', { newArtifactId: 'b', editReason: 'replace', expectedReview: detail.review.expectedReview });
    expect(response.status).toBe(409);
    expect((await review()).artifactId).toBe('a');
  } finally { spy.mockRestore(); }
});


it('never validates the guard for B while using an independently read record A for decision prechecks', async () => {
  const db = connection.getDb();
  db.prepare('UPDATE approvals SET artifact_id = ? WHERE approval_id = ?').run('b', approvalId);
  const readingB = await review();
  db.prepare('UPDATE approvals SET artifact_id = ? WHERE approval_id = ?').run('a', approvalId);
  const original = SqliteApprovalQueueStore.prototype.getById;
  const spy = vi.spyOn(SqliteApprovalQueueStore.prototype, 'getById').mockImplementationOnce(async function (this: SqliteApprovalQueueStore, id: string) {
    const recordA = await original.call(this, id);
    db.prepare('UPDATE approvals SET artifact_id = ? WHERE approval_id = ?').run('b', approvalId);
    return recordA;
  });
  try {
    const result = await model.approve(approvalId, 'owner', { expectedReview: readingB.review.expectedReview });
    expect(result).toMatchObject({ ok: false, error: 'stale_review' });
    expect(await review()).toMatchObject({ artifactId: 'b', status: 'pending' });
    expect(db.prepare('SELECT COUNT(*) AS count FROM activations').get()).toMatchObject({ count: 0 });
  } finally { spy.mockRestore(); }
});


it('distinguishes missing or malformed exact-artifact risks from an explicitly empty risk list', async () => {
  for (const fields of [{}, { risks: 'unknown' }, { risks: ['Risk', 42] }, { risks: null }]) {
    connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run(JSON.stringify({ principleDraft: { statement: 'Current body', risks: ['Nested risk is not authoritative'] }, ...fields }), 'a');
    const response = await fetch(base);
    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ data: { review: { material: { risks: null } } } });
    expect(JSON.stringify(body)).not.toContain('Risk b');
    expect(JSON.stringify(body)).not.toContain('Nested risk is not authoritative');
  }
  connection.getDb().prepare('UPDATE pi_artifacts SET content_json = ? WHERE artifact_id = ?').run(JSON.stringify({ principleDraft: { statement: 'Current body' }, risks: [] }), 'a');
  expect(await (await fetch(base)).json()).toMatchObject({ data: { review: { material: { risks: [] } } } });
});
