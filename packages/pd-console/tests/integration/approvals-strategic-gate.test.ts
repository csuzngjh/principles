/**
 * SIA v1.2 Phase 3 (SPEC §10.3, TECH §8.3/§8.5) — the CONSOLE boundary.
 *
 * Two requirements are proven here, and they must never drift apart:
 *   1. the review card reads the SAME server predicate the approval write path
 *      enforces (so it cannot offer an approval the server would refuse);
 *   2. the approval HTTP route really returns the refusal and the approval
 *      stays pending — the UI is not the gate.
 *
 * REVIEW FIX (PR #2652 comment 3): each test owns a fresh workspace/server.
 * The shared fixture let one test's inserted decision leak into the others,
 * which made a green run depend on execution order.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { computeArtifactDigest, SqliteConnection } from '@principles/core/runtime';
import { CORE_PRINCIPLE_IDS } from '@principles/core/runtime';
import { handleApprovalsRoute, disposeApprovalsModels } from '../../src/server/routes/approvals.js';
import { sendJson, sendNotFound } from '../../src/server/utils/response.js';
import { ApprovalsGroupedConsoleModel } from '../../src/server/models/ApprovalsGroupedConsoleModel.js';
import { ApprovalsConsoleModel } from '../../src/server/models/ApprovalsConsoleModel.js';

const TASK_ID = 'task-sia-console';
const RUN_ID = 'run-sia-console';
const LEGACY_ARTIFACT_ID = 'art-sia-console';
/** The approval artifact is a pi_artifacts row — NEVER the legacy artifacts id. */
const PI_ARTIFACT_ID = 'pi-art-sia-console';
const CANDIDATE_ID = 'cand-sia-console';
const DREAMER_TASK_ID = `dreamer-${CANDIDATE_ID}-prompt`;
const DREAMER_ARTIFACT_ID = 'pi-art-dreamer-sia-console';
const NOW = '2026-11-14T00:00:00.000Z';
const INTENT_HASH = 'sha256:intent-a';

/** SPEC §20.2: only these conflict targets are an Owner-acceptable trade-off. */
interface ConflictSpec {
  readonly against: 'core_principle' | 'owner_intent';
  readonly ref: string;
}

/** P1 (PR #2663 final): a `core_principle` ref must resolve in the real registry. */
const [CORE_PRINCIPLE_ID] = CORE_PRINCIPLE_IDS;
if (CORE_PRINCIPLE_ID === undefined) throw new Error('the Core Principle registry is empty in this build');

const CORE_PRINCIPLE_CONFLICT: ConflictSpec = { against: 'core_principle', ref: CORE_PRINCIPLE_ID };
const TRADEOFF_CONFLICT: ConflictSpec = { against: 'owner_intent', ref: 'why' };

function v2Contract(
  conflictStatus: 'confirmed' | 'none',
  conflict: ConflictSpec = CORE_PRINCIPLE_CONFLICT,
): Record<string, unknown> {
  return {
    ownerIntent: 'Do not drop the strategic non-negotiable.',
    targetBehavior: 'Check the non-negotiable before acting.',
    forbiddenBehavior: 'Acting without the non-negotiable check.',
    evidenceSource: 'pain-1',
    validationExpectation: 'An evaluator observes the check.',
    schemaVersion: 2,
    strategicIntent: { contentHash: INTENT_HASH, capturedAt: NOW },
    strategicAssessment: {
      relevance: 'relevant',
      rationale: 'Stage A bound this pain to the non_negotiables section.',
      conflictStatus,
      ...(conflictStatus === 'confirmed'
        ? { conflicts: [{ ...conflict, status: 'confirmed', evidenceRefs: ['evidence-1'] }] }
        : {}),
    },
    ...(conflict.against === 'core_principle' ? { corePrincipleRefs: [CORE_PRINCIPLE_ID] } : {}),
  };
}

interface Fixture {
  readonly server: http.Server;
  readonly baseUrl: string;
  readonly tmpDir: string;
  readonly conn: SqliteConnection;
  readonly artifactId: string;
  readonly approvalId: string;
  readonly artifactDigest: string;
}

let fixture: Fixture | null = null;

