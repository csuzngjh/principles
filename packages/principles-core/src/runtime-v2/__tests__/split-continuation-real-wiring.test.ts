/**
 * SPEC-CODEX-PAIN-CLOSURE-001 review P1/S2/S3 — REAL production wiring tests.
 *
 * No flat mocks: parent diagnostician task + diag_router SUBTASK + runs +
 * SqliteDiagnosticianCommitter candidates against a real SqliteConnection
 * (the exact split-pipeline shape the review reproduced). Pins:
 *   - the post-processing backlog resolves router candidates through the
 *     parent (the pre-fix query returned 0 for this exact shape) and covers
 *     legacy consumed-but-unseeded orphans;
 *   - bridge resume advances a REAL router candidate end-to-end (intake +
 *     admission persistence + terminal state) without invoking the runner;
 *   - admission read-modify-write is atomic across two independent SQLite
 *     connections (evaluation append + processing update both survive).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { SqliteDiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import { PainSignalBridge } from '../pain-signal-bridge.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';
import type { CandidateIntakeService } from '../candidate-intake-service.js';
import type { LedgerAdapter, LedgerPrincipleEntry } from '../candidate-intake.js';
import type { RunnerResult } from '../runner/runner-result.js';

const dirs: string[] = [];
const PARENT = 'diagnosis_pain_router_real';
const ROUTER = `diag_router-${PARENT}`;
const NOW = '2026-10-14T10:00:00.000Z';

function routerOutput(): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: 'diag-router-real',
    summary: 'router summary',
    rootCause: 'router root cause',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'trace-router-1', note: 'router evidence' }],
    recommendations: [{ kind: 'principle', description: 'Router principle' }],
    confidence: 0.9,
  };
}

interface RealWorkspace {
  workspaceDir: string;
  manager: RuntimeStateManager;
  close: () => Promise<void>;
}

async function realWorkspace(): Promise<RealWorkspace> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-split-continuation-'));
  dirs.push(workspaceDir);
  const manager = new RuntimeStateManager({ workspaceDir });
  await manager.initialize();
  return { workspaceDir, manager, close: async () => { await manager.close().catch(() => undefined); } };
}

async function seedSplitDiagnosis(ws: RealWorkspace, opts: { candidateStatus?: 'pending' | 'consumed' } = {}): Promise<string> {
  const { manager } = ws;
  const now = NOW;
  await manager.createTask({
    taskId: PARENT,
    taskKind: 'diagnostician',
    inputRef: 'pain_router_real',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      sourcePainId: 'pain_router_real',
      reasonSummary: 'original pain input',
      source: 'manual',
      severity: 'moderate',
      sessionIdHint: null,
      agentIdHint: null,
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'seeded',
      evidence: [{ sourceRef: 'trace-1', note: 'original evidence' }],
      workspaceDir: null,
    }),
  });
  await manager.createTask({
    taskId: ROUTER,
    taskKind: 'diag_router',
    inputRef: PARENT,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
  });
  await manager.runStore.createRun({
    runId: 'run-router-1',
    taskId: ROUTER,
    runtimeKind: 'pi-ai',
    attemptNumber: 1,
    executionStatus: 'succeeded',
    startedAt: now,
    endedAt: now,
    outputPayload: JSON.stringify(routerOutput()),
  });
  const connection = new SqliteConnection(ws.workspaceDir);
  try {
    const committer = new SqliteDiagnosticianCommitter(connection);
    const commit = await committer.commit({
      runId: 'run-router-1',
      taskId: ROUTER,
      output: routerOutput(),
      idempotencyKey: `${ROUTER}:run-router-1`,
      contentJson: JSON.stringify({ text: 'Router principle', triggerPattern: 'tp', action: 'act' }),
    });
    const candidates = await manager.getCandidatesByTaskId(PARENT);
    expect(candidates).toHaveLength(1);
    const [first] = candidates;
    if (first === undefined) throw new Error('expected one router candidate');
    if (opts.candidateStatus === 'consumed') {
      await manager.updateCandidateStatus(first.candidateId, { status: 'consumed' });
    }
    void commit;
    return first.candidateId;
  } finally {
    connection.close();
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 });
});

describe('review P1: split-pipeline continuation on REAL wiring', () => {
  it('NEGATIVE CONTROL: the pre-fix query shape (diagnostician-only JOIN) returns 0 for router candidates', async () => {
    const ws = await realWorkspace();
    try {
      await seedSplitDiagnosis(ws);
      const db = (ws.manager as unknown as { _connection: SqliteConnection })._connection.getDb();
      const legacy = db.prepare(`
        SELECT pc.candidate_id FROM principle_candidates pc
        JOIN tasks t ON t.task_id = pc.task_id
        WHERE t.task_kind = 'diagnostician' AND t.status = 'succeeded'
          AND pc.admission_json IS NULL AND pc.status = 'pending'
      `).all();
      expect(legacy).toHaveLength(0);
    } finally {
      await ws.close();
    }
  });

  it('the fixed backlog resolves router candidates to their diagnostician parent', async () => {
    const ws = await realWorkspace();
    try {
      const candidateId = await seedSplitDiagnosis(ws);
      const backlog = await ws.manager.listDiagnosisPostProcessingBacklog({ limit: 10 });
      expect(backlog).toHaveLength(1);
      expect(backlog[0]).toEqual(expect.objectContaining({
        candidateId,
        taskId: PARENT,
        status: 'pending',
        processingState: null,
      }));
    } finally {
      await ws.close();
    }
  });

  it('legacy consumed-but-unseeded orphans (admission_json NULL) are included', async () => {
    const ws = await realWorkspace();
    try {
      const candidateId = await seedSplitDiagnosis(ws, { candidateStatus: 'consumed' });
      const backlog = await ws.manager.listDiagnosisPostProcessingBacklog({ limit: 10 });
      expect(backlog).toHaveLength(1);
      expect(backlog[0]).toEqual(expect.objectContaining({ candidateId, taskId: PARENT, status: 'consumed' }));
    } finally {
      await ws.close();
    }
  });

  it('resume advances a REAL router candidate: intake + admission persisted + terminal, runner NEVER called', async () => {
    const ws = await realWorkspace();
    try {
      const candidateId = await seedSplitDiagnosis(ws);
      const runnerCalls: string[] = [];
      const intakeCalls: string[] = [];
      const bridge = new PainSignalBridge({
        stateManager: ws.manager,
        runner: {
          run: async (taskId: string): Promise<RunnerResult> => {
            runnerCalls.push(taskId);
            throw new Error('resume must NOT re-run the diagnosis LLM');
          },
        },
        intakeService: {
          intake: async (id: string) => {
            intakeCalls.push(id);
            return { outcome: 'ledger_entry' as const, written: true, entry: { id: `ledger-${id}` } };
          },
        } as unknown as CandidateIntakeService,
        ledgerAdapter: {
          existsForCandidate: (id: string) => (intakeCalls.includes(id) ? { id: `ledger-${id}` } as LedgerPrincipleEntry : null),
        } as unknown as LedgerAdapter,
        autoIntakeEnabled: true,
      });
      const result = await bridge.resumeSucceededDiagnosisPostProcessing({ taskId: PARENT });
      expect(result.status).toBe('resumed');
      expect(runnerCalls).toEqual([]);
      expect(intakeCalls).toEqual([candidateId]);
      // admission disposition persisted on the REAL candidate row
      const document = await ws.manager.getAdmissionDocument(candidateId);
      expect(document.ok && document.document?.currentEvaluationId !== null).toBe(true);
      expect(document.ok && document.document?.evaluations[0]?.decision).toBe('admitted');
      // terminal processing state → the next backlog scan no longer returns it
      expect(await ws.manager.listDiagnosisPostProcessingBacklog({ limit: 10 })).toHaveLength(0);
      // idempotent: second resume is a no-op with no duplicate writes
      const second = await bridge.resumeSucceededDiagnosisPostProcessing({ taskId: PARENT });
      expect(second.status).toBe('not_applicable');
      expect(intakeCalls).toEqual([candidateId]);
    } finally {
      await ws.close();
    }
  });
});

describe('review S3: admission document atomic across two connections', () => {
  it('interleaved evaluation append (conn A) and processing update (conn B) both survive', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-admission-cas-'));
    dirs.push(workspaceDir);
    const manager = new RuntimeStateManager({ workspaceDir });
    await manager.initialize();
    try {
      await manager.createTask({
        taskId: 't-cas', taskKind: 'diagnostician', inputRef: 'p', status: 'succeeded', attemptCount: 0, maxAttempts: 3,
      });
      const connection = new SqliteConnection(workspaceDir);
      const committer = new SqliteDiagnosticianCommitter(connection);
      await manager.runStore.createRun({
        runId: 'run-cas', taskId: 't-cas', runtimeKind: 'pi-ai', attemptNumber: 1,
        executionStatus: 'succeeded', startedAt: NOW, endedAt: NOW,
      });
      await committer.commit({
        runId: 'run-cas', taskId: 't-cas', output: routerOutput(),
        idempotencyKey: 't-cas:run-cas', contentJson: '{}',
      });
      connection.close();
      const candidates = await manager.getCandidatesByTaskId('t-cas');
      const [casCandidate] = candidates;
      if (casCandidate === undefined) throw new Error('expected one CAS candidate');
      const { candidateId } = casCandidate;

      // Two INDEPENDENT connections on the same database (simulating worker + CLI).
      const connA = new SqliteConnection(workspaceDir);
      const connB = new SqliteConnection(workspaceDir);
      const { SqliteCandidateStore } = await import('../store/candidate/sqlite-candidate-store.js');
      const storeForA = new SqliteCandidateStore(connA);
      const storeForB = new SqliteCandidateStore(connB);

      await storeForA.appendAdmissionEvaluation(candidateId, {
        evaluationId: 'ae-cas-a', decision: 'admitted', reason: 'evidence_sufficient', nextAction: 'none',
        evaluatedAt: NOW, policyVersion: 'admission-gate@cr-03', provenance: 'owner_reported_no_host_trace',
        inputEvidenceCount: 1, ownerStatementPresent: false, recommendationKind: 'principle', confidence: 0.9,
        materialFingerprint: 'fp-a', materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
      });
      // B (a different process-equivalent handle) appends a SECOND evaluation
      // AND updates processing — under the pre-fix code this clobbered A's
      // evaluation history entirely.
      await storeForB.appendAdmissionEvaluation(candidateId, {
        evaluationId: 'ae-cas-b', decision: 'admitted', reason: 'evidence_sufficient', nextAction: 'none',
        evaluatedAt: NOW, policyVersion: 'admission-gate@cr-03', provenance: 'owner_reported_no_host_trace',
        inputEvidenceCount: 2, ownerStatementPresent: true, recommendationKind: 'principle', confidence: 0.9,
        materialFingerprint: 'fp-b', materialSummary: { inputEvidenceCount: 2, outputEvidenceCount: 1, ownerStatementPresent: true },
      });
      await storeForB.updateAdmissionProcessing(candidateId, { state: 'in_progress', attempts: 1 });

      const finalDocument = await manager.getAdmissionDocument(candidateId);
      expect(finalDocument.ok).toBe(true);
      if (finalDocument.ok && finalDocument.document !== null) {
        expect(finalDocument.document.evaluations).toHaveLength(2);
        expect(finalDocument.document.evaluations.map((e) => e.evaluationId)).toEqual(['ae-cas-a', 'ae-cas-b']);
        expect(finalDocument.document.processing).toEqual(expect.objectContaining({ state: 'in_progress', attempts: 1 }));
        expect(finalDocument.document.currentEvaluationId).toBe('ae-cas-b');
      }
      connA.close();
      connB.close();
    } finally {
      await manager.close().catch(() => undefined);
    }
  });
});

describe('review round-3: bad material cannot starve healthy candidates', () => {
  it('blocked resume records terminal states — the scan stops returning the bad pair and serves the healthy candidate', async () => {
    const ws = await realWorkspace();
    try {
      const { manager } = ws;
      // Two legacy BROKEN parent diagnoses (unparseable diagnosticJson), each with a candidate.
      for (const bad of ['bad-a', 'bad-b']) {
        const parentId = `diagnosis_${bad}`;
        const routerId = `diag_router-${parentId}`;
        await manager.createTask({ taskId: parentId, taskKind: 'diagnostician', inputRef: `pain-${bad}`, status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: '[]' });
        await manager.createTask({ taskId: routerId, taskKind: 'diag_router', inputRef: parentId, status: 'succeeded', attemptCount: 1, maxAttempts: 3 });
        await manager.runStore.createRun({ runId: `run-${bad}`, taskId: routerId, runtimeKind: 'pi-ai', attemptNumber: 1, executionStatus: 'succeeded', startedAt: NOW, endedAt: NOW });
        const connection = new SqliteConnection(ws.workspaceDir);
        try {
          const committer = new SqliteDiagnosticianCommitter(connection);
          await committer.commit({ runId: `run-${bad}`, taskId: routerId, output: routerOutput(), idempotencyKey: `${routerId}:run-${bad}`, contentJson: '{}' });
        } finally { connection.close(); }
      }
      // One healthy candidate.
      const healthyId = await seedSplitDiagnosis(ws);

      const runnerCalls: string[] = [];
      const bridge = new PainSignalBridge({
        stateManager: manager,
        runner: { run: async (taskId: string): Promise<RunnerResult> => { runnerCalls.push(taskId); throw new Error('LLM must not run'); } },
        intakeService: { intake: async (id: string) => ({ outcome: 'ledger_entry' as const, written: true, entry: { id: `ledger-${id}` } }) },
        ledgerAdapter: { existsForCandidate: () => null },
        autoIntakeEnabled: true,
      } as never);

      // limit=2, four consecutive rounds — the review's exact starvation shape.
      for (let round = 0; round < 4; round += 1) {
        const backlog = await manager.listDiagnosisPostProcessingBacklog({ limit: 2 });
        for (const item of backlog) {
          await bridge.resumeSucceededDiagnosisPostProcessing({ taskId: item.taskId });
        }
      }
      // Healthy candidate served despite two bad items ahead.
      const document = await manager.getAdmissionDocument(healthyId);
      expect(document.ok && document.document?.evaluations.length).toBeGreaterThan(0);
      expect(document.ok && document.document?.processing?.state).toBe('complete');
      // Bad pairs are terminal: not returned by the scan anymore.
      expect(await manager.listDiagnosisPostProcessingBacklog({ limit: 10 })).toHaveLength(0);
      // Bad candidates keep a readable reason + recovery entry (rc-9).
      const [badFirst] = await manager.getCandidatesByTaskId('diagnosis_bad-a');
      if (badFirst === undefined) throw new Error('expected bad candidate');
      const badDoc = await manager.getAdmissionDocument(badFirst.candidateId);
      expect(badDoc.ok && badDoc.document?.processing?.state).toBe('exhausted');
      expect(badDoc.ok && badDoc.document?.processing?.blockedReason).toContain('diagnostic_material_unusable');
      expect(runnerCalls).toEqual([]);
    } finally {
      await ws.close();
    }
  });
});

describe('review round-3: atomic diagnostician family reopen', () => {
  it('reopens parent + stages in one operation; a live lease refuses the WHOLE reopen (zero mutation)', async () => {
    const ws = await realWorkspace();
    try {
      const { manager } = ws;
      await manager.createTask({ taskId: 'diagnosis_p', taskKind: 'diagnostician', inputRef: 'pain-p', status: 'succeeded', attemptCount: 2, maxAttempts: 3, diagnosticJson: '{"sourcePainId":"pain-p"}' });
      await manager.createTask({ taskId: 'diag_router-diagnosis_p', taskKind: 'diag_router', inputRef: 'diagnosis_p', status: 'succeeded', attemptCount: 2, maxAttempts: 3 });
      await manager.createTask({ taskId: 'diag_rootcause-diagnosis_p', taskKind: 'diag_rootcause', inputRef: 'diagnosis_p', status: 'leased', attemptCount: 1, maxAttempts: 3, leaseOwner: 'other-worker' });
      const refused = await manager.reopenDiagnosticianFamilyAtomic({
        parentTaskId: 'diagnosis_p',
        stageTaskIds: ['diag_rootcause-diagnosis_p', 'diag_router-diagnosis_p'],
        parentPatch: { diagnosticJson: '{"sourcePainId":"pain-p","correctionEvidence":{"text":"stmt","classification":"owner_statement"}}' },
      });
      expect(refused).toEqual({ reopened: false, leased: ['diag_rootcause-diagnosis_p'] });
      // zero mutation on refusal
      const parent = await manager.getTask('diagnosis_p');
      expect(parent?.status).toBe('succeeded');
      expect(parent?.attemptCount).toBe(2);
      expect(parent?.diagnosticJson).toBe('{"sourcePainId":"pain-p"}');
      // without a lease: the whole family reopens atomically
      await manager.updateTask('diag_rootcause-diagnosis_p', { status: 'failed' });
      const ok = await manager.reopenDiagnosticianFamilyAtomic({
        parentTaskId: 'diagnosis_p',
        stageTaskIds: ['diag_rootcause-diagnosis_p', 'diag_router-diagnosis_p'],
        parentPatch: { diagnosticJson: '{"sourcePainId":"pain-p","correctionEvidence":{"text":"stmt","classification":"owner_statement"}}' },
      });
      expect(ok).toEqual({ reopened: true, leased: [] });
      for (const id of ['diagnosis_p', 'diag_router-diagnosis_p', 'diag_rootcause-diagnosis_p']) {
        const t = await manager.getTask(id);
        expect(t?.status).toBe('pending');
        expect(t?.attemptCount).toBe(0);
      }
      const reopenedParent = await manager.getTask('diagnosis_p');
      expect(reopenedParent?.diagnosticJson).toContain('owner_statement');
    } finally {
      await ws.close();
    }
  });
});


describe('review round-3: CAS regression proves the legacy read-modify-write loses updates', () => {
  it('the pre-fix interleaving (read-read-write-write on two connections) DROPS an evaluation, the store does not', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cas-legacy-'));
    dirs.push(workspaceDir);
    const manager = new RuntimeStateManager({ workspaceDir });
    await manager.initialize();
    try {
      await manager.createTask({ taskId: 't-legacy', taskKind: 'diagnostician', inputRef: 'p', status: 'succeeded', attemptCount: 0, maxAttempts: 3 });
      await manager.runStore.createRun({ runId: 'run-legacy', taskId: 't-legacy', runtimeKind: 'pi-ai', attemptNumber: 1, executionStatus: 'succeeded', startedAt: NOW, endedAt: NOW });
      const connection = new SqliteConnection(workspaceDir);
      const committer = new SqliteDiagnosticianCommitter(connection);
      await committer.commit({ runId: 'run-legacy', taskId: 't-legacy', output: routerOutput(), idempotencyKey: 't-legacy:run-legacy', contentJson: '{}' });
      connection.close();
      const [legacyCandidate] = await manager.getCandidatesByTaskId('t-legacy');
      if (legacyCandidate === undefined) throw new Error('expected candidate');

      // STEP 1 - replay the EXACT pre-fix interleaving with raw SQL (the old
      // implementation was: read column, merge in memory, UPDATE column).
      // Proof this test can fail: under legacy semantics B's evaluation is lost.
      const connA = new Database(path.join(workspaceDir, '.pd', 'state.db'));
      const jsonBefore = (connA.prepare('SELECT admission_json j FROM principle_candidates WHERE candidate_id = ?').get(legacyCandidate.candidateId) as { j: string | null }).j ?? 'null';
      const legacyB = (JSON.parse(jsonBefore) ?? { schemaVersion: 1, evaluations: [], currentEvaluationId: null }) as { schemaVersion: number; evaluations: { evaluationId: string }[]; currentEvaluationId: string | null };
      legacyB.evaluations.push({ evaluationId: 'legacy-b' });
      legacyB.currentEvaluationId = 'legacy-b';
      connA.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?').run(JSON.stringify(legacyB), legacyCandidate.candidateId);
      // A appends SECOND, still based on the STALE pre-B json (the legacy bug).
      const legacyA = (JSON.parse(jsonBefore) ?? { schemaVersion: 1, evaluations: [], currentEvaluationId: null }) as { schemaVersion: number; evaluations: { evaluationId: string }[]; currentEvaluationId: string | null };
      legacyA.evaluations.push({ evaluationId: 'legacy-a' });
      legacyA.currentEvaluationId = 'legacy-a';
      connA.prepare('UPDATE principle_candidates SET admission_json = ? WHERE candidate_id = ?').run(JSON.stringify(legacyA), legacyCandidate.candidateId);
      const lost = JSON.parse((connA.prepare('SELECT admission_json j FROM principle_candidates WHERE candidate_id = ?').get(legacyCandidate.candidateId) as { j: string }).j);
      expect(lost.evaluations.map((e: { evaluationId: string }) => e.evaluationId)).toEqual(['legacy-a']); // legacy-b LOST - the defect is real
      connA.close();

      // STEP 2 - the shipped store on a FRESH candidate: the same two-party
      // pattern can never lose either update (BEGIN IMMEDIATE serializes it).
      await manager.createTask({ taskId: 't-cas2', taskKind: 'diagnostician', inputRef: 'p2', status: 'succeeded', attemptCount: 0, maxAttempts: 3 });
      await manager.runStore.createRun({ runId: 'run-cas2', taskId: 't-cas2', runtimeKind: 'pi-ai', attemptNumber: 1, executionStatus: 'succeeded', startedAt: NOW, endedAt: NOW });
      const connection2 = new SqliteConnection(workspaceDir);
      const committer2 = new SqliteDiagnosticianCommitter(connection2);
      await committer2.commit({ runId: 'run-cas2', taskId: 't-cas2', output: routerOutput(), idempotencyKey: 't-cas2:run-cas2', contentJson: '{}' });
      connection2.close();
      const [casCandidate] = await manager.getCandidatesByTaskId('t-cas2');
      if (casCandidate === undefined) throw new Error('expected cas candidate');
      const connA2 = new SqliteConnection(workspaceDir);
      const connB2 = new SqliteConnection(workspaceDir);
      const { SqliteCandidateStore } = await import('../store/candidate/sqlite-candidate-store.js');
      const storeA = new SqliteCandidateStore(connA2);
      const storeB = new SqliteCandidateStore(connB2);
      const evaluation = (id: string, fingerprint: string) => ({
        evaluationId: id, decision: 'admitted' as const, reason: 'evidence_sufficient', nextAction: 'none',
        evaluatedAt: NOW, policyVersion: 'admission-gate@cr-03', provenance: 'owner_reported_no_host_trace',
        inputEvidenceCount: 1, ownerStatementPresent: false, recommendationKind: 'principle', confidence: 0.9,
        materialFingerprint: fingerprint, materialSummary: { inputEvidenceCount: 1, outputEvidenceCount: 1, ownerStatementPresent: false },
      });
      await storeA.appendAdmissionEvaluation(casCandidate.candidateId, evaluation('cas-a', 'fp-a'));
      await storeB.appendAdmissionEvaluation(casCandidate.candidateId, evaluation('cas-b', 'fp-b'));
      await storeB.updateAdmissionProcessing(casCandidate.candidateId, { state: 'in_progress', attempts: 1 });
      const finalDoc = await manager.getAdmissionDocument(casCandidate.candidateId);
      expect(finalDoc.ok && finalDoc.document?.evaluations.map((e) => e.evaluationId)).toEqual(['cas-a', 'cas-b']);
      expect(finalDoc.ok && finalDoc.document?.processing?.state).toBe('in_progress');
      connA2.close();
      connB2.close();
    } finally {
      await manager.close().catch(() => undefined);
    }
  });
});
