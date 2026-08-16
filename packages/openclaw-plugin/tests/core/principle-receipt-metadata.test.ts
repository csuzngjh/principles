/**
 * PRI-530: Principle receipt metadata reader (SPEC §5.1) — fallback chain tests.
 *
 * Title chain: principle_candidates.title → content_json.principleDraft.title
 *              → content_json.text (first 40 chars) → raw id.
 * Date chain:  approvals.decided_at → activations.activated_at → undefined.
 * Source:      painReasonSummary only when the artifact carries it (never invented).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SqliteConnection } from '@principles/core/runtime-v2';
import {
  loadPrincipleReceiptMetadata,
  clearPrincipleReceiptMetadataCache,
} from '../../src/core/principle-receipt-metadata.js';

let workspaceDir = '';
let conn: SqliteConnection;

function insertArtifact(artifactId: string, principleId: string, contentJson: string, kind = 'principle'): void {
  // Seed FK parents for principle_candidates (tasks/runs/artifacts), mirroring
  // schema-conformance.test.ts F13.
  const now = '2026-08-01T00:00:00.000Z';
  const db = conn.getDb();
  db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(`task-${artifactId}`, 'diagnostician', 'pending', now, now);
  db.prepare('INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(`run-${artifactId}`, `task-${artifactId}`, 'test-double', 'queued', now, now, now);
  db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(artifactId, `run-${artifactId}`, `task-${artifactId}`, 'principle', '{}', now);
  db.prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
                              content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z')
  `).run(artifactId, kind, `task-${artifactId}`, principleId, contentJson);
}

function insertCandidateTitle(artifactId: string, title: string): void {
  conn.getDb().prepare(`
    INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id,
                                      title, description, idempotency_key, created_at)
    VALUES (?, ?, ?, ?, ?, '', ?, '2026-08-01T00:00:00.000Z')
  `).run(`cand-${artifactId}`, artifactId, `task-${artifactId}`, `run-${artifactId}`, title, `ikey-${artifactId}`);
}

function insertApproval(artifactId: string, decidedAt: string): void {
  conn.getDb().prepare(`
    INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status,
                           requested_at, decided_at, decided_by)
    VALUES (?, ?, 'prompt', 'low', 'approved', ?, ?, 'demo-owner')
  `).run(`appr-${artifactId}-${decidedAt}`, artifactId, decidedAt, decidedAt);
}

function insertActivation(artifactId: string, activatedAt: string): void {
  conn.getDb().prepare(`
    INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action,
                             target_ref, activated_at)
    VALUES (?, ?, ?, 'code_tool_hook', 'code_tool_hook_activate', ?, ?)
  `).run(`act-${artifactId}-${activatedAt}`, `iact-${artifactId}-${activatedAt}`, artifactId,
         `impl://rule-${artifactId}`, activatedAt);
}

beforeEach(() => {
  clearPrincipleReceiptMetadataCache();
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-receipt-meta-'));
  conn = new SqliteConnection(workspaceDir);
});

afterEach(() => {
  conn.close();
  // Close the module-cached readonly connections too — otherwise Windows
  // keeps the sqlite file open and the temp dir cannot be removed (EPERM).
  clearPrincipleReceiptMetadataCache();
  fs.rmSync(workspaceDir, { recursive: true, force: true });
});

describe('PRI-530: loadPrincipleReceiptMetadata fallback chain', () => {
  it('resolves title from principle_candidates.title when present', () => {
    insertArtifact('art-1', 'princ-1', JSON.stringify({ text: 'raw principle text' }));
    insertCandidateTitle('art-1', '删除前确认目标');
    insertApproval('art-1', '2026-07-30T10:00:00.000Z');

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-1', 'princ-1');
    expect(meta).toBeDefined();
    expect(meta?.title).toBe('删除前确认目标');
    expect(meta?.approvedAt).toBe('2026-07-30T10:00:00.000Z');
    expect(meta?.sourceSummary).toBeUndefined();
  });

  it('resolves candidate title via the artifacts table when ids differ across tables (FK reality)', () => {
    // principle_candidates.artifact_id FKs the ARTIFACTS table, not pi_artifacts —
    // a candidate keyed by a sibling artifacts id must still be found via source_task_id.
    const now = '2026-08-01T00:00:00.000Z';
    const db = conn.getDb();
    db.prepare('INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('task-cross', 'diagnostician', 'pending', now, now);
    db.prepare('INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('run-cross', 'task-cross', 'test-double', 'queued', now, now, now);
    db.prepare('INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('art-sibling', 'run-cross', 'task-cross', 'principle', '{}', now);
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id,
                content_json, created_at, updated_at)
                VALUES ('pi-cross', 'principle', 'task-cross', 'princ-cross', ?, ?, ?)`)
      .run(JSON.stringify({ text: 'plain text' }), now, now);
    db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id,
                title, description, idempotency_key, created_at)
                VALUES ('cand-cross', 'art-sibling', 'task-cross', 'run-cross', '跨表标题', '', 'ikey-cross', ?)`)
      .run(now);

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-cross', 'princ-cross');
    expect(meta?.title).toBe('跨表标题');
  });

  it('falls back to principleDraft.title when no candidate row exists', () => {
    insertArtifact('art-2', 'princ-2',
      JSON.stringify({ principleDraft: { title: '草稿标题' }, text: 'raw text' }));

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-2', 'princ-2');
    expect(meta?.title).toBe('草稿标题');
  });

  it('falls back to first 40 chars of text when no title anywhere', () => {
    const longText = 'a'.repeat(80);
    insertArtifact('art-3', 'princ-3', JSON.stringify({ text: longText }));

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-3', 'princ-3');
    expect(meta?.title).toBe('a'.repeat(40));
  });

  it('falls back to raw principleId for legacy artifacts that carry no readable fields', () => {
    insertArtifact('art-4', 'princ-4', JSON.stringify({}));

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-4', 'princ-4');
    expect(meta?.title).toBe('princ-4');
  });

  it('sourceSummary appears only when painReasonSummary exists (never invented)', () => {
    insertArtifact('art-5', 'princ-5',
      JSON.stringify({ text: 'principle', painReasonSummary: 'agent 差点删错目录，owner 纠正' }));

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-5', 'princ-5');
    expect(meta?.sourceSummary).toBe('agent 差点删错目录，owner 纠正');
  });

  it('date falls back to activations.activated_at when no approval exists', () => {
    insertArtifact('art-6', 'princ-6', JSON.stringify({ text: 'principle' }));
    insertActivation('art-6', '2026-08-02T08:00:00.000Z');

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-6', 'princ-6');
    expect(meta?.approvedAt).toBe('2026-08-02T08:00:00.000Z');
  });

  it('tolerates a principleId that is actually a legacy ruleId (joins miss → raw id)', () => {
    // No artifact references this id at all.
    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-legacy-7', 'R-legacy-7');
    expect(meta).toBeDefined();
    expect(meta?.title).toBe('R-legacy-7');
    expect(meta?.approvedAt).toBeUndefined();
  });

  it('returns undefined when both ids are missing', () => {
    expect(loadPrincipleReceiptMetadata(workspaceDir, undefined, undefined)).toBeUndefined();
  });

  it('malformed content_json degrades instead of throwing', () => {
    insertArtifact('art-8', 'princ-8', 'not-valid-json{{{');

    const meta = loadPrincipleReceiptMetadata(workspaceDir, 'R-8', 'princ-8');
    expect(meta?.title).toBe('princ-8');
  });
});
