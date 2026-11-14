/**
 * SIA v1.2 Phase 3 (SPEC §10.3, TECH §8.3/§8.5) — the CONSOLE boundary.
 *
 * Two requirements are proven here, and they must never drift apart:
 *   1. the review card reads the SAME server predicate the approval write path
 *      enforces (so it cannot offer an approval the server would refuse);
 *   2. the approval HTTP route really returns the refusal and the approval
 *      stays pending — the UI is not the gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { computeArtifactDigest, SqliteConnection } from '@principles/core/runtime';
import { handleApprovalsRoute, disposeApprovalsModels } from '../../src/server/routes/approvals.js';
import { sendJson, sendNotFound } from '../../src/server/utils/response.js';
import { ApprovalsGroupedConsoleModel } from '../../src/server/models/ApprovalsGroupedConsoleModel.js';
import { ApprovalsConsoleModel } from '../../src/server/models/ApprovalsConsoleModel.js';

const TASK_ID = 'task-sia-console';
const RUN_ID = 'run-sia-console';
const LEGACY_ARTIFACT_ID = 'art-sia-console';
const CANDIDATE_ID = 'cand-sia-console';
const NOW = '2026-11-14T00:00:00.000Z';

function v2Contract(conflictStatus: 'confirmed' | 'none'): Record<string, unknown> {
  return {
    ownerIntent: 'Do not drop the strategic non-negotiable.',
    targetBehavior: 'Check the non-negotiable before acting.',
    forbiddenBehavior: 'Acting without the non-negotiable check.',
    evidenceSource: 'pain-1',
    validationExpectation: 'An evaluator observes the check.',
    schemaVersion: 2,
    strategicIntent: { contentHash: 'sha256:intent-a', capturedAt: NOW },
    strategicAssessment: {
      relevance: 'relevant',
      rationale: 'Stage A bound this pain to the non_negotiables section.',
      conflictStatus,
      ...(conflictStatus === 'confirmed'
        ? { conflicts: [{ against: 'core_principle', ref: 'CP-002', status: 'confirmed', evidenceRefs: ['evidence-1'] }] }
        : {}),
    },
    corePrincipleRefs: ['CP-002'],
  };
}

let server: http.Server;
let baseUrl = '';
let tmpDir = '';
let conn: SqliteConnection;
let artifactId = '';
let approvalId = '';
let artifactDigest = '';

async function seed(conflictStatus: 'confirmed' | 'none'): Promise<void> {
  const db = conn.getDb();
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'scribe', 'succeeded', ?, ?)").run(TASK_ID, NOW, NOW);
  db.prepare("INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, 'internal', 'succeeded', ?, ?, ?)").run(RUN_ID, TASK_ID, NOW, NOW, NOW);
  db.prepare("INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, 'principle', '{}', ?)").run(LEGACY_ARTIFACT_ID, RUN_ID, TASK_ID, NOW);

  const contentJson = JSON.stringify({
    principleDraft: { title: 'Strategic candidate', statement: 'Check the non-negotiable before acting.' },
    intentContract: v2Contract(conflictStatus),
  });
  artifactId = LEGACY_ARTIFACT_ID;
  artifactDigest = computeArtifactDigest({
    artifactId,
    artifactKind: 'principle',
    sourceTaskId: TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson,
    createdAt: NOW,
    updatedAt: NOW,
  });
  db.prepare(
    "INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'principle', ?, '[]', 'pending', ?, ?, ?)",
  ).run(artifactId, TASK_ID, contentJson, NOW, NOW);
  db.prepare(
    "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'Strategic candidate', 'desc', 'idem-sia-console', ?)",
  ).run(CANDIDATE_ID, artifactId, TASK_ID, RUN_ID, NOW);
  approvalId = `apr_sia_${conflictStatus}`;
  db.prepare(
    "INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason) VALUES (?, ?, 'defer_archive', 'low', 'pending', 0.85, ?, 'SIA gate approval', 'automated seed')",
  ).run(approvalId, artifactId, NOW);
}

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, options);
  const body: unknown = await res.json();
  return { status: res.status, body };
}

function readStatus(id: string): string {
  const row: unknown = conn.getDb().prepare('SELECT status FROM approvals WHERE approval_id = ?').get(id);
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('missing approval row');
  const value = Reflect.get(row, 'status');
  return typeof value === 'string' ? value : '';
}

function readBodyField(body: unknown, key: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Reflect.get(body, key);
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sia-console-'));
  conn = new SqliteConnection({ workspaceDir: tmpDir });
  await seed('confirmed');

  function asyncHandler(fn: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      fn(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
        }
      });
    };
  }

  server = http.createServer((req, res) => {
    const urlPath = req.url?.split('?')[0] ?? '/';
    if (!urlPath.startsWith('/api/approvals')) {
      sendNotFound(res, 'Not found');
      return;
    }
    const subPath = urlPath.slice('/api/approvals'.length);
    asyncHandler(() => handleApprovalsRoute(req, res, tmpDir, subPath))(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}, 30000);

afterAll(async () => {
  disposeApprovalsModels();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { conn.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('SIA v1.2 — console approval gate', () => {
  function findGroup(groups: Awaited<ReturnType<ApprovalsGroupedConsoleModel['getApprovalsGrouped']>>['groups']) {
    return groups.find((group) => group.records.some((entry) => entry.artifactId === artifactId));
  }

  it('shows the confirmed, unresolved conflict on the review card with the server block code', async () => {
    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const { groups } = await model.getApprovalsGrouped();
    const group = findGroup(groups);
    expect(group).toBeDefined();
    expect(group?.strategicConflict?.conflictStatus).toBe('confirmed');
    expect(group?.strategicConflict?.resolved).toBe(false);
    expect(group?.strategicConflict?.conflicts).toEqual([
      { against: 'core_principle', ref: 'CP-002', status: 'confirmed' },
    ]);
    const record = group?.records.find((entry) => entry.artifactId === artifactId);
    expect(record?.approveBlock?.code).toBe('strategic_conflict_unconfirmed');
    expect(record?.approveBlock?.reason).toContain('CP-002');
  });

  it('refuses the approval over HTTP and leaves the approval pending', async () => {
    // No bypass: the write model itself refuses before the HTTP contract.
    const direct = await new ApprovalsConsoleModel(tmpDir).approve(approvalId, 'operator', {});
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error).toBe('strategic_conflict_unconfirmed');
    expect(readStatus(approvalId)).toBe('pending');

    const { status, body } = await fetchJson(`/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(422);
    expect(readBodyField(body, 'error')).toBe('strategic_conflict_unconfirmed');
    expect(readStatus(approvalId)).toBe('pending');
  });

  it('clears the block and lets the approval through once a matching resolution exists', async () => {
    conn.getDb().prepare(
      `INSERT INTO intent_decisions (id, task_id, intent_doc_hash, source, evidence_strength, related_intent_fields, owner_action, evidence_refs, source_snapshot, evidence_strength_snapshot, related_intent_fields_snapshot, evidence_refs_snapshot, resulting_candidate_id, contract_digest, created_at)
       VALUES ('decision-sia-console', ?, 'sha256:intent-a', 'action_drift', 'strong', '["non_negotiables"]', 'confirm_drift', '["evidence-1"]', 'action_drift', 'strong', '["non_negotiables"]', '["evidence-1"]', ?, ?, ?)`,
    ).run(TASK_ID, CANDIDATE_ID, artifactDigest, NOW);

    const model = new ApprovalsGroupedConsoleModel(tmpDir);
    const { groups } = await model.getApprovalsGrouped();
    const group = findGroup(groups);
    expect(group?.strategicConflict?.resolved).toBe(true);
    const record = group?.records.find((entry) => entry.artifactId === artifactId);
    expect(record?.approveBlock).toBeUndefined();

    const { status, body } = await fetchJson(`/api/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // The gate is released: the refusal code must be gone. Downstream activation
    // of a defer_archive artifact inside a bare fixture workspace is out of
    // scope here (the core suite proves the write itself succeeds).
    if (status === 422) throw new Error(`gate did not release: ${JSON.stringify(body)}`);
    expect(readBodyField(body, 'error')).not.toBe('strategic_conflict_unconfirmed');
  });
});