async function seed(
  conflictStatus: 'confirmed' | 'none',
  conflict: ConflictSpec = CORE_PRINCIPLE_CONFLICT,
): Promise<Fixture> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-sia-console-'));
  const conn = new SqliteConnection({ workspaceDir: tmpDir });
  const db = conn.getDb();
  db.prepare("INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at) VALUES (?, 'scribe', 'succeeded', ?, ?)").run(TASK_ID, NOW, NOW);
  db.prepare("INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at) VALUES (?, ?, 'internal', 'succeeded', ?, ?, ?)").run(RUN_ID, TASK_ID, NOW, NOW, NOW);
  db.prepare("INSERT INTO artifacts (artifact_id, run_id, task_id, artifact_kind, content_json, created_at) VALUES (?, ?, ?, 'principle', '{}', ?)").run(LEGACY_ARTIFACT_ID, RUN_ID, TASK_ID, NOW);

  const contentJson = JSON.stringify({
    principleDraft: { title: 'Strategic candidate', statement: 'Check the non-negotiable before acting.' },
    intentContract: v2Contract(conflictStatus, conflict),
    // REVIEW FIX (PR #2652 P0-1): production maps an approval artifact back to
    // its candidate through the dreamer lineage. The fixture must model that
    // relation instead of relying on `principle_candidates.artifact_id`, which
    // points at the LEGACY artifacts row and is a different id namespace.
    sourceTrace: { dreamerArtifactId: DREAMER_ARTIFACT_ID },
  });
  const artifactId = PI_ARTIFACT_ID;
  const artifactDigest = computeArtifactDigest({
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
    "INSERT INTO tasks (task_id, task_kind, status, diagnostic_json, created_at, updated_at) VALUES (?, 'dreamer', 'succeeded', ?, ?, ?)",
  ).run(DREAMER_TASK_ID, JSON.stringify({ candidateId: CANDIDATE_ID }), NOW, NOW);
  db.prepare(
    "INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'dreamer_seed', ?, '[]', 'pending', '{}', ?, ?)",
  ).run(DREAMER_ARTIFACT_ID, DREAMER_TASK_ID, NOW, NOW);
  db.prepare(
    "INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at) VALUES (?, 'principle', ?, '[]', 'pending', ?, ?, ?)",
  ).run(artifactId, TASK_ID, contentJson, NOW, NOW);
  db.prepare(
    "INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, idempotency_key, created_at) VALUES (?, ?, ?, ?, 'Strategic candidate', 'desc', 'idem-sia-console', ?)",
  ).run(CANDIDATE_ID, LEGACY_ARTIFACT_ID, TASK_ID, RUN_ID, NOW);
  const approvalId = `apr_sia_${conflictStatus}`;
  db.prepare(
    "INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason) VALUES (?, ?, 'defer_archive', 'low', 'pending', 0.85, ?, 'SIA gate approval', 'automated seed')",
  ).run(approvalId, artifactId, NOW);

  function asyncHandler(fn: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      fn(req, res).catch((err: unknown) => {
        if (!res.headersSent) {
          sendJson(res, 500, { success: false, error: err instanceof Error ? err.message : 'Internal error' });
        }
      });
    };
  }

  const server = http.createServer((req, res) => {
    const urlPath = req.url?.split('?')[0] ?? '/';
    if (!urlPath.startsWith('/api/approvals')) {
      sendNotFound(res, 'Not found');
      return;
    }
    const subPath = urlPath.slice('/api/approvals'.length);
    asyncHandler(() => handleApprovalsRoute(req, res, tmpDir, subPath))(req, res);
  });
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, () => {
      const addr = server.address();
      resolve(addr && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : '');
    });
  });
  return { server, baseUrl, tmpDir, conn, artifactId, approvalId, artifactDigest };
}

