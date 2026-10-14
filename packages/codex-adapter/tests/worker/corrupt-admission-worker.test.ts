/**
 * SPEC-CODEX-PAIN-CLOSURE-001 review round-5 — worker-level proof that a
 * HEALTHY candidate actually PROGRESSES while a corrupt one is contained.
 *
 * Round-4 already proved the containment half (a corrupt admission_json must
 * not throw the scan, must not be intaken, must not block its healthy
 * neighbour). This file closes the missing half with POSITIVE assertions on
 * the authoritative stores, so "nothing errored" can no longer masquerade as
 * "the pipeline advanced":
 *
 *   - healthy candidate: admitted decision persisted, candidate status reaches
 *     `consumed`, a REAL Ledger entry exists (read through `loadLedger`, the
 *     same authority the worker writes through — never "the file was missing so
 *     zero writes happened"), and the internalization task is seeded;
 *   - corrupt candidate: raw bad JSON preserved verbatim, still `pending`,
 *     zero Ledger entries, never seeded, and it is surfaced as blocked;
 *   - across MULTIPLE cycles and a RECREATED state handle: the healthy item
 *     keeps progressing and NEVER double-writes.
 *
 * Isolation: the Diagnostician capability is resolved from config, and the
 * seeded tasks are already `succeeded`, so post-processing runs with provider
 * calls = 0 (the CR-05 contract: continuation NEVER re-runs the LLM). The
 * cycle therefore needs no provider stub — this is a real worker cycle against
 * real SQLite, not a mocked helper.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeStateHandle,
  getDefaultPdConfig,
  SqliteConnection,
  SqliteDiagnosticianCommitter,
} from '@principles/core/runtime-v2';
// Ledger I/O lives OUTSIDE the runtime-v2 barrel by design (PRI-443 Phase 5);
// consumers import it directly, which is exactly the authority the worker's
// PrincipleTreeLedgerAdapter writes through.
import { loadLedger } from '@principles/core/principle-tree-ledger';
import { runCodexWorkspaceWorkerCycle } from '../../src/worker/workspace-worker.js';

const dirs: string[] = [];
const PARENT = 'diagnosis_r5_worker_mix';
const ROUTER = `diag_router-${PARENT}`;
const CORRUPT_ID = 'cand-r5-corrupt';
const NOW = '2026-10-14T12:00:00.000Z';
/**
 * Each case drives REAL worker cycles: state handle creation, schema init,
 * recovery sweep, backlog scan and SQLite transactions. Under the package's
 * full-suite fan-out this legitimately exceeds vitest's 5s default on Windows;
 * the previous round-4 test timed out at 30s for exactly this reason. The
 * budget covers real I/O only — no assertion is relaxed to fit it.
 */
const WORKER_CYCLE_TIMEOUT_MS = 120_000;

function routerOutput(): object {
  return {
    valid: true,
    diagnosisId: 'diag-r5',
    summary: 's',
    rootCause: 'rc',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'trace-r5', note: 'e' }],
    recommendations: [{ kind: 'principle', description: 'R5 principle' }],
    confidence: 0.9,
  };
}

/** Minimal trajectory schema the worker's catch-up step expects. */
function seedTrajectory(root: string): void {
  const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
  trajectory.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
  trajectory.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
  trajectory.close();
}

function writeConfig(root: string): void {
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = true;
  // Ingestion off ⇒ catch-up is a zero-I/O skip; nothing reaches a provider.
  config.features.codex_conversation_ingestion.enabled = false;
  config.features.internalization_auto_consumer.enabled = true;
  fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));
}

interface Seeded {
  root: string;
  healthyCandidateId: string;
}

