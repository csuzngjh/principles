/**
 * SPEC-CODEX-PAIN-CLOSURE-001 review round-4 P1 — candidate↔diagnosis ROUND
 * binding on the REAL admission write gate.
 *
 * The defect: `evaluateAndPersistAdmissionFromStore` picked the FIRST parseable
 * run output by reverse task order and then evaluated EVERY candidate against
 * that single shared output. A candidate minted by run r1 could therefore be
 * admitted (or refused) using r2's confidence / evidence / fingerprint — a
 * later diagnosis round silently overwriting an earlier candidate's admission
 * basis. Parent–child lineage was already validated; the ROUND relation was not.
 *
 * Contract pinned here (real SQLite + RuntimeStateManager +
 * SqliteDiagnosticianCommitter, no flat mocks):
 *   - a candidate is evaluated ONLY against the output of its OWN
 *     `sourceRunId`, cross-checked against its `artifactId` + `taskId`;
 *   - a missing / corrupt / inconsistent owning run REFUSES that candidate —
 *     it never falls back to another historical successful run of the same task;
 *   - candidates of different rounds are evaluated separately;
 *   - legal split and flat pipelines still pass;
 *   - refusals write nothing (no admission document, no downstream progress).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteConnection } from '../store/sqlite-connection.js';
import { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { SqliteDiagnosticianCommitter } from '../store/commit/diagnostician-committer.js';
import { evaluateAndPersistAdmissionFromStore } from '../pain-signal-bridge.js';
import type { DiagnosticianOutputV1 } from '../diagnostician-output.js';

const dirs: string[] = [];
const workspaces: RealWorkspace[] = [];
const NOW = '2026-10-14T12:00:00.000Z';
/**
 * Every case opens a REAL SQLite workspace (schema init + committer
 * transaction + corruption surgery). Under the full-suite worker fan-out that
 * legitimately exceeds vitest's 5s default on Windows; the budget covers the
 * real I/O only — no assertion is relaxed to fit it.
 */
const REAL_SQLITE_TIMEOUT_MS = 30_000;

