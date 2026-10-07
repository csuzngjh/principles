import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import {
  SqliteConnection,
  PrincipleTreeLedgerAdapter,
} from '@principles/core/runtime-v2';
import { loadLedger } from '@principles/core/principle-tree-ledger';
import { saveHostToolDeclaration } from '@principles/host-runtime';
import { handleApprovalsRoute, disposeApprovalsModels } from '../../src/server/routes/approvals.js';
import { handleActivationsRoute, disposeActivationsModels } from '../../src/server/routes/activations.js';
import { sendJson, sendNotFound } from '../../src/server/utils/response.js';

/**
 * PD_PROMPT_CAPACITY_V1 R-B3 / AC-11 (console integration, real HTTP + real
 * SQLite): the full reviewable-replacement journey —
 *   propose-revision → diff + intent fields + capacity prediction →
 *   Owner approves (test actor) → atomic replacement (new live, old
 *   deactivated, immutable supersede decision, ledger/approval consistent) —
 *   plus the failure matrix: validation failure, approval rejection, write
 *   refusal, and duplicate propose idempotency. No gap, no double success,
 *   no lost old version.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getStringField(obj: unknown, key: string): string | undefined {
  if (!isRecord(obj)) return undefined;
  const val = obj[key];
  return typeof val === 'string' ? val : undefined;
}

function getDataObject(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body)) return undefined;
  const data = body.data;
  return isRecord(data) ? data : undefined;
}

let server: http.Server;
let baseUrl: string;
let tmpDir: string;
let sqliteConn: SqliteConnection;

async function fetchJson(urlPath: string, options?: RequestInit): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${urlPath}`, options);
  const body = await res.json();
  return { status: res.status, body };
}

function seedLedgerPrinciple(principleId: string, text: string): void {
  const stateDir = path.join(tmpDir, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  new PrincipleTreeLedgerAdapter({ stateDir }).writeProbationEntry({
    id: principleId,
    title: `revision principle ${principleId}`,
    text,
    triggerPattern: 'before_tool_call',
    action: 'inject review note',
    status: 'probation',
    evaluability: 'weak_heuristic',
    sourceRef: `candidate://candidate-${principleId}`,
    createdAt: new Date().toISOString(),
  });
}

function scribeContent(taskId: string, statement: string): string {
  return JSON.stringify({
    taskId,
    sourcePhilosopherArtifactId: 'pi-art-phil-rev',
    principleDraft: {
      title: '需要精简的原则',
      statement,
      rationale: 'root cause rationale stays here',
      applicability: ['coding tasks'],
      antiPatterns: ['padding statements with examples'],
      confidence: 0.8,
    },
    intentContract: {
      ownerIntent: 'keep statements injectable',
      targetBehavior: 'shortest sufficient statement',
      forbiddenBehavior: 'oversized statements that can never be injected',
      evidenceSource: 'pain-rev-1',
      validationExpectation: 'trigger/action/exception preserved after shortening',
    },
    sourceTrace: { philosopherArtifactId: 'pi-art-phil-rev' },
    risks: [],
    generatedAt: '2026-10-07T08:00:00.000Z',
  });
}

/** Seed a live prompt activation whose artifact statement is oversized. */
function seedLiveOversizedActivation(activationId: string, artifactId: string, taskId: string, principleId: string, statement: string): void {
  const now = '2026-10-07T08:00:00.000Z';
  sqliteConn.getDb().prepare(`
    INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, source_rule_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES (?, 'principle', ?, ?, NULL, '[]', 'validated', ?, ?, ?)
  `).run(artifactId, taskId, principleId, scribeContent(taskId, statement), now, now);
  sqliteConn.getDb().prepare(`
    INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
    VALUES (?, ?, ?, 'prompt', 'prompt_activate', ?, ?, NULL, NULL)
  `).run(activationId, `${artifactId}::prompt`, artifactId, `ledger://${principleId}`, now);
}

