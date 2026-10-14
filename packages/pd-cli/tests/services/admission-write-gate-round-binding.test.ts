/**
 * SPEC-CODEX-PAIN-CLOSURE-001 review round-4 P1 — the REAL pd-cli write gate
 * honours candidate↔diagnosis-round binding.
 *
 * The core fix is proven in principles-core. This file closes the loop at an
 * ACTUAL write entry: `enforceFullAdmissionForWrite` is the single gate behind
 * all six CLI mutation paths (candidate intake / repair / backfill /
 * review --decide create, `pd pain retry`, `pd diagnose --intake`). It runs
 * against a real SqliteConnection + RuntimeStateManager + the real
 * SqliteDiagnosticianCommitter, so the verdict below is the verdict the CLI
 * would give — not a mocked helper call.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { RuntimeStateManager, SqliteDiagnosticianCommitter } from '@principles/core/runtime-v2';
import { SqliteConnection } from '@principles/core/runtime-v2';
import type { DiagnosticianOutputV1 } from '@principles/core/runtime-v2';
import { enforceFullAdmissionForWrite } from '../../src/services/admission-write-gate.js';

const dirs: string[] = [];
const managers: RuntimeStateManager[] = [];
const rawConnections: Database.Database[] = [];
const NOW = '2026-10-14T13:00:00.000Z';
/** Real SQLite schema init under the suite's worker fan-out (Windows). */
const REAL_SQLITE_TIMEOUT_MS = 30_000;

