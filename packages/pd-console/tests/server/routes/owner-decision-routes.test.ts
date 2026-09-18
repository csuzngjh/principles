/**
 * Owner Decision Experience v1 — canonical read endpoints (SPEC §15).
 *
 * HTTP-level slices for T1/T2/T5/T8/T15/T16: real model + real SQLite +
 * real ledger on a temp workspace, exercised through the route handlers.
 * Read-only proof: ledger + DB bytes are unchanged by GETs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { computeEffectivePdConfig, createPITaskDiagnosticJson, SqliteConnection } from '@principles/core/runtime-v2';
import { computeFlagsFromLoadResult, loadPdConfig } from '../../../src/server/config/pd-config-store.js';
import { handleOwnerDecisionInboxRoute, handleOwnerDecisionViewRoute } from '../../../src/server/routes/owner-decision.js';

const AS_OF = '2026-09-18T10:00:00.000Z';
let workspaceDir: string;

function request(): IncomingMessage {
  return { method: 'GET', url: '/api/v1/principles/x/owner-decision-view' } as IncomingMessage;
}

function response(): ServerResponse & { body: string; statusCode: number } {
  return {
    body: '', statusCode: 200, headersSent: false,
    writeHead: vi.fn(function (this: { statusCode: number }, code: number) { this.statusCode = code; return this; }),
    end: vi.fn(function (this: { body: string }, body?: string) { this.body = body ?? ''; return this; }),
  } as unknown as ServerResponse & { body: string; statusCode: number };
}

function enableFlag(enabled: boolean): Record<string, { enabled: boolean }> {
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  const defaults = computeEffectivePdConfig(null);
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify({
    ...defaults.config,
    features: {
      ...defaults.config.features,
      principle_governance_projection_v2: { category: 'quiet', enabled, since: '2026-08-20' },
    },
  }));
  return computeFlagsFromLoadResult(loadPdConfig(workspaceDir)).flags;
}

const HUMAN_TEXT = '主任务未完成前不得推进次要议题：行动焦点必须锚定 Owner 明确表达的当前目标。';
const TECH_TEXT = '读取 source-of-truth.json 的 mtime 与 MD5 值，与 CURRENT_STATE.md 比对后决定是否阻止提交。';

function seedWorkspace(): void {
  // Ledger: A = unbound candidate (diagnosis readable); B = bound active with
  // approved + deactivated; C = unbound technical text; D = bound with pending.
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.state', 'principle_training_state.json'), JSON.stringify({ _tree: { principles: {
    'prin-a': { id: 'prin-a', status: 'candidate', text: HUMAN_TEXT, evaluability: 'weak_heuristic', derivedFromPainIds: ['cand-a'], ruleIds: [], createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' },
    'prin-b': { id: 'prin-b', status: 'active', text: HUMAN_TEXT, evaluability: 'weak_heuristic', derivedFromPainIds: ['cand-b'], ruleIds: ['rule-b'], createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-15T23:31:11.835Z' },
    'prin-c': { id: 'prin-c', status: 'candidate', text: TECH_TEXT, evaluability: 'weak_heuristic', derivedFromPainIds: ['cand-c'], ruleIds: [], createdAt: '2026-09-13T00:00:00.000Z', updatedAt: '2026-09-13T00:00:00.000Z' },
    'prin-d': { id: 'prin-d', status: 'probation', text: HUMAN_TEXT, evaluability: 'weak_heuristic', derivedFromPainIds: ['cand-d'], ruleIds: [], createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z' },
  }, rules: {}, implementations: {}, metrics: {}, lastUpdated: AS_OF } }));

  const connection = new SqliteConnection({ workspaceDir, readonly: false });
  const db = connection.getDb();
  const diagJson = createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'prompt', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] });

  // Diagnosis chain: task → run → generic artifacts → candidates.
  db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
    VALUES ('diag-task', 'dreamer', 'succeeded', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', 0, 3, ?)`).run(diagJson);
  db.prepare(`INSERT INTO runs (run_id, task_id, runtime_kind, execution_status, started_at, created_at, updated_at)
    VALUES ('run-diag', 'diag-task', 'test', 'succeeded', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z')`).run();
  const insertArtifact = db.prepare(`INSERT INTO artifacts
    (artifact_id, run_id, task_id, artifact_kind, content_json, created_at)
    VALUES (?, 'run-diag', 'diag-task', 'diagnostician_output', ?, ?)`);
  const diagnosis = (summary: string, rootCause: string): string =>
    JSON.stringify({ summary, rootCause, recommendations: [] });
  insertArtifact.run('art-diag-a', diagnosis('Agent 在主任务未完成时切换到次要议题。', '缺乏焦点锚定机制。'), '2026-09-13T00:00:00.000Z');
  insertArtifact.run('art-diag-b', diagnosis('重复覆盖已存在文件。', '缺少覆盖前确认。'), '2026-09-13T00:00:00.000Z');
  insertArtifact.run('art-diag-c', diagnosis('状态文件与源不一致。', '未核对来源。'), '2026-09-13T00:00:00.000Z');
  insertArtifact.run('art-diag-d', diagnosis('新痛例。', '新根因。'), '2026-09-17T00:00:00.000Z');

  // Candidates (F5: derivedFromPainIds hold candidate ids).
  const insertCandidate = db.prepare(`INSERT INTO principle_candidates
    (candidate_id, task_id, artifact_id, source_run_id, recommendation_kind, status, title, description, abstracted_principle, confidence, idempotency_key, created_at, consumed_at)
    VALUES (?, 'diag-task', ?, 'run-diag', ?, 'consumed', ?, ?, ?, ?, ?, ?, '2026-09-13T00:05:00.000Z')`);
  insertCandidate.run('cand-a', 'art-diag-a', 'principle', 'title a', HUMAN_TEXT, null, 0.55, 'idem-a', '2026-09-13T00:00:00.000Z');
  insertCandidate.run('cand-b', 'art-diag-b', 'principle', 'title b', HUMAN_TEXT, null, 0.55, 'idem-b', '2026-09-13T00:00:00.000Z');
  insertCandidate.run('cand-c', 'art-diag-c', 'implementation', 'title c', TECH_TEXT, '修改状态类文件前必须核对真实来源。', 0.8, 'idem-c', '2026-09-13T00:00:00.000Z');
  insertCandidate.run('cand-d', 'art-diag-d', 'principle', 'title d', HUMAN_TEXT, null, 0.8, 'idem-d', '2026-09-17T00:00:00.000Z');

  // Governance-bound artifacts for B and D.
  db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
    VALUES ('task-scribe-b', 'scribe', 'succeeded', ?, ?, 0, 3, ?)`).run('2026-09-15T08:00:00.000Z', '2026-09-15T08:10:00.000Z', diagJson);
  db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
    VALUES ('task-eval-b', 'evaluator', 'failed', ?, ?, 1, 3, ?)`)
    .run('2026-09-15T08:00:00.000Z', '2026-09-15T16:44:31.802Z',
      createPITaskDiagnosticJson({ dependencyTaskIds: ['task-scribe-b'], channel: 'code_tool_hook', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] }));
  db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
    VALUES ('task-scribe-d', 'scribe', 'succeeded', ?, ?, 0, 3, ?)`).run('2026-09-17T08:00:00.000Z', '2026-09-17T08:10:00.000Z', diagJson);

  const scribeContent = JSON.stringify({
    principleDraft: {
      title: '焦点锚定', statement: HUMAN_TEXT, rationale: '主任务焦点被次要议题稀释。',
      applicability: ['任务执行期间'], antiPatterns: ['无锚定切换话题'], confidence: 0.9,
    },
    risks: ['基线有缺陷时固守可能阻碍必要改进。'],
    intentContract: { targetBehavior: '切换议题前确认主任务已完成或被 Owner 明确放下。' },
  });
  db.prepare(`INSERT INTO pi_artifacts
    (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES ('pi-art-b', 'principle', 'task-scribe-b', 'prin-b', '[]', 'validated', ?, ?, ?)`)
    .run(scribeContent, '2026-09-15T08:10:00.000Z', '2026-09-15T08:10:00.000Z');
  db.prepare(`INSERT INTO pi_artifacts
    (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
    VALUES ('pi-art-d', 'principle', 'task-scribe-d', 'prin-d', '[]', 'validated', ?, ?, ?)`)
    .run(scribeContent, '2026-09-17T08:10:00.000Z', '2026-09-17T08:10:00.000Z');

  // B: approved approval + deactivated activation (CASE-B shape).
  db.prepare(`INSERT INTO approvals
    (approval_id, artifact_id, channel, status, risk_level, requested_at, decided_at, decided_by)
    VALUES ('apr-b', 'pi-art-b', 'code_tool_hook', 'approved', 'medium', '2026-09-15T23:00:00.000Z', '2026-09-15T23:31:11.835Z', 'owner')`).run();
  db.prepare(`INSERT INTO activations
    (activation_id, idempotency_key, artifact_id, channel, action, target_ref, activated_at, deactivated_at)
    VALUES ('act-b', 'idem-act-b', 'pi-art-b', 'code_tool_hook', 'code_rule_live_activate', 'rule://b', '2026-09-17T07:45:01.379Z', '2026-09-17T07:54:41.687Z')`).run();

  // D: pending approval (human-readable material available).
  db.prepare(`INSERT INTO approvals
    (approval_id, artifact_id, channel, status, risk_level, requested_at)
    VALUES ('apr-d', 'pi-art-d', 'prompt', 'pending', 'low', '2026-09-17T09:00:00.000Z')`).run();

  // C: technical-only candidate gets its abstraction from the distiller field,
  // proving implementation-heavy originals never reach the first layer while
  // the readable abstraction does.
  // (cand-c already carries abstracted_principle above.)

  // Applications: B has one deterministic effect + one presence.
  db.prepare(`INSERT INTO principle_applications
    (principle_id, activation_id, channel, level, kind, session_id, tool_name, file_path, digest, created_at)
    VALUES ('prin-b', 'act-b', 'code_tool_hook', 'effect', 'rule_blocked', 's1', 'write_file', null, 'd1', '2026-09-16T00:00:00.000Z')`).run();
  db.prepare(`INSERT INTO principle_applications
    (principle_id, activation_id, channel, level, kind, session_id, tool_name, file_path, digest, created_at)
    VALUES ('prin-b', null, 'prompt', 'presence', 'prompt_injected', 's1', null, null, 'd2', '2026-09-16T00:10:00.000Z')`).run();

  connection.close();
}

function fileHash(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

beforeEach(() => { workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-decision-')); });
afterEach(() => {
  // Windows: SQLite handles may lag release — bounded retry like the adapter tests.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
});

describe('GET /api/v1/principles/:id/owner-decision-view', () => {
  it('flag-off is a true no-read path (403, no workspace files created)', async () => {
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: { principle_governance_projection_v2: { enabled: false } }, now: () => AS_OF, subPath: '/prin-a/owner-decision-view' });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ success: false, error: 'feature_disabled' });
    expect(fs.existsSync(path.join(workspaceDir, '.state'))).toBe(false);
  });

  it('T2 — unbound candidate with readable diagnosis: blocked, diagnosis shown, no approve', async () => {
    seedWorkspace();
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-a/owner-decision-view' });
    expect(res.statusCode, res.body).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.decisionState).toBe('blocked');
    expect(data.incidentSummary.status).toBe('known');
    expect(data.currentEnforcement.status).toBe('unknown');
    expect(data.availableActions.filter((action: { semantic: string }) => action.semantic === 'approve')).toHaveLength(0);
    expect(data.nextAction.ownerText).toContain('暂时无法');
  });

  it('T5 — pending subject with readable material: needs_owner_decision + approve + reject', async () => {
    seedWorkspace();
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-d/owner-decision-view' });
    expect(res.statusCode, res.body).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.decisionState).toBe('needs_owner_decision');
    const semantics = data.availableActions.map((action: { semantic: string }) => action.semantic);
    expect(semantics).toContain('approve');
    expect(semantics).toContain('reject');
    // Scribe tier wins for the learned principle.
    expect(data.learnedPrinciple.status).toBe('known');
    expect(data.learnedPrinciple.value.sourceTier).toBe('scribe');
  });

  it('T5b — technical-only original never surfaces; its distiller abstraction does', async () => {
    seedWorkspace();
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-c/owner-decision-view' });
    expect(res.statusCode, res.body).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.learnedPrinciple.status).toBe('known');
    expect(data.learnedPrinciple.value.sourceTier).toBe('distiller');
    expect(data.learnedPrinciple.value.text).toContain('核对真实来源');
    expect(JSON.stringify(data.learnedPrinciple)).not.toContain('MD5');
  });

  it('T3 — decided+deactivated composite keeps history without do-not-approve', async () => {
    seedWorkspace();
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-b/owner-decision-view' });
    expect(res.statusCode, res.body).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.decisionState).toBe('recovery_needed'); // old failed evaluator task is still in the frontier
    expect(data.decisionSubjects.some((subject: { state: string }) => subject.state === 'approved')).toBe(true);
    expect(data.currentEnforcement.value.state).toBe('deactivated');
    expect(data.evidenceSummary.value.observation.deterministicEffects.value).toBe(1);
    const runtime = data.blockers.find((blocker: { kind: string }) => blocker.kind === 'runtime');
    expect(runtime.reason.ownerText).toContain('尚未确认');
    expect(JSON.stringify(data)).not.toContain('不要批准');
    // disable is NOT offered for a deactivated activation.
    expect(data.availableActions.filter((action: { semantic: string }) => action.semantic === 'disable')).toHaveLength(0);
  });

  it('T15 — missing principle: 404 with a fixed message (no id echo)', async () => {
    seedWorkspace();
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/no-such-principle/owner-decision-view' });
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('principle_not_found');
    expect(res.body).not.toContain('no-such-principle');
  });

  it('read-only proof: GETs leave ledger and state.db byte-identical', async () => {
    seedWorkspace();
    const ledgerPath = path.join(workspaceDir, '.state', 'principle_training_state.json');
    const dbPath = path.join(workspaceDir, '.pd', 'state.db');
    const beforeLedger = fileHash(ledgerPath);
    const beforeDb = fileHash(dbPath);
    for (const sub of ['/prin-a/owner-decision-view', '/prin-b/owner-decision-view', '/prin-d/owner-decision-view']) {
      const res = response();
      await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: sub });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(fileHash(ledgerPath)).toBe(beforeLedger);
    expect(fileHash(dbPath)).toBe(beforeDb);
  });
});

describe('GET /api/v1/principles/owner-decision-inbox', () => {  it('T16 — real current subjects listed; unbound history is one aggregate notice, not cards', async () => {
    seedWorkspace();
    const res = response();
    await handleOwnerDecisionInboxRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF });
    expect(res.statusCode, res.body).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.totalPrinciples).toBe(4);
    // prin-d (pending, readable) is an individual decision item.
    expect(data.groups.decision.map((item: { principleId: string }) => item.principleId)).toEqual(['prin-d']);
    // prin-b (recovery frontier) is an individual recovery item.
    expect(data.groups.recovery.map((item: { principleId: string }) => item.principleId)).toEqual(['prin-b']);
    // prin-a and prin-c are aggregate blocked (no current subject) — the
    // aggregate count is exactly the historical-unknown notice, and they do
    // NOT become individual to-do cards.
    const blockedIndividual = data.groups.blocked.filter((item: { inbox: { attention: string } }) => item.inbox.attention === 'individual');
    expect(blockedIndividual).toHaveLength(0);
    expect(data.historicalUnknown.count).toBe(2);
    expect(data.historicalUnknown.reasonText).toContain('暂时无法确认');
    // Compact projection: no heavy Core payloads (timeline/tasks) in items.
    for (const group of ['decision', 'blocked', 'recovery'] as const) {
      for (const item of data.groups[group]) {
        expect(Object.keys(item)).not.toContain('currentEnforcement');
        expect(Object.keys(item)).not.toContain('decisionSubjects');
      }
    }
  });

  it('flag-off: 403 without reading the workspace', async () => {
    const res = response();
    await handleOwnerDecisionInboxRoute({ req: request(), res, workspaceDir, featureFlags: { principle_governance_projection_v2: { enabled: false } }, now: () => AS_OF });
    expect(res.statusCode).toBe(403);
    expect(fs.existsSync(path.join(workspaceDir, '.pd'))).toBe(false);
  });

  it('empty workspace (no ledger) degrades observably instead of an empty success', async () => {
    const res = response();
    await handleOwnerDecisionInboxRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF });
    expect(res.statusCode, res.body).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.totalPrinciples).toBe(0);
    expect(data.degraded).toBeDefined();
    expect(data.degraded.reason).toContain('unavailable');
  });
});

describe('T8 — mutation service is the final authority over a stale GET', () => {
  it('a GET-advertised approve is refused by the service once the subject is already decided', async () => {
    seedWorkspace();
    // GET: prin-d has a pending approval with readable material → approve advertised.
    const getView = response();
    await handleOwnerDecisionViewRoute({ req: request(), res: getView, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-d/owner-decision-view' });
    expect(getView.statusCode).toBe(200);
    const before = JSON.parse(getView.body).data;
    const approveAdvertised = before.availableActions.some((action: { semantic: string }) => action.semantic === 'approve');
    expect(approveAdvertised).toBe(true);

    // The environment changes behind the view's back: another actor decides
    // the approval first (the real writer, not the view).
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    conn.getDb().prepare(`UPDATE approvals SET status = 'approved', decided_at = ?, decided_by = 'someone-else' WHERE approval_id = 'apr-d'`)
      .run('2026-09-18T09:30:00.000Z');
    conn.close();

    // The stale GET said approve; the MUTATION authority must refuse.
    const { ApprovalsConsoleModel } = await import('../../../src/server/models/ApprovalsConsoleModel.js');
    const model = new ApprovalsConsoleModel(workspaceDir);
    const result = await model.approve('apr-d', 'test-owner');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_decided');
    }

    // A fresh GET reflects the decided state and no longer advertises approve.
    const afterView = response();
    await handleOwnerDecisionViewRoute({ req: request(), res: afterView, workspaceDir, featureFlags: enableFlag(true), now: () => new Date().toISOString(), subPath: '/prin-d/owner-decision-view' });
    const after = JSON.parse(afterView.body).data;
    expect(after.decisionState).toBe('decided');
    expect(after.availableActions.filter((action: { semantic: string }) => action.semantic === 'approve')).toHaveLength(0);
  });
});

describe('T12 — multi-channel / multi-revision subject folding', () => {
  it('approvals fold per artifact+channel: latest record wins, channels stay separate subjects', async () => {
    seedWorkspace();
    // Add a SECOND channel approval for prin-d (code_tool_hook, own revision
    // artifact on its own scribe task — one principle artifact per task) plus
    // an older superseded record on the same artifact+channel as apr-d.
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    const diagJson = createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'code_tool_hook', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] });
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES ('task-scribe-d2', 'scribe', 'succeeded', '2026-09-17T08:00:00.000Z', '2026-09-17T08:10:00.000Z', 0, 3, ?)`).run(diagJson);
    db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, status, risk_level, requested_at)
      VALUES ('apr-d-old', 'pi-art-d', 'prompt', 'cancelled', 'low', '2026-09-16T09:00:00.000Z')`).run();
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('pi-art-d2', 'principle', 'task-scribe-d2', 'prin-d', '[]', 'validated', '{}', '2026-09-17T08:10:00.000Z', '2026-09-17T08:10:00.000Z')`).run();
    db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, status, risk_level, requested_at)
      VALUES ('apr-d-hook', 'pi-art-d2', 'code_tool_hook', 'pending', 'medium', '2026-09-17T10:00:00.000Z')`).run();
    conn.close();

    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-d/owner-decision-view' });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    // Two distinct subjects: (pi-art-d, prompt) and (pi-art-d2, code_tool_hook).
    expect(data.decisionSubjects).toHaveLength(2);
    const promptSubject = data.decisionSubjects.find((subject: { channel: string }) => subject.channel === 'prompt');
    // The cancelled OLD record does not override the latest pending one.
    expect(promptSubject?.state).toBe('pending');
    // Codex P1 per-subject gating: only the subject whose OWN artifact carries
    // the scribe material (pi-art-d) is approvable. pi-art-d2 (empty lineage,
    // no statement of its own) must NOT be approvable via pi-art-d's text —
    // but keeps an independently safe reject.
    const approveKeys = data.availableActions.filter((action: { semantic: string }) => action.semantic === 'approve').map((action: { key: string }) => action.key);
    expect(approveKeys).toContain('approve:apr-d');
    expect(approveKeys).not.toContain('approve:apr-d-hook');
    expect(data.availableActions.some((action: { key: string }) => action.key === 'reject:apr-d-hook')).toBe(true);
  });

  it('Codex P2 — missing principle_applications table surfaces as an UNAVAILABLE source, not available-zero', async () => {
    seedWorkspace();
    // Drop the applications table behind the model's back (damaged workspace).
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    conn.getDb().prepare('DROP TABLE principle_applications').run();
    conn.close();
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-b/owner-decision-view' });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    const appsRead = data.sourceReads.find((read: { source: string }) => read.source === 'principle_applications');
    expect(appsRead?.status).toBe('unavailable');
    // Counts are unknown, never a confident zero.
    expect(data.evidenceSummary.value.observation.deterministicEffects.status).toBe('unknown');
    expect(data.sourceReadStatus).toBe('partial');
  });
});

describe('T13/T14 — reject independence and historical observation semantics', () => {
  it('T13: technical-only subject keeps reject while approve stays gated (source failure does not cascade)', async () => {
    // prin-c is implementation-kind; strip its distiller abstraction and give
    // it a pending approval so a subject exists with NO readable material.
    seedWorkspace();
    const diagJson = createPITaskDiagnosticJson({ dependencyTaskIds: [], channel: 'prompt', timeoutMs: 30_000, inputArtifactRefs: [], outputArtifactRefs: [] });
    const conn = new SqliteConnection({ workspaceDir, readonly: false });
    const db = conn.getDb();
    db.prepare(`UPDATE principle_candidates SET abstracted_principle = NULL WHERE candidate_id = 'cand-c'`).run();
    db.prepare(`INSERT INTO tasks (task_id, task_kind, status, created_at, updated_at, attempt_count, max_attempts, diagnostic_json)
      VALUES ('task-scribe-c', 'scribe', 'succeeded', '2026-09-17T08:00:00.000Z', '2026-09-17T08:10:00.000Z', 0, 3, ?)`).run(diagJson);
    db.prepare(`INSERT INTO pi_artifacts (artifact_id, artifact_kind, source_task_id, source_principle_id, lineage_artifact_ids, validation_status, content_json, created_at, updated_at)
      VALUES ('pi-art-c', 'principle', 'task-scribe-c', 'prin-c', '[]', 'validated', '{}', '2026-09-17T08:10:00.000Z', '2026-09-17T08:10:00.000Z')`).run();
    db.prepare(`INSERT INTO approvals (approval_id, artifact_id, channel, status, risk_level, requested_at)
      VALUES ('apr-c', 'pi-art-c', 'prompt', 'pending', 'low', '2026-09-17T09:00:00.000Z')`).run();
    conn.close();

    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-c/owner-decision-view' });
    const data = JSON.parse(res.body).data;
    expect(data.decisionState).toBe('blocked');
    expect(data.availableActions.filter((action: { semantic: string }) => action.semantic === 'approve')).toHaveLength(0);
    expect(data.availableActions.filter((action: { semantic: string }) => action.semantic === 'reject')).toHaveLength(1);
  });

  it('T14: deactivated activation keeps historical effect AND presence records distinct', async () => {
    seedWorkspace();
    const res = response();
    await handleOwnerDecisionViewRoute({ req: request(), res, workspaceDir, featureFlags: enableFlag(true), now: () => AS_OF, subPath: '/prin-b/owner-decision-view' });
    const data = JSON.parse(res.body).data;
    expect(data.currentEnforcement.value.state).toBe('deactivated');
    const observation = data.evidenceSummary.value.observation;
    expect(observation.deterministicEffects.value).toBe(1);
    expect(observation.contextPresence.value).toBe(1);
    // Historical records never claim current causation.
    expect(data.evidenceSummary.value.ownerExplanation).toContain('不是完整历史');
  });
});