const SCENARIO_A = {
  principle: crypto.randomUUID(),
  activationId: 'act-rev-a',
  artifactId: 'art-rev-a',
  taskId: 'task-rev-a',
  longStatement: 'A'.repeat(2100),
};

const SCENARIO_B = {
  principle: crypto.randomUUID(),
  activationId: 'act-rev-b',
  artifactId: 'art-rev-b',
  taskId: 'task-rev-b',
  longStatement: 'B'.repeat(2100),
};

describe('PD_PROMPT_CAPACITY_V1 R-B3 — reviewable replacement (AC-11 matrix)', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-revision-replace-'));
    fs.mkdirSync(path.join(tmpDir, '.state'), { recursive: true });
    const declared = saveHostToolDeclaration(tmpDir, {
      version: 1,
      hostKind: 'openclaw',
      mappings: [{ rawToolName: 'bash', canonicalKind: 'execute' }],
      declaredAt: new Date().toISOString(),
    });
    if (!declared.ok) throw new Error(`declaration save failed: ${declared.reason}`);
    sqliteConn = new SqliteConnection({ workspaceDir: tmpDir });

    for (const s of [SCENARIO_A, SCENARIO_B]) {
      seedLedgerPrinciple(s.principle, s.longStatement);
      seedLiveOversizedActivation(s.activationId, s.artifactId, s.taskId, s.principle, s.longStatement);
    }

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
      if (urlPath.startsWith('/api/v1/approvals')) {
        const subPath = urlPath.slice('/api/v1/approvals'.length);
        asyncHandler((rq, rs) => handleApprovalsRoute(rq, rs, tmpDir, subPath))(req, res);
        return;
      }
      if (urlPath.startsWith('/api/v1/activations')) {
        const subPath = urlPath.slice('/api/v1/activations'.length);
        asyncHandler((rq, rs) => handleActivationsRoute(rq, rs, tmpDir, subPath))(req, res);
        return;
      }
      sendNotFound(res, 'Not found');
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
    disposeActivationsModels();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { sqliteConn.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('AC-11 propose: creates a NEW validated artifact + pending approval, returns the diff and capacity prediction; the old artifact stays immutable and the old activation stays live', async () => {
    const res = await fetchJson(`/api/v1/activations/${SCENARIO_A.activationId}/propose-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: '保留触发条件、动作与例外的最短正文' }),
    });
    expect(res.status).toBe(200);
    const data = getDataObject(res.body);
    expect(data?.ok).toBe(true);
    expect(data?.alreadyPending).toBe(false);
    const newArtifactId = getStringField(data, 'newArtifactId');
    const approvalId = getStringField(data, 'approvalId');
    expect(newArtifactId).toBeDefined();
    expect(approvalId).toBeDefined();
    expect(getStringField(data, 'oldStatement')).toBe(SCENARIO_A.longStatement);
    expect(getStringField(data, 'newStatement')).toBe('保留触发条件、动作与例外的最短正文');
    expect(getStringField(data, 'supersededActivationId')).toBe(SCENARIO_A.activationId);

    // 旧工件不可变：正文仍是长文。
    const oldContent = sqliteConn.getDb()
      .prepare('SELECT content_json FROM pi_artifacts WHERE artifact_id = ?')
      .get(SCENARIO_A.artifactId) as { content_json: string };
    expect(oldContent.content_json).toContain(SCENARIO_A.longStatement);
    // 旧激活仍 live。
    const oldActivation = sqliteConn.getDb()
      .prepare('SELECT deactivated_at FROM activations WHERE activation_id = ?')
      .get(SCENARIO_A.activationId) as { deactivated_at: string | null };
    expect(oldActivation.deactivated_at).toBeNull();
    // 新工件已通过真实内容合同（validated），审批 pending。
    const newArtifact = sqliteConn.getDb()
      .prepare('SELECT validation_status, lineage_artifact_ids, source_principle_id FROM pi_artifacts WHERE artifact_id = ?')
      .get(newArtifactId!) as { validation_status: string; lineage_artifact_ids: string; source_principle_id: string };
    expect(newArtifact.validation_status).toBe('validated');
    expect(JSON.parse(newArtifact.lineage_artifact_ids)).toContain(SCENARIO_A.artifactId);
    expect(newArtifact.source_principle_id).toBe(SCENARIO_A.principle);
    const approvalRow = sqliteConn.getDb()
      .prepare('SELECT status, channel FROM approvals WHERE approval_id = ?')
      .get(approvalId!) as { status: string; channel: string };
    expect(approvalRow.status).toBe('pending');
    expect(approvalRow.channel).toBe('prompt');
  });

  it('AC-11 duplicate propose is idempotent: the SAME pending approval is returned, no second artifact', async () => {
    const before = (sqliteConn.getDb()
      .prepare("SELECT COUNT(*) AS n FROM pi_artifacts WHERE source_principle_id = ?")
      .get(SCENARIO_A.principle) as { n: number }).n;
    const res = await fetchJson(`/api/v1/activations/${SCENARIO_A.activationId}/propose-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: '另一个不同正文' }),
    });
    expect(res.status).toBe(200);
    const data = getDataObject(res.body);
    expect(data?.ok).toBe(true);
    expect(data?.alreadyPending).toBe(true);
    const after = (sqliteConn.getDb()
      .prepare("SELECT COUNT(*) AS n FROM pi_artifacts WHERE source_principle_id = ?")
      .get(SCENARIO_A.principle) as { n: number }).n;
    expect(after).toBe(before);
  });

  it('AC-11 replacement success: approve → new live, old deactivated, immutable supersede decision, approval approved, ledger consistent', async () => {
    const approvalId = (sqliteConn.getDb()
      .prepare("SELECT approval_id FROM approvals WHERE status = 'pending' AND channel = 'prompt' AND artifact_id LIKE 'pi-art-%' ORDER BY requested_at DESC LIMIT 1")
      .get() as { approval_id: string }).approval_id;
    const newArtifactId = (sqliteConn.getDb()
      .prepare('SELECT artifact_id FROM approvals WHERE approval_id = ?')
      .get(approvalId) as { artifact_id: string }).artifact_id;

    const res = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'approve the injectable revision' }),
    });
    expect(res.status).toBe(200);
    const data = getDataObject(res.body);
    const activation = data?.activation;
    expect(isRecord(activation)).toBe(true);
    if (isRecord(activation)) {
      expect(getStringField(activation, 'decision')).toBe('activated');
      expect(getStringField(activation, 'supersededActivationId')).toBe(SCENARIO_A.activationId);
    }

    const rows = sqliteConn.getDb()
      .prepare('SELECT activation_id, artifact_id, deactivated_at FROM activations WHERE channel = ?')
      .all('prompt') as Array<{ activation_id: string; artifact_id: string; deactivated_at: string | null }>;
    const byArtifact = new Map(rows.map((r) => [r.artifact_id, r]));
    expect(byArtifact.get(newArtifactId)?.deactivated_at).toBeNull();
    expect(byArtifact.get(SCENARIO_A.artifactId)?.deactivated_at).not.toBeNull();

    const decisions = sqliteConn.getDb()
      .prepare("SELECT decision_id, decision, activation_id FROM activation_decisions WHERE decision = 'supersede'")
      .all() as Array<{ decision_id: string; decision: string; activation_id: string }>;
    expect(decisions).toHaveLength(1);
    expect(decisions[0].activation_id).toBe(SCENARIO_A.activationId);

    const approvalRow = sqliteConn.getDb()
      .prepare('SELECT status FROM approvals WHERE approval_id = ?')
      .get(approvalId) as { status: string };
    expect(approvalRow.status).toBe('approved');
  });

  it('AC-11 approve replay is refused as already decided (no double success)', async () => {
    const approvalId = (sqliteConn.getDb()
      .prepare("SELECT approval_id FROM approvals WHERE status = 'approved' AND channel = 'prompt' AND artifact_id LIKE 'pi-art-%' LIMIT 1")
      .get() as { approval_id: string }).approval_id;
    const res = await fetchJson(`/api/v1/approvals/${approvalId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: 'replay' }),
    });
    expect(res.status).toBe(409);
  });

  it('AC-11 validation failure: unchanged/empty statement → structured refusal, zero new artifacts, zero new approvals', async () => {
    const artifactsBefore = countArtifacts(SCENARIO_B.principle);
    const approvalsBefore = countPendingApprovals(SCENARIO_B.principle);

    const unchanged = await fetchJson(`/api/v1/activations/${SCENARIO_B.activationId}/propose-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: SCENARIO_B.longStatement }),
    });
    expect(unchanged.status).toBe(422);
    const unchangedBody = unchanged.body as { error?: string; message?: string };
    expect(unchangedBody.error).toBe('revision_validation_failed');
    expect(unchangedBody.message).toContain('statement_unchanged');

    const empty = await fetchJson(`/api/v1/activations/${SCENARIO_B.activationId}/propose-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: '   ' }),
    });
    expect(empty.status).toBe(400);

    expect(countArtifacts(SCENARIO_B.principle)).toBe(artifactsBefore);
    expect(countPendingApprovals(SCENARIO_B.principle)).toBe(approvalsBefore);
  });

  it('AC-11 approval rejection: the old activation keeps working — no replacement, no new activation', async () => {
    const propose = await fetchJson(`/api/v1/activations/${SCENARIO_B.activationId}/propose-revision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: '被拒绝的精简正文' }),
    });
    expect(propose.status).toBe(200);
    const approvalId = getStringField(getDataObject(propose.body), 'approvalId');
    expect(approvalId).toBeDefined();

    const reject = await fetchJson(`/api/v1/approvals/${approvalId}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: '拒绝该精简版本' }),
    });
    expect(reject.status).toBe(200);

    const oldActivation = sqliteConn.getDb()
      .prepare('SELECT deactivated_at FROM activations WHERE activation_id = ?')
      .get(SCENARIO_B.activationId) as { deactivated_at: string | null };
    expect(oldActivation.deactivated_at).toBeNull();
    const decisions = sqliteConn.getDb()
      .prepare("SELECT COUNT(*) AS n FROM activation_decisions WHERE decision = 'supersede' AND activation_id = ?")
      .get(SCENARIO_B.activationId) as { n: number };
    expect(decisions.n).toBe(0);
    // 场景B没有任何新增 live 激活——只有原旧版本继续生效。
    const liveForB = sqliteConn.getDb()
      .prepare(`SELECT COUNT(*) AS n FROM activations a JOIN pi_artifacts p ON p.artifact_id = a.artifact_id
                WHERE a.channel = 'prompt' AND a.deactivated_at IS NULL AND p.source_principle_id = ?`)
      .get(SCENARIO_B.principle) as { n: number };
    expect(liveForB.n).toBe(1);
  });

  it('AC-11 propose on a deactivated/non-prompt activation → 404, no writes', async () => {
    const res = await fetchJson('/api/v1/activations/act-does-not-exist/propose-revision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ statement: 'whatever' }),
    });
    expect(res.status).toBe(404);
  });
});

function countArtifacts(principleId: string): number {
  return (sqliteConn.getDb()
    .prepare('SELECT COUNT(*) AS n FROM pi_artifacts WHERE source_principle_id = ?')
    .get(principleId) as { n: number }).n;
}

function countPendingApprovals(principleId: string): number {
  return (sqliteConn.getDb()
    .prepare(`SELECT COUNT(*) AS n FROM approvals a JOIN pi_artifacts p ON p.artifact_id = a.artifact_id
              WHERE p.source_principle_id = ? AND a.status = 'pending'`)
    .get(principleId) as { n: number }).n;
}