function roundOutput(round: 'r1' | 'r2'): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-${round}`,
    summary: `summary ${round}`,
    rootCause: `root cause ${round}`,
    violatedPrinciples: [],
    evidence: [{ sourceRef: `trace-${round}`, note: `evidence ${round}` }],
    recommendations: [{ kind: 'principle', description: `Principle from ${round}` }],
    confidence: round === 'r1' ? 0.9 : 0.2,
  };
}

async function realManager(): Promise<{ manager: RuntimeStateManager; workspaceDir: string }> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cli-round-gate-'));
  dirs.push(workspaceDir);
  const manager = new RuntimeStateManager({ workspaceDir });
  await manager.initialize();
  managers.push(manager);
  return { manager, workspaceDir };
}

function rawDb(workspaceDir: string): Database.Database {
  const conn = new Database(path.join(workspaceDir, '.pd', 'state.db'));
  rawConnections.push(conn);
  return conn;
}

/** Parent diagnostician + router subtask + one committed round (real committer). */
async function seedSplitRound(
  manager: RuntimeStateManager,
  workspaceDir: string,
  opts: { parent: string; router: string; round: 'r1' | 'r2' },
): Promise<string> {
  const { parent, router, round } = opts;
  const runId = `run-${round}-${router}`;
  await manager.createTask({
    taskId: parent,
    taskKind: 'diagnostician',
    inputRef: `pain-${parent}`,
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    diagnosticJson: JSON.stringify({
      sourcePainId: `pain-${parent}`,
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
    outputPayload: JSON.stringify(roundOutput(round)),
  });
  const connection = new SqliteConnection(workspaceDir);
  try {
    await new SqliteDiagnosticianCommitter(connection).commit({
      runId,
      taskId: router,
      output: roundOutput(round),
      idempotencyKey: `${router}:${runId}`,
      contentJson: '{}',
    });
  } finally {
    connection.close();
  }
  const own = (await manager.getCandidatesByTaskId(parent)).filter((c) => c.sourceRunId === runId);
  expect(own).toHaveLength(1);
  const candidate = own[0];
  if (candidate === undefined) throw new Error('expected a seeded candidate');
  return candidate.candidateId;
}

afterEach(async () => {
  for (const conn of rawConnections.splice(0)) {
    try { conn.close(); } catch { /* already closed */ }
  }
  for (const manager of managers.splice(0)) {
    await manager.close().catch(() => undefined);
  }
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows may still hold the file briefly; the temp root is disposable.
    }
  }
}, REAL_SQLITE_TIMEOUT_MS);

describe('the real pd-cli write gate honours the candidate own diagnosis round', () => {
  it('permits a legal split candidate write (null refusal) and persists its own round confidence', async () => {
    const { manager, workspaceDir } = await realManager();
    const candidateId = await seedSplitRound(manager, workspaceDir, { parent: 'gate_p_ok', router: 'gate_r_ok', round: 'r1' });

    // null === the write is permitted; this is the CLI's real decision.
    const refusal = await enforceFullAdmissionForWrite(manager, candidateId);
    expect(refusal).toBeNull();

    const document = await manager.getAdmissionDocument(candidateId);
    expect(document.ok).toBe(true);
    if (document.ok) {
      expect(document.document?.currentEvaluationId).toBeTruthy();
      expect(document.document?.evaluations[0]?.confidence).toBe(0.9);
    }
  }, REAL_SQLITE_TIMEOUT_MS);

  it('a LATER weaker round does not retroactively block an r1 candidate write', async () => {
    const { manager, workspaceDir } = await realManager();
    const parent = 'gate_p_later';
    const router = 'gate_r_later';
    const candidateId = await seedSplitRound(manager, workspaceDir, { parent, router, round: 'r1' });
    // r2 lands on the same router task with confidence .2.
    await manager.runStore.createRun({
      runId: 'run-r2-later',
      taskId: router,
      runtimeKind: 'pi-ai',
      attemptNumber: 2,
      executionStatus: 'succeeded',
      startedAt: NOW,
      endedAt: NOW,
      outputPayload: JSON.stringify(roundOutput('r2')),
    });

    const refusal = await enforceFullAdmissionForWrite(manager, candidateId);
    // Pre-fix, r2's weaker output decided this candidate's verdict.
    expect(refusal).toBeNull();
    const document = await manager.getAdmissionDocument(candidateId);
    expect(document.ok && document.document?.evaluations[0]?.confidence).toBe(0.9);
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES the write when the candidate own round output is corrupt, even with a healthy later run', async () => {
    const { manager, workspaceDir } = await realManager();
    const parent = 'gate_p_corrupt';
    const router = 'gate_r_corrupt';
    const candidateId = await seedSplitRound(manager, workspaceDir, { parent, router, round: 'r1' });
    const db = rawDb(workspaceDir);
    db.prepare("UPDATE runs SET output_payload = '{' WHERE run_id = (SELECT source_run_id FROM principle_candidates WHERE candidate_id = ?)").run(candidateId);
    db.close();
    await manager.runStore.createRun({
      runId: 'run-r2-healthy',
      taskId: router,
      runtimeKind: 'pi-ai',
      attemptNumber: 2,
      executionStatus: 'succeeded',
      startedAt: NOW,
      endedAt: NOW,
      outputPayload: JSON.stringify(roundOutput('r2')),
    });

    const refusal = await enforceFullAdmissionForWrite(manager, candidateId);
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toContain('candidate_diagnosis_round_unresolved');
    // No admission document was written by the refused gate.
    const document = await manager.getAdmissionDocument(candidateId);
    expect(document.ok && document.document).toBeNull();
  }, REAL_SQLITE_TIMEOUT_MS);

  it('REFUSES the write when the candidate artifact points at a different run', async () => {
    const { manager, workspaceDir } = await realManager();
    const parent = 'gate_p_artifact';
    const router = 'gate_r_artifact';
    const candidateId = await seedSplitRound(manager, workspaceDir, { parent, router, round: 'r1' });
    const otherRun = 'run-r2-artifact';
    await manager.runStore.createRun({
      runId: otherRun,
      taskId: router,
      runtimeKind: 'pi-ai',
      attemptNumber: 2,
      executionStatus: 'succeeded',
      startedAt: NOW,
      endedAt: NOW,
      outputPayload: JSON.stringify(roundOutput('r2')),
    });
    const connection = new SqliteConnection(workspaceDir);
    try {
      await new SqliteDiagnosticianCommitter(connection).commit({
        runId: otherRun,
        taskId: router,
        output: roundOutput('r2'),
        idempotencyKey: `${router}:${otherRun}:artifact`,
        contentJson: '{}',
      });
    } finally {
      connection.close();
    }
    const db = rawDb(workspaceDir);
    db.prepare('UPDATE principle_candidates SET artifact_id = (SELECT artifact_id FROM artifacts WHERE run_id = ?) WHERE candidate_id = ?')
      .run(otherRun, candidateId);
    db.close();

    const refusal = await enforceFullAdmissionForWrite(manager, candidateId);
    expect(refusal).not.toBeNull();
    expect(refusal?.reason).toContain('candidate_diagnosis_round_unresolved');
  }, REAL_SQLITE_TIMEOUT_MS);

  it('re-validating twice is idempotent: the same round appends no extra evaluation', async () => {
    const { manager, workspaceDir } = await realManager();
    const candidateId = await seedSplitRound(manager, workspaceDir, { parent: 'gate_p_idem', router: 'gate_r_idem', round: 'r1' });

    expect(await enforceFullAdmissionForWrite(manager, candidateId)).toBeNull();
    const first = await manager.getAdmissionDocument(candidateId);
    expect(await enforceFullAdmissionForWrite(manager, candidateId)).toBeNull();
    const second = await manager.getAdmissionDocument(candidateId);
    expect(first.ok && first.document?.evaluations).toHaveLength(1);
    expect(second.ok && second.document?.evaluations).toHaveLength(1);
    expect(first.ok && first.document?.currentEvaluationId).toBe(second.ok ? second.document?.currentEvaluationId : undefined);
  }, REAL_SQLITE_TIMEOUT_MS);
});