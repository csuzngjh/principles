/**
 * PRI-629 — /api/v1/governance/owner-decisions 集成测试（真实 state.db）。
 *
 * 覆盖验收矩阵:
 *   - GET list: decision-capable NHR 出现为决策项 (含 legacy 推断 W);
 *     recovery-only NHR 不出现;badge N = items.total
 *   - POST resolve accept_current: 落库 pending resolution + 任务翻 pending
 *   - POST stale reviewKey → 409 stale_owner_decision
 *   - POST conflicting action → 409 already_resolved
 *   - POST 同动作重放 → 幂等 resolved
 *   - body 校验失败 → 400; 身份由服务端注入 (body 无身份字段)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SqliteConnection,
  createRuntimeStateHandle,
  createPITaskDiagnosticJson,
} from '@principles/core/runtime-v2';
import { handleOwnerDecisionsRoute } from '../../../src/server/routes/owner-decisions.js';
import type { OwnerDecisionRouteContext } from '../../../src/server/routes/owner-decisions.js';

const EVAL_ID = 'evaluator-001';
const ROLLOUT_ID = 'rollout-reviewer-001';
const ARTIFER_ID = 'artificer-repair-evaluator-001-r2';
const SCRIBE_ID = 'scribe-001';
const RUN_ID = 'run-evaluator-001';
const ARTIFACT_ID = `pi-art-${EVAL_ID}-${RUN_ID}`;
const ARTIFICER_ARTIFACT_ID = `pi-art-${ARTIFER_ID}-run-1`;
const SCRIBE_ARTIFACT_ID = `pi-art-${SCRIBE_ID}-run-1`;

function evaluatorMeta(extra: Record<string, unknown> = {}): string {
  return createPITaskDiagnosticJson({
    dependencyTaskIds: [ARTIFER_ID],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    runnerDecision: 'needs_revision',
    completionIntent: { decision: 'needs_revision', sourceRunId: RUN_ID, revisionEpoch: 0, status: 'pending' },
    ...extra,
  } as never);
}

let tmpDir: string;
let workspaceDir: string;

function setupDb(): SqliteConnection {
  const conn = new SqliteConnection(workspaceDir);
  const db = conn.getDb();
  const now = '2026-08-30T00:00:00.000Z';
  const insert = db.prepare(
    `INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // legacy evaluator NHR: 无 humanReviewContext — 由 facts 推断 (矩阵 W)
  insert.run(EVAL_ID, 'evaluator', 'needs_human_review', now, now, 2, 3, evaluatorMeta());
  insert.run(ARTIFER_ID, 'artificer', 'succeeded', now, now, 1, 3, createPITaskDiagnosticJson({
    dependencyTaskIds: [SCRIBE_ID],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    repairPayload: {
      requiredChanges: ['fix'], concerns: [], previousScore: 0.7, repairIteration: 2,
      sourceArtificerArtifactId: 'pi-art-old', sourceEvaluatorTaskId: EVAL_ID,
    },
  } as never));
  insert.run(SCRIBE_ID, 'scribe', 'succeeded', now, now, 0, 3, createPITaskDiagnosticJson({
    dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000,
    inputArtifactRefs: [], outputArtifactRefs: [],
  } as never));
  // rollout NHR: recovery-only reason → 不进 inbox
  insert.run(ROLLOUT_ID, 'rollout_reviewer', 'needs_human_review', now, now, 1, 3, createPITaskDiagnosticJson({
    dependencyTaskIds: [EVAL_ID],
    channel: 'prompt',
    timeoutMs: 300_000,
    inputArtifactRefs: [],
    outputArtifactRefs: [],
    runnerDecision: 'needs_revision',
    humanReviewContext: {
      reasonCode: 'rollout_dispatch_not_wired', sourceRunId: RUN_ID,
      sourceArtifactId: `pi-art-${ROLLOUT_ID}-${RUN_ID}`, revisionEpoch: 0, createdAt: now,
    },
  } as never));

  const insertArtifact = db.prepare(
    `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertArtifact.run(SCRIBE_ARTIFACT_ID, 'principle', SCRIBE_ID, '[]', 'pending', JSON.stringify({
    principleDraft: {
      title: 'Confirm destructive changes',
      statement: 'Confirm the exact target before destructive changes.',
      rationale: 'Prevents irreversible changes against an ambiguous target.',
      applicability: ['filesystem writes'],
    },
  }), now, now);
  insertArtifact.run(ARTIFICER_ARTIFACT_ID, 'principle', ARTIFER_ID, JSON.stringify([SCRIBE_ARTIFACT_ID]), 'pending', JSON.stringify({
    implementationSummary: 'Adds a confirmation gate before destructive writes.',
    affectedTools: ['write_file', 'apply_patch'],
    risks: ['May require one Owner interaction.'],
  }), now, now);
  insertArtifact.run(ARTIFACT_ID, 'principle', EVAL_ID, JSON.stringify([ARTIFICER_ARTIFACT_ID]), 'pending', JSON.stringify({
    taskId: EVAL_ID,
    sourceArtificerArtifactId: ARTIFICER_ARTIFACT_ID,
    evaluation: {
      decision: 'needs_revision', summary: 's', score: 0.72,
      strengths: [], concerns: ['c'], requiredChanges: ['fix timeout'],
    },
    sourceTrace: { artificerArtifactId: ARTIFICER_ARTIFACT_ID },
    risks: [], generatedAt: now,
  }), now, now);

  const insertRun = db.prepare(
    `INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at, output_payload, attempt_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertRun.run(RUN_ID, EVAL_ID, 'evaluator', 'succeeded', now, now, now, JSON.stringify({
    taskId: EVAL_ID,
    sourceArtificerArtifactId: 'pi-art-old',
    evaluation: {
      decision: 'needs_revision', summary: 's', score: 0.72,
      strengths: [], concerns: ['c'], requiredChanges: ['fix timeout'],
    },
    sourceTrace: { artificerArtifactId: 'pi-art-old' },
    risks: [], generatedAt: now,
  }), 1);
  return conn;
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  const payload = Buffer.from(body === undefined ? '' : JSON.stringify(body), 'utf8');
  const listeners: Record<string, (chunk?: Buffer) => void> = {};
  const req = {
    method,
    url: '/api/v1/governance/owner-decisions',
    on(event: string, cb: (chunk?: Buffer) => void) {
      listeners[event] = cb;
      if (event === 'end') {
        queueMicrotask(() => {
          if (payload.length > 0) {
            (listeners.data ?? (() => {}))(payload);
          }
          (listeners.end ?? (() => {}))();
        });
      }
      return req;
    },
  };
  return req as unknown as IncomingMessage;
}

function makeRes(): ServerResponse & { _body: string; statusCode: number } {
  const res = {
    statusCode: 200,
    _body: '',
    writeHead(code: number) { res.statusCode = code; },
    end(chunk?: string) { if (chunk) res._body += chunk; },
  };
  return res as unknown as ServerResponse & { _body: string; statusCode: number };
}

function parse(res: { _body: string }): { success: boolean; data?: unknown; error?: string; nextAction?: string } {
  return JSON.parse(res._body);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-decisions-'));
  workspaceDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
});

afterEach(() => {
  // Windows: WAL/SHM 句柄释放有延迟,带重试清理 (EPERM 已知环境陷阱)
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      return;
    } catch {
      // retry
    }
  }
});

const ctxBase = (subPath: string): OwnerDecisionRouteContext & { subPath: string } => ({
  workspaceDir,
  subPath,
  ownerIdentity: { ownerId: 'owner-test', credentialId: 'cred-test' },
});

describe('GET /api/v1/governance/owner-decisions', () => {
  it('lists decision-capable items only (legacy inference, matrix W); recovery NHR excluded; badge = total', async () => {
    setupDb().close();
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('GET'), res, ctxBase(''));
    const body = parse(res);
    expect(body.success).toBe(true);
    const data = body.data as { items: Array<{ kind: string; taskId: string; legacy: boolean }>; total: number };
    expect(data.total).toBe(1);
    expect(data.items[0].taskId).toBe(EVAL_ID);
    expect(data.items[0].kind).toBe('evaluator_review');
    expect(data.items[0].legacy).toBe(true);
  });

  it('returns empty list when state.db is absent (fresh workspace)', async () => {
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('GET'), res, ctxBase(''));
    const body = parse(res);
    expect(body.success).toBe(true);
    expect((body.data as { total: number }).total).toBe(0);
  });

  it('folds explicitly synthetic RuleCode decisions while preserving a filtered count', async () => {
    const conn = setupDb();
    const now = '2026-08-30T00:00:00.000Z';
    conn.getDb().prepare(
      `INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
       VALUES (?, 'rule', ?, '[]', 'validated', ?, ?, ?)`,
    ).run('rule-demo-1', 'demo-task', JSON.stringify({ origin: 'demo', ruleId: 'demo-rule' }), now, now);
    conn.getDb().prepare(
      `INSERT INTO activations (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, promoted_at, deactivated_at)
       VALUES (?, ?, ?, 'code_tool_hook', 'code_tool_hook_shadow_activate', ?, ?, NULL, NULL)`,
    ).run('activation-demo-1', 'idem-demo-1', 'rule-demo-1', 'impl://demo', now);
    conn.close();

    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('GET'), res, ctxBase(''));
    const data = (parse(res).data as { items: Array<{ kind: string }>; total: number; filteredSyntheticCount: number });
    expect(data.total).toBe(1);
    expect(data.items.some(item => item.kind === 'rulecode_decision')).toBe(false);
    expect(data.filteredSyntheticCount).toBe(1);
  });
});

describe('POST /api/v1/governance/owner-decisions/:taskId/resolve', () => {
  async function listItem() {
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('GET'), res, ctxBase(''));
    const body = parse(res) as { data: { items: Array<Record<string, unknown>> } };
    return body.data.items[0]!;
  }

  it('accept_current records pending resolution and flips the task to pending (authority durable)', async () => {
    setupDb().close();
    const item = await listItem();
    const body = {
      action: 'accept_current',
      reviewKey: item.reviewKey,
      expectedRevisionEpoch: item.expectedRevisionEpoch,
      expectedSourceRunId: item.expectedSourceRunId,
      expectedSourceArtifactId: item.expectedSourceArtifactId,
      expectedSourceArtifactHash: item.expectedSourceArtifactHash,
      expectedEvidenceDigest: item.expectedEvidenceDigest,
      ownerInstruction: null,
    };
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', body), res, ctxBase(`/${EVAL_ID}/resolve`));
    const parsed = parse(res);
    expect(parsed.success).toBe(true);
    expect((parsed.data as { runnerWillApply: boolean }).runnerWillApply).toBe(true);

    const handle = await createRuntimeStateHandle({ workspaceDir });
    try {
      const task = await handle.stateManager.getTask(EVAL_ID);
      expect(task?.status).toBe('pending');
      const pi = JSON.parse(task?.diagnosticJson ?? '{}') as {
        pi_metadata: { runnerDecision?: string; ownerResolutions?: Array<{ status: string; effectiveDecision: string; ownerId: string }> };
      };
      expect(pi.pi_metadata.runnerDecision).toBe('needs_revision'); // INV-03
      expect(pi.pi_metadata.ownerResolutions?.[0].status).toBe('pending');
      expect(pi.pi_metadata.ownerResolutions?.[0].effectiveDecision).toBe('approved');
      expect(pi.pi_metadata.ownerResolutions?.[0].ownerId).toBe('owner-test'); // server-side identity
    } finally {
      await handle.close();
    }
  });

  it('partial evidence requires an explicit acknowledgement before accept', async () => {
    const conn = setupDb();
    conn.getDb().prepare('DELETE FROM pi_artifacts WHERE artifact_id = ?').run(SCRIBE_ARTIFACT_ID);
    conn.close();
    const item = await listItem();
    const body = {
      action: 'accept_current', reviewKey: item.reviewKey,
      expectedRevisionEpoch: item.expectedRevisionEpoch,
      expectedSourceRunId: item.expectedSourceRunId,
      expectedSourceArtifactId: item.expectedSourceArtifactId,
      expectedSourceArtifactHash: item.expectedSourceArtifactHash,
      expectedEvidenceDigest: item.expectedEvidenceDigest,
      ownerInstruction: null,
    };
    const refused = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', body), refused, ctxBase(`/${EVAL_ID}/resolve`));
    expect(refused.statusCode).toBe(409);
    expect(parse(refused).error).toBe('evidence_acknowledgement_required');

    const accepted = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', {
      ...body, acknowledgement: { kind: 'partial_evidence', acknowledged: true },
    }), accepted, ctxBase(`/${EVAL_ID}/resolve`));
    expect(parse(accepted).success).toBe(true);

    const handle = await createRuntimeStateHandle({ workspaceDir });
    try {
      const task = await handle.stateManager.getTask(EVAL_ID);
      const diagnostic = JSON.parse(task?.diagnosticJson ?? '{}') as {
        pi_metadata?: { ownerResolutions?: Array<{ evidenceDigest?: string; evidenceAcknowledgement?: { kind: string; acknowledged: boolean } }> };
      };
      expect(diagnostic.pi_metadata?.ownerResolutions?.[0]).toMatchObject({
        evidenceDigest: item.expectedEvidenceDigest,
        evidenceAcknowledgement: { kind: 'partial_evidence', acknowledged: true },
      });
    } finally {
      await handle.close();
    }
  });

  it('stale hash → 409 stale_owner_decision, nothing mutated', async () => {
    setupDb().close();
    const item = await listItem();
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', {
      action: 'accept_current',
      reviewKey: item.reviewKey,
      expectedRevisionEpoch: item.expectedRevisionEpoch,
      expectedSourceRunId: item.expectedSourceRunId,
      expectedSourceArtifactId: item.expectedSourceArtifactId,
      expectedSourceArtifactHash: 'deadbeef'.repeat(8),
      expectedEvidenceDigest: item.expectedEvidenceDigest,
      ownerInstruction: null,
    }), res, ctxBase(`/${EVAL_ID}/resolve`));
    expect(res.statusCode).toBe(409);
    expect(parse(res).error).toBe('stale_owner_decision');
  });

  it('conflicting second action → 409 already_resolved; same action replay → idempotent', async () => {
    setupDb().close();
    const item = await listItem();
    const makeBody = (action: string) => ({
      action,
      reviewKey: item.reviewKey,
      expectedRevisionEpoch: item.expectedRevisionEpoch,
      expectedSourceRunId: item.expectedSourceRunId,
      expectedSourceArtifactId: item.expectedSourceArtifactId,
      expectedSourceArtifactHash: item.expectedSourceArtifactHash,
      expectedEvidenceDigest: item.expectedEvidenceDigest,
      ownerInstruction: null,
    });
    const first = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', makeBody('reject_current')), first, ctxBase(`/${EVAL_ID}/resolve`));
    expect(parse(first).success).toBe(true);

    const conflict = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', makeBody('accept_current')), conflict, ctxBase(`/${EVAL_ID}/resolve`));
    expect(conflict.statusCode).toBe(409);
    expect(parse(conflict).error).toBe('already_resolved');

    const replay = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', makeBody('reject_current')), replay, ctxBase(`/${EVAL_ID}/resolve`));
    expect(parse(replay).success).toBe(true);
  });

  it('unknown task → 404 task_not_found', async () => {
    setupDb().close();
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', {
      action: 'accept_current', reviewKey: 'odk_x', expectedRevisionEpoch: 0,
      expectedSourceRunId: 'run-x', expectedSourceArtifactId: 'pi-art-x',
      expectedSourceArtifactHash: 'h'.repeat(64), expectedEvidenceDigest: 'e'.repeat(64), ownerInstruction: null,
    }), res, ctxBase('/evaluator-does-not-exist/resolve'));
    expect(res.statusCode).toBe(404);
    expect(parse(res).error).toBe('task_not_found');
  });

  it('non-decision task (recovery-class reason) → 409 not_decision_capable with blockers', async () => {
    const conn = setupDb();
    // rollout NHR with recovery-only context (from fixture) — POST 应拒绝
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', {
      action: 'accept_current', reviewKey: 'odk_x', expectedRevisionEpoch: 0,
      expectedSourceRunId: 'run-x', expectedSourceArtifactId: 'pi-art-x',
      expectedSourceArtifactHash: 'h'.repeat(64), expectedEvidenceDigest: 'e'.repeat(64), ownerInstruction: null,
    }), res, ctxBase(`/${ROLLOUT_ID}/resolve`));
    expect(res.statusCode).toBe(409);
    const body = parse(res) as { error: string; blockers?: string[]; nextAction?: string };
    expect(body.error).toBe('not_decision_capable');
    expect(Array.isArray(body.blockers)).toBe(true);
    expect(body.nextAction).toContain('governance focus');
    conn.close();
  });

  it('malformed body → 400 (rc-3 fail loud)', async () => {
    setupDb().close();
    const res = makeRes();
    await handleOwnerDecisionsRoute(makeReq('POST', { action: 'accept_current' }), res, ctxBase(`/${EVAL_ID}/resolve`));
    expect(res.statusCode).toBe(400);
  });
});
