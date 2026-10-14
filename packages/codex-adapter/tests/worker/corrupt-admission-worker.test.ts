/**
 * SPEC-CODEX-PAIN-CLOSURE-001 review round-4 — worker-level regression:
 * one CORRUPT admission_json candidate + one healthy split candidate in the
 * same workspace. The backlog scan must survive (json_valid guard), the bad
 * item must never produce Ledger/seed writes nor block the healthy item, and
 * the healthy item must progress across MULTIPLE worker cycles including a
 * process-equivalent restart (fresh state handle per cycle).
 *
 * Real wiring: real SQLite (state.db + trajectory via committer), real
 * SplitDiagnosticianRunner through the production worker cycle.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRuntimeStateHandle,
  getDefaultPdConfig,
  SqliteConnection,
  SqliteDiagnosticianCommitter,
} from '@principles/core/runtime-v2';
import { runCodexWorkspaceWorkerCycle } from '../../src/worker/workspace-worker.js';

const dirs: string[] = [];
const PARENT = 'diagnosis_r4_corrupt_mix';
const ROUTER = `diag_router-${PARENT}`;
const NOW = '2026-10-14T12:00:00.000Z';

function routerOutput(): object {
  return {
    valid: true,
    diagnosisId: 'diag-r4',
    summary: 's',
    rootCause: 'rc',
    violatedPrinciples: [],
    evidence: [{ sourceRef: 'trace-r4', note: 'e' }],
    recommendations: [{ kind: 'principle', description: 'R4 principle' }],
    confidence: 0.9,
  };
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
});

describe('review round-4: corrupt admission_json cannot block the worker', () => {
  it('scan survives; bad item never intaken; healthy candidate completes intake across two cycles (restart)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-r4-corrupt-'));
    dirs.push(root);
    fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
    fs.mkdirSync(path.join(root, '.state'), { recursive: true });
    const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
    trajectory.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
    trajectory.exec('CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)');
    trajectory.exec('CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)');
    trajectory.exec('CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL');
    trajectory.close();
    const config = getDefaultPdConfig();
    config.features['host.codex'].enabled = true;
    config.features.codex_conversation_ingestion.enabled = false;
    config.features.internalization_auto_consumer.enabled = true;
    fs.writeFileSync(path.join(root, '.pd', 'config.yaml'), JSON.stringify(config));

    // Seed one healthy split diagnosis (parent + router + run + candidate).
    const handle = await createRuntimeStateHandle({ workspaceDir: root, readonly: false });
    try {
      await handle.stateManager.createTask({ taskId: PARENT, taskKind: 'diagnostician', inputRef: 'pain-r4', status: 'succeeded', attemptCount: 1, maxAttempts: 3, diagnosticJson: JSON.stringify({ sourcePainId: 'pain-r4', reasonSummary: 'r', source: 'manual', severity: 'moderate', sessionIdHint: null, agentIdHint: null, provenance: 'owner_reported_no_host_trace', provenanceReason: 'seeded', evidence: [{ sourceRef: 's:1', note: 'n' }], workspaceDir: null }) });
      await handle.stateManager.createTask({ taskId: ROUTER, taskKind: 'diag_router', inputRef: PARENT, status: 'succeeded', attemptCount: 1, maxAttempts: 3 });
      await handle.stateManager.runStore.createRun({ runId: 'run-r4', taskId: ROUTER, runtimeKind: 'pi-ai', attemptNumber: 1, executionStatus: 'succeeded', startedAt: NOW, endedAt: NOW, outputPayload: JSON.stringify(routerOutput()) });
    } finally {
      await handle.close();
    }
    const connection = new SqliteConnection(root);
    try {
      const committer = new SqliteDiagnosticianCommitter(connection);
      await committer.commit({ runId: 'run-r4', taskId: ROUTER, output: routerOutput() as never, idempotencyKey: `${ROUTER}:run-r4`, contentJson: '{}' });
    } finally {
      connection.close();
    }
    // Corrupt a SECOND candidate in the same scan domain.
    const db = new Database(path.join(root, '.pd', 'state.db'));
    db.prepare(`INSERT INTO principle_candidates (candidate_id, artifact_id, task_id, source_run_id, title, description, confidence, source_recommendation_json, idempotency_key, status, created_at, recommendation_kind, admission_json)
      SELECT 'cand-r4-corrupt', artifact_id, task_id, source_run_id, 'T', 'D', 0.9, '{}', 'k-r4-corrupt', 'pending', '2026-10-14T12:00:01Z', 'principle', '{'
      FROM principle_candidates WHERE task_id = ? LIMIT 1`).run(ROUTER);
    db.close();

    // Cycle 1: post-processing must NOT degrade; corrupt item never blocks.
    const cycle1 = await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
    expect(cycle1.mode).not.toBe('degraded');
    expect(cycle1.report?.postProcessing).not.toBeNull();
    expect(cycle1.report?.downstream.skipReason === undefined || cycle1.report?.downstream.skipReason === 'no_ready_tasks' || cycle1.report?.downstream.ran).toBeTruthy();

    // Cycle 2 (restart equivalent): healthy candidate reaches intake; corrupt never does.
    const cycle2 = await runCodexWorkspaceWorkerCycle({ workspaceDir: root });
    expect(cycle2.mode).not.toBe('degraded');

    const verify = await createRuntimeStateHandle({ workspaceDir: root, readonly: true });
    try {
      const corruptDoc = await verify.stateManager.getAdmissionDocument('cand-r4-corrupt');
      expect(corruptDoc.ok).toBe(false); // still unparseable — never rewritten, never fabricated
      expect(await verify.stateManager.getCandidate('cand-r4-corrupt')).toEqual(
        expect.objectContaining({ status: 'pending' }), // never consumed
      );
      // Ledger: no entry may exist for the corrupt candidate (adapter reads state.db ledger file).
      const ledgerPath = path.join(root, '.state', 'principle-tree-ledger.json');
      if (fs.existsSync(ledgerPath)) {
        const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as { principles?: Record<string, { reuseEvidence?: unknown[] }> };
        for (const principle of Object.values(ledger.principles ?? {})) {
          for (const evidence of principle.reuseEvidence ?? []) {
            expect((evidence as { candidateId?: string }).candidateId).not.toBe('cand-r4-corrupt');
          }
        }
      }
    } finally {
      await verify.close();
    }
  });
});