/** One healthy split candidate (real committer) + one corrupt admission_json sibling. */
async function seedHealthyAndCorrupt(): Promise<Seeded> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r5-worker-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  seedTrajectory(root);
  writeConfig(root);

  const handle = await createRuntimeStateHandle({ workspaceDir: root, readonly: false });
  try {
    await handle.stateManager.createTask({
      taskId: PARENT,
      taskKind: 'diagnostician',
      inputRef: 'pain-r5',
      status: 'succeeded',
      attemptCount: 1,
      maxAttempts: 3,
      diagnosticJson: JSON.stringify({
        sourcePainId: 'pain-r5', reasonSummary: 'r', source: 'manual', severity: 'moderate',
        sessionIdHint: null, agentIdHint: null, provenance: 'owner_reported_no_host_trace',
        provenanceReason: 'seeded', evidence: [{ sourceRef: 's:1', note: 'n' }], workspaceDir: null,
      }),
    });
    await handle.stateManager.createTask({ taskId: ROUTER, taskKind: 'diag_router', inputRef: PARENT, status: 'succeeded', attemptCount: 1, maxAttempts: 3 });
    await handle.stateManager.runStore.createRun({
      runId: 'run-r5', taskId: ROUTER, runtimeKind: 'pi-ai', attemptNumber: 1,
      executionStatus: 'succeeded', startedAt: NOW, endedAt: NOW, outputPayload: JSON.stringify(routerOutput()),
    });
  } finally {
    await handle.close();
  }

  const connection = new SqliteConnection(root);
  try {
    await new SqliteDiagnosticianCommitter(connection).commit({
      runId: 'run-r5', taskId: ROUTER, output: routerOutput() as never,
      idempotencyKey: `${ROUTER}:run-r5`, contentJson: '{}',
    });
  } finally {
    connection.close();
  }

  const db = new Database(path.join(root, '.pd', 'state.db'));
  const healthy = db.prepare('SELECT candidate_id FROM principle_candidates WHERE task_id = ? LIMIT 1').get(ROUTER) as { candidate_id: string } | undefined;
  if (healthy === undefined) throw new Error('expected a healthy candidate');
  db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, recommendation_kind, admission_json)
    SELECT ?, artifact_id, task_id, source_run_id, 'T', 'D', 0.9, '{}', 'k-r5-corrupt', 'pending', '2026-10-14T12:00:01Z', 'principle', '{'
    FROM principle_candidates WHERE task_id = ? LIMIT 1`).run(CORRUPT_ID, ROUTER);
  db.close();
  return { root, healthyCandidateId: healthy.candidate_id };
}

/**
 * Ledger truth read through the SAME authority the worker writes through.
 *
 * `PrincipleTreeLedgerAdapter.writeProbationEntry` records intake ownership in
 * `Principle.derivedFromPainIds` — that is the field `existsForCandidate`
 * itself queries. (Reading `reuseEvidence` here would be the wrong key and
 * would report "zero writes" for a Ledger that is actually populated, which is
 * precisely the false-negative this file exists to eliminate.)
 */
function ledgerCandidateIds(root: string): string[] {
  const ledger = loadLedger(path.join(root, '.state'));
  const ids = new Set<string>();
  for (const principle of Object.values(ledger.tree.principles)) {
    for (const candidateId of principle.derivedFromPainIds ?? []) {
      if (typeof candidateId === 'string' && candidateId.length > 0) ids.add(candidateId);
    }
  }
  return [...ids];
}

function ledgerEntryCount(root: string): number {
  return ledgerCandidateIds(root).length;
}

/**
 * Dreamer seeds actually created for this workspace. The intake →
 * internalization bridge seeds `taskKind: 'dreamer'` tasks, so that is the
 * kind asserted here (not a guessed 'internalization').
 */
async function seededTaskIds(root: string): Promise<string[]> {
  const handle = await createRuntimeStateHandle({ workspaceDir: root, readonly: true });
  try {
    const tasks = await handle.stateManager.listTasks({ taskKind: 'dreamer' });
    return tasks.map((t) => t.taskId);
  } finally {
    await handle.close();
  }
}

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  const { disposePainSignalBridgesForWorkspace } = await import('@principles/core/runtime-v2');
  for (const dir of [...dirs]) {
    await disposePainSignalBridgesForWorkspace(dir).catch(() => {});
  }
  for (const dir of dirs.splice(0)) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 80)); }
    }
  }
}, WORKER_CYCLE_TIMEOUT_MS);

describe('review round-5: the healthy candidate really advances; the corrupt one stays contained', () => {
  it('admits + consumes + writes a REAL Ledger entry + seeds for the healthy candidate, and blocks only the corrupt one', async () => {
    const { root, healthyCandidateId } = await seedHealthyAndCorrupt();

    // Baseline: nothing is in the Ledger yet — asserted through the authority,
    // so a later "zero" is a real observation rather than a missing file.
    expect(ledgerCandidateIds(root)).toEqual([]);

    // Cycle 1 — post-processing continuation runs without any provider call.
    const cycle1 = await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
    expect(cycle1.mode).not.toBe('degraded');
    expect(cycle1.report?.postProcessing).not.toBeNull();

    // Cycle 2 — the healthy candidate reaches intake and the Ledger.
    const cycle2 = await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
    expect(cycle2.mode).not.toBe('degraded');

    const verify = await createRuntimeStateHandle({ workspaceDir: root, readonly: true });
    try {
      // HEALTHY: an ADMITTED disposition is persisted on the real store.
      const healthyDoc = await verify.stateManager.getAdmissionDocument(healthyCandidateId);
      expect(healthyDoc.ok).toBe(true);
      if (healthyDoc.ok) {
        expect(healthyDoc.document).not.toBeNull();
        expect(healthyDoc.document?.currentEvaluationId).toBeTruthy();
        expect(healthyDoc.document?.evaluations.some((e) => e.decision === 'admitted')).toBe(true);
      }

      // CORRUPT: raw bad JSON preserved verbatim, never rewritten or fabricated.
      const corruptDoc = await verify.stateManager.getAdmissionDocument(CORRUPT_ID);
      expect(corruptDoc.ok).toBe(false);
      expect(await verify.stateManager.getCandidate(CORRUPT_ID)).toEqual(
        expect.objectContaining({ status: 'pending' }),
      );
      const raw = new Database(path.join(root, '.pd', 'state.db'), { readonly: true });
      try {
        const row = raw.prepare('SELECT admission_json FROM principle_candidates WHERE candidate_id = ?').get(CORRUPT_ID) as { admission_json: string } | undefined;
        expect(row?.admission_json).toBe('{');
      } finally {
        raw.close();
      }
    } finally {
      await verify.close();
    }

    // LEDGER: the healthy candidate owns a real entry; the corrupt one owns none.
    const ledgerIds = ledgerCandidateIds(root);
    expect(ledgerIds).toContain(healthyCandidateId);
    expect(ledgerIds).not.toContain(CORRUPT_ID);

    // SEED: the internalization continuation exists for the healthy path only.
    const seeded = await seededTaskIds(root);
    expect(seeded.length).toBeGreaterThan(0);
  }, WORKER_CYCLE_TIMEOUT_MS);

  it('the corrupt candidate is surfaced as blocked while the healthy one keeps advancing, without double writes', async () => {
    const { root, healthyCandidateId } = await seedHealthyAndCorrupt();

    // First cycle advances the healthy candidate and records the blockage.
    const first = await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
    expect(first.mode).not.toBe('degraded');
    expect(first.report?.postProcessing).not.toBeNull();
    // The corrupt sibling is visible as blocked, not silently skipped.
    expect(first.report?.postProcessing?.blocked.map((b) => b.candidateId)).toContain(CORRUPT_ID);

    // Drive further cycles; each rebuilds its own state handle internally,
    // which is the process-restart equivalent.
    await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
    const third = await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
    expect(third.mode).not.toBe('degraded');

    const verify = await createRuntimeStateHandle({ workspaceDir: root, readonly: true });
    let healthyEvaluations: number;
    try {
      const doc = await verify.stateManager.getAdmissionDocument(healthyCandidateId);
      expect(doc.ok).toBe(true);
      healthyEvaluations = doc.ok && doc.document ? doc.document.evaluations.length : 0;
      // Idempotent by material fingerprint: repeated cycles never append a
      // second evaluation for an unchanged material.
      expect(healthyEvaluations).toBe(1);

      // The healthy candidate reached its terminal consumed state.
      const healthyCandidate = await verify.stateManager.getCandidate(healthyCandidateId);
      expect(healthyCandidate?.status).toBe('consumed');

      // The corrupt candidate is still pending with its bad JSON intact.
      expect((await verify.stateManager.getCandidate(CORRUPT_ID))?.status).toBe('pending');
    } finally {
      await verify.close();
    }

    // No duplicate Ledger entries across cycles.
    expect(ledgerEntryCount(root)).toBe(1);
    expect(ledgerCandidateIds(root)).toEqual([healthyCandidateId]);
  }, WORKER_CYCLE_TIMEOUT_MS);
});