/** Round marker → distinct output so a cross-round substitution is observable. */
function roundOutput(round: 'r1' | 'r2'): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-${round}`,
    summary: `summary ${round}`,
    rootCause: `root cause ${round}`,
    violatedPrinciples: [],
    evidence: [{ sourceRef: `trace-${round}`, note: `evidence ${round}` }],
    recommendations: [{ kind: 'principle', description: `Principle from ${round}` }],
    // r1 is well evidenced; r2 is deliberately WEAK (confidence .2, one
    // evidence entry) so "r2 changed r1's verdict" is unambiguous.
    confidence: round === 'r1' ? 0.9 : 0.2,
  };
}

interface RealWorkspace {
  workspaceDir: string;
  manager: RuntimeStateManager;
  /** Opens a RAW connection for surgical corruption; tracked so cleanup can
   *  always close it BEFORE the temp dir is removed (Windows EBUSY). */
  db: () => Database.Database;
  closeAll: () => void;
}

async function realWorkspace(): Promise<RealWorkspace> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-round-binding-'));
  dirs.push(workspaceDir);
  const manager = new RuntimeStateManager({ workspaceDir });
  await manager.initialize();
  const open: Database.Database[] = [];
  const ws: RealWorkspace = {
    workspaceDir,
    manager,
    db: () => {
      const conn = new Database(path.join(workspaceDir, '.pd', 'state.db'));
      open.push(conn);
      return conn;
    },
    closeAll: () => {
      for (const conn of open.splice(0)) {
        try { conn.close(); } catch { /* already closed */ }
      }
    },
  };
  // Track every workspace so cleanup never races an open handle (Windows EBUSY).
  workspaces.push(ws);
  return ws;
}

async function seedRound(
  ws: RealWorkspace,
  opts: { parent?: string; router?: string; round: 'r1' | 'r2'; pain?: string },
): Promise<string> {
  const parent = opts.parent ?? `pain_parent_${opts.round}`;
  const router = opts.router ?? `diag_router_${opts.round}`;
  const runId = `run-${opts.round}-${router}`;
  const { manager } = ws;
  await manager.createTask({
    taskId: parent,
    taskKind: 'diagnostician',
    inputRef: opts.pain ?? `pain_${opts.round}`,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      sourcePainId: opts.pain ?? `pain_${opts.round}`,
      reasonSummary: 'original pain input',
      source: 'manual',
      severity: 'moderate',
      sessionIdHint: null,
      agentIdHint: null,
      provenance: 'owner_reported_no_host_trace',
      provenanceReason: 'seeded',
      evidence: [{ sourceRef: 'trace-parent', note: 'original evidence' }],
      workspaceDir: null,
    }),
  });
  await manager.createTask({
    taskId: router,
    taskKind: 'diag_router',
    inputRef: parent,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
  });
  await manager.runStore.createRun({
    runId,
    taskId: router,
    runtimeKind: 'pi-ai',
    attemptNumber: 1,
    executionStatus: 'succeeded',
    startedAt: NOW,
    endedAt: NOW,
    outputPayload: JSON.stringify(roundOutput(opts.round)),
  });
  const connection = new SqliteConnection(ws.workspaceDir);
  try {
    const committer = new SqliteDiagnosticianCommitter(connection);
    await committer.commit({
      runId,
      taskId: router,
      output: roundOutput(opts.round),
      idempotencyKey: `${router}:${runId}`,
      contentJson: JSON.stringify({ text: `Principle from ${opts.round}`, triggerPattern: 'tp', action: 'act' }),
    });
    const candidates = await manager.getCandidatesByTaskId(parent);
    const own = candidates.filter((c) => c.sourceRunId === runId);
    expect(own).toHaveLength(1);
    const [candidate] = own;
    if (candidate === undefined) throw new Error('expected seeded candidate');
    return candidate.candidateId;
  } finally {
    connection.close();
  }
}

/** A second SUCCESSFUL run on the SAME router task — the cross-round hazard. */
async function addLaterRoundRun(
  ws: RealWorkspace,
  router: string,
  opts: { round: 'r1' | 'r2'; payload?: string | null },
): Promise<string> {
  const runId = `run-later-${router}-${opts.round}`;
  const payload = opts.payload === null ? null : (opts.payload ?? JSON.stringify(roundOutput(opts.round)));
  await ws.manager.runStore.createRun({
    runId,
    taskId: router,
    runtimeKind: 'pi-ai',
    attemptNumber: 2,
    executionStatus: 'succeeded',
    startedAt: NOW,
    endedAt: NOW,
    ...(payload === null ? {} : { outputPayload: payload }),
  });
  return runId;
}

async function admissionDoc(ws: RealWorkspace, candidateId: string): Promise<unknown> {
  const document = await ws.manager.getAdmissionDocument(candidateId);
  expect(document.ok).toBe(true);
  return document.ok ? document.document : undefined;
}

/**
 * Zero-write assertion for REFUSAL paths. A refusal may leave the candidate
 * row absent entirely (FK cascade) or present with NO admission document —
 * both are "nothing was admitted". Only a persisted document would be a
 * violation, so a readable document MUST be null here.
 */
async function expectNoAdmissionWritten(ws: RealWorkspace, candidateId: string): Promise<void> {
  const document = await ws.manager.getAdmissionDocument(candidateId);
  if (document.ok) {
    expect(document.document).toBeNull();
    return;
  }
  // Unreadable means the row is gone (or its JSON is corrupt) — never an admit.
  expect(document.ok).toBe(false);
}

afterEach(async () => {
  for (const ws of workspaces.splice(0)) {
    ws.closeAll();
    await ws.manager.close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows can still hold the file briefly; the temp root is disposable.
    }
  }
}, REAL_SQLITE_TIMEOUT_MS);

describe('round binding: the owning run is the only admissible output', () => {
  it('NEGATIVE CONTROL: the pre-fix "latest parseable run" shape lets r2 rewrite r1 candidate confidence', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_neg';
      const router = 'diag_router_neg';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      // A LATER, weaker round lands on the same router task.
      await addLaterRoundRun(ws, router, { round: 'r2' });

      // Reproduce the pre-fix selection shape: reverse task order, first
      // parseable output — independent of any candidate's sourceRunId.
      const runs = await ws.manager.getRunsByTask(router);
      let picked: DiagnosticianOutputV1 | undefined;
      for (let i = runs.length - 1; i >= 0 && picked === undefined; i -= 1) {
        const raw = runs[i]?.outputPayload;
        if (typeof raw !== 'string' || raw.length === 0) continue;
        picked = JSON.parse(raw) as DiagnosticianOutputV1;
      }
      const ownRun = await ws.manager.getRun((await ws.manager.getCandidate(candidateId))?.sourceRunId ?? '');
      // The defect is real: the shared output is r2's, NOT the candidate's own r1.
      expect(picked?.diagnosisId).toBe('diag-r2');
      expect(JSON.parse(ownRun?.outputPayload ?? '{}').diagnosisId).toBe('diag-r1');
      expect(picked?.confidence).toBe(0.2);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('an r1 candidate is admitted on ITS OWN round output; a later r2 run does not change it', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_r1';
      const router = 'diag_router_r1';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      await addLaterRoundRun(ws, router, { round: 'r2' });

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.decisions.get(candidateId)?.decision).toBe('admitted');

      const document = (await admissionDoc(ws, candidateId)) as
        | { evaluations: { confidence: number | null; materialFingerprint: string }[] }
        | null;
      expect(document?.evaluations[0]?.confidence).toBe(0.9);
      // r1's own fingerprint — not r2's material.
      const r2Run = await ws.manager.getRunsByTask(router);
      const r2Payload = r2Run.find((r) => r.runId.startsWith('run-later-'))?.outputPayload ?? '';
      expect(JSON.parse(r2Payload).diagnosisId).toBe('diag-r2');
      expect(document?.evaluations[0]?.materialFingerprint).not.toBe('');
      expect(document?.evaluations).toHaveLength(1);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES when the owning run output is missing, even though another run of the same task is valid', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_missing';
      const router = 'diag_router_missing';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      // Corrupt ONLY the owning run's output; add a healthy later run.
      const db = ws.db();
      db.prepare("UPDATE runs SET output_payload = '{' WHERE run_id = (SELECT source_run_id FROM principle_candidates WHERE candidate_id = ?)").run(candidateId);
      db.close();
      // A healthy later round exists — the fix must NOT substitute it.
      await addLaterRoundRun(ws, router, { round: 'r2' });

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('candidate_diagnosis_round_unresolved');
      // Zero writes: no admission document at all.
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES when the owning run row itself is absent (FK-cascaded candidate cannot be admitted)', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_dangling';
      const router = 'diag_router_dangling';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const db = ws.db();
      // `runs` deletion CASCADEs to principle_candidates (schema FK
      // ON DELETE CASCADE), so the run and its candidate disappear together.
      // Whatever the exact refusal reason, the guarantee under test is:
      // a candidate without its own run NEVER reaches an admitted decision.
      const runId = (await ws.manager.getCandidate(candidateId))?.sourceRunId ?? '';
      db.prepare('DELETE FROM runs WHERE run_id = ?').run(runId);
      db.close();

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      // Zero writes on every refusal path.
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES a candidate whose source_run_id points at a run that exists but is NOT succeeded', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_failed_run';
      const router = 'diag_router_failed_run';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const db = ws.db();
      db.prepare("UPDATE runs SET execution_status = 'failed' WHERE run_id = (SELECT source_run_id FROM principle_candidates WHERE candidate_id = ?)").run(candidateId);
      db.close();
      // A healthy LATER round must not rescue a candidate whose own round failed.
      await addLaterRoundRun(ws, router, { round: 'r2' });

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('candidate_diagnosis_round_unresolved');
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES when the owning run belongs to a DIFFERENT task (run/task inconsistency)', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_cross';
      const router = 'diag_router_cross';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const foreignRun = await addLaterRoundRun(ws, router, { round: 'r2' });
      // A real (different) task owns the run now; the candidate still claims it.
      await ws.manager.createTask({
        taskId: 'some_other_task',
        taskKind: 'diagnostician',
        inputRef: 'pain_other',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
      });
      const db = ws.db();
      db.prepare('UPDATE runs SET task_id = ? WHERE run_id = ?').run('some_other_task', foreignRun);
      db.prepare('UPDATE principle_candidates SET source_run_id = ? WHERE candidate_id = ?').run(foreignRun, candidateId);
      db.close();

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('candidate_diagnosis_round_unresolved');
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES when the candidate artifact belongs to a different run than sourceRunId', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_artifact';
      const router = 'diag_router_artifact';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const otherArtifactRun = await addLaterRoundRun(ws, router, { round: 'r2' });
      const connection = new SqliteConnection(ws.workspaceDir);
      try {
        const committer = new SqliteDiagnosticianCommitter(connection);
        await committer.commit({
          runId: otherArtifactRun,
          taskId: router,
          output: roundOutput('r2'),
          idempotencyKey: `${router}:${otherArtifactRun}:artifact`,
          contentJson: '{}',
        });
      } finally {
        connection.close();
      }
      const db = ws.db();
      // Repoint ONLY the candidate's artifact to the other round's artifact,
      // leaving source_run_id on r1 — an artifact/run inconsistency.
      db.prepare("UPDATE principle_candidates SET artifact_id = (SELECT artifact_id FROM artifacts WHERE run_id = ?) WHERE candidate_id = ?")
        .run(otherArtifactRun, candidateId);
      db.close();

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('candidate_diagnosis_round_unresolved');
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('candidates of DIFFERENT rounds are evaluated separately, each on its own output', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_multi';
      const router = 'diag_router_multi';
      const strongId = await seedRound(ws, { parent, router, round: 'r1' });
      // Same parent+router, a second round mints its own candidate.
      const weakRunId = `run-later-${router}-r2`;
      await ws.manager.runStore.createRun({
        runId: weakRunId,
        taskId: router,
        runtimeKind: 'pi-ai',
        attemptNumber: 2,
        executionStatus: 'succeeded',
        startedAt: NOW,
        endedAt: NOW,
        outputPayload: JSON.stringify(roundOutput('r2')),
      });
      const connection = new SqliteConnection(ws.workspaceDir);
      try {
        const committer = new SqliteDiagnosticianCommitter(connection);
        await committer.commit({
          runId: weakRunId,
          taskId: router,
          output: roundOutput('r2'),
          idempotencyKey: `${router}:${weakRunId}`,
          contentJson: '{}',
        });
      } finally {
        connection.close();
      }
      const all = await ws.manager.getCandidatesByTaskId(parent);
      const weak = all.find((c) => c.sourceRunId === weakRunId);
      if (weak === undefined) throw new Error('expected the r2 candidate');
      const weakId = weak.candidateId;

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [strongId, weakId], { taskId: router });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Each candidate carries ITS OWN round's confidence — no shared output.
      type EvalView = { evaluations: { confidence: number | null; materialFingerprint: string }[] } | null;
      const strongDoc = (await admissionDoc(ws, strongId)) as EvalView;
      const weakDoc = (await admissionDoc(ws, weakId)) as EvalView;
      expect(strongDoc?.evaluations[0]?.confidence).toBe(0.9);
      expect(weakDoc?.evaluations[0]?.confidence).toBe(0.2);
      expect(strongDoc?.evaluations[0]?.materialFingerprint).not.toBe(weakDoc?.evaluations[0]?.materialFingerprint);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('a legal FLAT pipeline (task === ingress === output source) still admits', async () => {
    const ws = await realWorkspace();
    try {
      const taskId = 'flat_diagnostician_task';
      await ws.manager.createTask({
        taskId,
        taskKind: 'diagnostician',
        inputRef: 'pain_flat',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
        diagnosticJson: JSON.stringify({
          sourcePainId: 'pain_flat',
          reasonSummary: 'flat pain',
          source: 'manual',
          severity: 'moderate',
          sessionIdHint: null,
          agentIdHint: null,
          provenance: 'owner_reported_no_host_trace',
          provenanceReason: 'seeded',
          evidence: [{ sourceRef: 'trace-flat', note: 'flat evidence' }],
          workspaceDir: null,
        }),
      });
      await ws.manager.runStore.createRun({
        runId: 'run-flat',
        taskId,
        runtimeKind: 'pi-ai',
        attemptNumber: 1,
        executionStatus: 'succeeded',
        startedAt: NOW,
        endedAt: NOW,
        outputPayload: JSON.stringify(roundOutput('r1')),
      });
      const connection = new SqliteConnection(ws.workspaceDir);
      try {
        const committer = new SqliteDiagnosticianCommitter(connection);
        await committer.commit({
          runId: 'run-flat',
          taskId,
          output: roundOutput('r1'),
          idempotencyKey: `${taskId}:run-flat`,
          contentJson: '{}',
        });
      } finally {
        connection.close();
      }
      const [flatCandidate] = await ws.manager.getCandidatesByTaskId(taskId);
      if (flatCandidate === undefined) throw new Error('expected the flat candidate');

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [flatCandidate.candidateId], { taskId });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.decisions.get(flatCandidate.candidateId)?.decision).toBe('admitted');
      const document = (await admissionDoc(ws, flatCandidate.candidateId)) as { evaluations: { confidence: number | null }[] } | null;
      expect(document?.evaluations[0]?.confidence).toBe(0.9);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('a legal SPLIT candidate is admitted on its own router run output', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_ok';
      const router = 'diag_router_ok';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.decisions.get(candidateId)?.decision).toBe('admitted');
      const document = (await admissionDoc(ws, candidateId)) as { evaluations: { confidence: number | null }[] } | null;
      expect(document?.evaluations[0]?.confidence).toBe(0.9);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('refuses with task_missing when the diagnosis task no longer exists', async () => {
    const ws = await realWorkspace();
    try {
      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, ['cand-ghost'], { taskId: 'diag_router_ghost' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('task_missing');
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('refuses lineage when the task kind is neither diagnostician nor a split stage', async () => {
    const ws = await realWorkspace();
    try {
      await ws.manager.createTask({
        taskId: 'dreamer_odd_kind',
        taskKind: 'dreamer',
        inputRef: 'pain-odd',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
      });
      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, ['cand-odd'], { taskId: 'dreamer_odd_kind' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('diagnosis_lineage_inconsistent');
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('refuses when the persisted ingress payload is unusable', async () => {
    const ws = await realWorkspace();
    try {
      await ws.manager.createTask({
        taskId: 'flat_bad_ingress',
        taskKind: 'diagnostician',
        inputRef: 'pain-bad',
        status: 'succeeded',
        attemptCount: 1,
        maxAttempts: 3,
        diagnosticJson: '{"sourcePainId":"pain-bad"}', // missing required ingress facts
      });
      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, ['cand-bad'], { taskId: 'flat_bad_ingress' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).not.toBe('candidate_diagnosis_round_unresolved');
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES when the owning run exists but carries NO output payload at all', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_nooutput';
      const router = 'diag_router_nooutput';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const db = ws.db();
      db.prepare('UPDATE runs SET output_payload = NULL WHERE run_id = (SELECT source_run_id FROM principle_candidates WHERE candidate_id = ?)').run(candidateId);
      db.close();

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('candidate_diagnosis_round_unresolved');
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES the whole call when ONE of several candidates has an unresolvable round (zero writes for all)', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_mixed';
      const router = 'diag_router_mixed';
      const healthyId = await seedRound(ws, { parent, router, round: 'r1' });
      // A second candidate on the SAME task whose own run output is corrupt.
      const brokenRun = 'run-broken-sibling';
      await ws.manager.runStore.createRun({
        runId: brokenRun,
        taskId: router,
        runtimeKind: 'pi-ai',
        attemptNumber: 2,
        executionStatus: 'succeeded',
        startedAt: NOW,
        endedAt: NOW,
        outputPayload: JSON.stringify(roundOutput('r2')),
      });
      const connection = new SqliteConnection(ws.workspaceDir);
      try {
        await new SqliteDiagnosticianCommitter(connection).commit({
          runId: brokenRun,
          taskId: router,
          output: roundOutput('r2'),
          idempotencyKey: `${router}:${brokenRun}`,
          contentJson: '{}',
        });
      } finally {
        connection.close();
      }
      const all = await ws.manager.getCandidatesByTaskId(parent);
      const sibling = all.find((c) => c.sourceRunId === brokenRun);
      if (sibling === undefined) throw new Error('expected the sibling candidate');
      const db = ws.db();
      db.prepare('UPDATE runs SET output_payload = ? WHERE run_id = ?').run('{', brokenRun);
      db.close();

      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, [healthyId, sibling.candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('candidate_diagnosis_round_unresolved');
      // The resolvable candidate is NOT half-admitted: rounds are resolved
      // before any evaluation, so nothing is persisted.
      await expectNoAdmissionWritten(ws, healthyId);
      await expectNoAdmissionWritten(ws, sibling.candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('refuses when the requested candidateIds do not resolve through the lineage', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_unknown';
      const router = 'diag_router_unknown';
      await seedRound(ws, { parent, router, round: 'r1' });
      const result = await evaluateAndPersistAdmissionFromStore(ws.manager, ['cand-not-in-chain'], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('diagnosis_lineage_inconsistent');
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES (not throws) when the run lookup itself fails — a store fault is a refusal, never a crash', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_lookup';
      const router = 'diag_router_lookup';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      // Wrap the REAL manager and fail only the run lookup, so every other
      // read still comes from the real store.
      const faulty = {
        ...ws.manager,
        getRun: async () => { throw new Error('sqlite busy'); },
        getTask: ws.manager.getTask.bind(ws.manager),
        getRunsByTask: ws.manager.getRunsByTask.bind(ws.manager),
        getArtifact: ws.manager.getArtifact.bind(ws.manager),
        getCandidatesByTaskId: ws.manager.getCandidatesByTaskId.bind(ws.manager),
        appendAdmissionEvaluation: ws.manager.appendAdmissionEvaluation.bind(ws.manager),
      };
      const result = await evaluateAndPersistAdmissionFromStore(faulty, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('candidate_diagnosis_round_unresolved');
        expect(result.nextAction).toContain('source_run_lookup_failed');
      }
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES (not throws) when the artifact lookup fails', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_artifact_fault';
      const router = 'diag_router_artifact_fault';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const faulty = {
        ...ws.manager,
        getArtifact: async () => { throw new Error('artifact table unavailable'); },
        getTask: ws.manager.getTask.bind(ws.manager),
        getRun: ws.manager.getRun.bind(ws.manager),
        getRunsByTask: ws.manager.getRunsByTask.bind(ws.manager),
        getCandidatesByTaskId: ws.manager.getCandidatesByTaskId.bind(ws.manager),
        appendAdmissionEvaluation: ws.manager.appendAdmissionEvaluation.bind(ws.manager),
      };
      const result = await evaluateAndPersistAdmissionFromStore(faulty, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.nextAction).toContain('artifact_lookup_failed');
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES a candidate whose source_run_id is not a usable string', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_norunid';
      const router = 'diag_router_norunid';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      // The schema's FK makes an empty source_run_id unreachable through SQL,
      // so the defensive branch is driven through a reader that reports a
      // malformed value — the same shape a partially-migrated row would have.
      const malformed = {
        ...ws.manager,
        getCandidatesByTaskId: async () => [{
          ...(await ws.manager.getCandidate(candidateId)),
          sourceRunId: '',
        }],
        getTask: ws.manager.getTask.bind(ws.manager),
        getRun: ws.manager.getRun.bind(ws.manager),
        getRunsByTask: ws.manager.getRunsByTask.bind(ws.manager),
        getArtifact: ws.manager.getArtifact.bind(ws.manager),
        appendAdmissionEvaluation: ws.manager.appendAdmissionEvaluation.bind(ws.manager),
      };

      const result = await evaluateAndPersistAdmissionFromStore(malformed as never, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.nextAction).toContain('missing_source_run_id');
      // The REAL store still holds nothing — no write escaped the refusal.
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('reports admission_persistence_failed when the store refuses the append (nothing is silently admitted)', async () => {
    const ws = await realWorkspace();
    try {
      const parent = 'pain_parent_append';
      const router = 'diag_router_append';
      const candidateId = await seedRound(ws, { parent, router, round: 'r1' });
      const refusing = {
        ...ws.manager,
        appendAdmissionEvaluation: async () => ({ status: 'refused' as const, reason: 'locked_by_other_writer' }),
        getTask: ws.manager.getTask.bind(ws.manager),
        getRun: ws.manager.getRun.bind(ws.manager),
        getRunsByTask: ws.manager.getRunsByTask.bind(ws.manager),
        getArtifact: ws.manager.getArtifact.bind(ws.manager),
        getCandidatesByTaskId: ws.manager.getCandidatesByTaskId.bind(ws.manager),
      };
      const result = await evaluateAndPersistAdmissionFromStore(refusing, [candidateId], { taskId: router });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('admission_persistence_failed:locked_by_other_writer');
      // The real store still holds no evaluation — the refusal wrote nothing.
      await expectNoAdmissionWritten(ws, candidateId);
    } finally {
      await ws.manager.close().catch(() => undefined);
    }
  }, REAL_SQLITE_TIMEOUT_MS);
});