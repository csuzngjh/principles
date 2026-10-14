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