function current(): Fixture {
  if (fixture === null) throw new Error('fixture not initialised');
  return fixture;
}

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${current().baseUrl}${urlPath}`, options);
  const body: unknown = await res.json();
  return { status: res.status, body };
}

function readStatus(id: string): string {
  const row: unknown = current().conn.getDb().prepare('SELECT status FROM approvals WHERE approval_id = ?').get(id);
  if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('missing approval row');
  const value = Reflect.get(row, 'status');
  return typeof value === 'string' ? value : '';
}

function readBodyField(body: unknown, key: string): unknown {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Reflect.get(body, key);
}

async function teardown(): Promise<void> {
  disposeApprovalsModels();
  if (fixture === null) return;
  await new Promise<void>((resolve) => fixture!.server.close(() => resolve()));
  try { fixture.conn.close(); } catch { /* ignore */ }
  try { fs.rmSync(fixture.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  fixture = null;
}

/** Swap the default Core-Principle fixture for a scenario-specific one. */
async function reseed(
  conflictStatus: 'confirmed' | 'none',
  conflict: ConflictSpec = CORE_PRINCIPLE_CONFLICT,
): Promise<void> {
  await teardown();
  fixture = await seed(conflictStatus, conflict);
}

function insertDecision(id: string, coveredSections: readonly string[]): void {
  const fields = JSON.stringify(coveredSections);
  current().conn.getDb().prepare(
    `INSERT INTO intent_decisions (id, task_id, intent_doc_hash, source, evidence_strength, related_intent_fields, owner_action, evidence_refs, source_snapshot, evidence_strength_snapshot, related_intent_fields_snapshot, evidence_refs_snapshot, resulting_candidate_id, contract_digest, created_at)
     VALUES (?, ?, ?, 'action_drift', 'strong', ?, 'confirm_drift', '["evidence-1"]', 'action_drift', 'strong', ?, '["evidence-1"]', ?, ?, ?)`,
  ).run(id, TASK_ID, INTENT_HASH, fields, fields, CANDIDATE_ID, current().artifactDigest, NOW);
}

beforeEach(async () => {
  fixture = await seed('confirmed');
}, 30000);

afterEach(teardown);

describe('SIA v1.2 — console approval gate', () => {
  function findGroup(groups: Awaited<ReturnType<ApprovalsGroupedConsoleModel['getApprovalsGrouped']>>['groups']) {
    return groups.find((group) => group.records.some((entry) => entry.artifactId === current().artifactId));
  }

  it('shows the confirmed, unresolved conflict on the review card with the server block code', async () => {
    const model = new ApprovalsGroupedConsoleModel(current().tmpDir);
    const { groups } = await model.getApprovalsGrouped();
    const group = findGroup(groups);
    expect(group).toBeDefined();
    const record = group?.records.find((entry) => entry.artifactId === current().artifactId);
    // REVIEW FIX (PR #2652 P1-5): the verdict is per-approval.
    expect(record?.strategicConflict?.conflictStatus).toBe('confirmed');
    expect(record?.strategicConflict?.resolved).toBe(false);
    expect(record?.strategicConflict?.conflicts).toEqual([
      { against: 'core_principle', ref: CORE_PRINCIPLE_ID, status: 'confirmed' },
    ]);
    expect(record?.approveBlock?.code).toBe('strategic_conflict_unconfirmed');
    expect(record?.approveBlock?.reason).toContain(CORE_PRINCIPLE_ID);
  });

  it('never exposes a group-level strategic verdict (each record owns its own)', async () => {
    const model = new ApprovalsGroupedConsoleModel(current().tmpDir);
    const { groups } = await model.getApprovalsGrouped();
    for (const group of groups) {
      expect(Object.hasOwn(group, 'strategicConflict')).toBe(false);
    }
  });

  it('refuses the approval over HTTP and leaves the approval pending', async () => {
    // No bypass: the write model itself refuses before the HTTP contract.
    const direct = await new ApprovalsConsoleModel(current().tmpDir).approve(current().approvalId, 'operator', {});
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error).toBe('strategic_conflict_unconfirmed');
    expect(readStatus(current().approvalId)).toBe('pending');

    const { status, body } = await fetchJson(`/api/approvals/${current().approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(422);
    expect(readBodyField(body, 'error')).toBe('strategic_conflict_unconfirmed');
    expect(readStatus(current().approvalId)).toBe('pending');
  });

  it('clears the block and records the approval once a matching resolution exists', async () => {
    // SPEC §20.2: only an ordinary strategic trade-off is Owner-acceptable.
    await reseed('confirmed', TRADEOFF_CONFLICT);
    insertDecision('decision-sia-console', ['why']);

    const model = new ApprovalsGroupedConsoleModel(current().tmpDir);
    const { groups } = await model.getApprovalsGrouped();
    const group = findGroup(groups);
    const record = group?.records.find((entry) => entry.artifactId === current().artifactId);
    expect(record?.strategicConflict?.resolved).toBe(true);
    expect(record?.approveBlock).toBeUndefined();

    const { status, body } = await fetchJson(`/api/approvals/${current().approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    // REVIEW FIX (PR #2652 comment 4): assert a CONCRETE outcome instead of
    // "not 422". Downstream activation of a defer_archive artifact inside a
    // bare fixture workspace has two legitimate terminal results, and each is
    // asserted explicitly with its persisted approval state.
    // REVIEW FIX (PR #2652 comment 4): assert a CONCRETE outcome instead of
    // "not 422". The gate is released, so the request reaches the downstream
    // activation stage. Inside this bare fixture workspace there is no ledger
    // principle to activate (minting is owned by intake, out of scope here),
    // so the accepted terminal result is a rollback — asserted explicitly,
    // together with the persisted approval state and the recovery next action.
    expect(status).toBe(500);
    expect(readBodyField(body, 'success')).toBe(false);
    expect(readBodyField(body, 'error')).toBe('activation_failed');
    expect(readBodyField(body, 'approvalRolledBack')).toBe(true);
    expect(readBodyField(body, 'nextAction')).toBe('ensure_intake_minted_a_ledger_principle_for_this_candidate_before_internalization');
    expect(readStatus(current().approvalId)).toBe('pending');
  });

  it('never clears a Core Principle conflict, even with a matching Owner decision', async () => {
    // SPEC §20.2 / P1-2: a decision that names the conflict target is NOT enough
    // when the conflict is against a PD Core Principle — that is a hard block.
    insertDecision('decision-core-principle', [CORE_PRINCIPLE_ID, 'non_negotiables']);

    const model = new ApprovalsGroupedConsoleModel(current().tmpDir);
    const { groups } = await model.getApprovalsGrouped();
    const group = findGroup(groups);
    const record = group?.records.find((entry) => entry.artifactId === current().artifactId);
    expect(record?.strategicConflict?.resolved).toBe(false);
    expect(record?.approveBlock?.code).toBe('strategic_conflict_unconfirmed');
    expect(record?.approveBlock?.reason).toContain('core_principle_conflict');

    const { status } = await fetchJson(`/api/approvals/${current().approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(status).toBe(422);
    expect(readStatus(current().approvalId)).toBe('pending');
  });

  // P2-1: the review card must learn about the fence from EVERY channel, and a
  // record that already reached a terminal state must never be re-fenced.
  function insertExtraApproval(id: string, channel: string, status: string): void {
    current().conn.getDb().prepare(
      `INSERT INTO approvals (approval_id, artifact_id, channel, risk_level, status, confidence, requested_at, summary, trigger_reason)
       VALUES (?, ?, ?, 'medium', ?, 0.8, ?, ?, 'P2-1 channel coverage')`,
    ).run(id, current().artifactId, channel, status, NOW, `${channel} summary`);
  }

  it('attaches the strategic fence to prompt and code_tool_hook, not only defer_archive', async () => {
    insertExtraApproval('apr-channel-prompt', 'prompt', 'pending');
    insertExtraApproval('apr-channel-hook', 'code_tool_hook', 'pending');

    const { groups } = await new ApprovalsGroupedConsoleModel(current().tmpDir).getApprovalsGrouped();
    const records = findGroup(groups)?.records ?? [];
    for (const channel of ['prompt', 'code_tool_hook', 'defer_archive'] as const) {
      const record = records.find((entry) => entry.channel === channel && entry.status === 'pending');
      expect(record?.approveBlock?.code).toBe('strategic_conflict_unconfirmed');
      // reason / nextAction stay in the payload for diagnostics and audit.
      expect(record?.approveBlock?.reason).toBeTruthy();
      expect(record?.approveBlock?.nextAction).toBeTruthy();
    }
  });

  it('never fences a record that is already approved or rejected', async () => {
    insertExtraApproval('apr-channel-approved', 'prompt', 'approved');
    insertExtraApproval('apr-channel-rejected', 'code_tool_hook', 'rejected');

    const { groups } = await new ApprovalsGroupedConsoleModel(current().tmpDir).getApprovalsGrouped();
    const records = findGroup(groups)?.records ?? [];
    expect(records.find((entry) => entry.status === 'approved')?.approveBlock).toBeUndefined();
    expect(records.find((entry) => entry.status === 'rejected')?.approveBlock).toBeUndefined();
  });
});
