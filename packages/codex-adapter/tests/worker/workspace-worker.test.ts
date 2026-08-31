import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import {
  getDefaultPdConfig,
  SplitDiagnosticianRunner,
  DreamerRunner,
  RuntimeStateManager,
  SqliteConnection,
  SqliteDiagnosticianCommitter,
  type RunnerResult,
  type DiagnosticianOutputV1,
} from '@principles/core/runtime-v2';
import { runCodexWorkspaceWorkerCycle } from '../../src/worker/workspace-worker.js';
import { setCodexTranscriptPortForTest } from '../../src/ingestion/ingestion.js';
import type { CodexCatchUpResult } from '../../src/ingestion/catch-up.js';

/**
 * PRI-624 Slice C worker-cycle matrix: the production hook (built dist,
 * fresh subprocess) admits a real correction into a pending Diagnostician
 * task; the worker cycle then drives it with only the LLM boundary spied
 * (the SplitDiagnosticianRunner spy acquires the REAL durable lease, commits
 * through the REAL committer, and marks the task succeeded — everything
 * else is the production path).
 */

const FIXTURES = new URL('../fixtures/g1-contract/', import.meta.url);
const ROOT_SESSION = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const TURN_1 = '01a048ae-b344-7eb2-804b-a2fa34302fb3';
const ROLLOUT_UUID = '01a048ae-b2a5-71a1-9faf-0226980f98ff';
const CORRECTION = '不要自作主张,这是错的,我说过修改前先调查已有实现';

const BASELINE_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

const dirs: string[] = [];

interface WorkerWorkspace {
  root: string;
  codexHome: string;
  transcriptPath: string;
}

function writeConfig(ws: WorkerWorkspace, overrides: { ingestion?: boolean; consumer?: boolean; hostCodex?: boolean }): void {
  const config = getDefaultPdConfig();
  config.features['host.codex'].enabled = overrides.hostCodex ?? true;
  config.features.codex_conversation_ingestion.enabled = overrides.ingestion ?? true;
  config.features.internalization_auto_consumer.enabled = overrides.consumer ?? true;
  fs.writeFileSync(path.join(ws.root, '.pd', 'config.yaml'), JSON.stringify(config));
}

function makeWorkspace(overrides: { ingestion?: boolean; consumer?: boolean; hostCodex?: boolean } = {}): WorkerWorkspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-worker-'));
  dirs.push(root);
  fs.mkdirSync(path.join(root, '.pd'), { recursive: true });
  fs.mkdirSync(path.join(root, '.state'), { recursive: true });
  const trajectory = new Database(path.join(root, '.state', 'trajectory.db'));
  for (const statement of BASELINE_DDL) trajectory.prepare(statement).run();
  trajectory.close();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-codex-worker-home-'));
  dirs.push(codexHome);
  const sessions = path.join(codexHome, 'sessions', '2026', '08', '28');
  fs.mkdirSync(sessions, { recursive: true });
  const transcriptPath = path.join(sessions, `rollout-2026-08-28T22-03-23-${ROLLOUT_UUID}.jsonl`);
  fs.copyFileSync(new URL('transcripts/normal-tool-final-turn.jsonl', FIXTURES), transcriptPath);
  const ws: WorkerWorkspace = { root, codexHome, transcriptPath };
  writeConfig(ws, overrides);
  return ws;
}

async function runHook(ws: WorkerWorkspace, payload: Record<string, unknown>): Promise<{ status: number; stdout: string; stderr: string }> {
  const { execFile } = await import('node:child_process');
  const execFileAsync = promisify(execFile);
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const entry = path.resolve(packageRoot, 'dist', 'pd-hook.js');
  if (!fs.statSync(entry).isFile()) throw new Error(`hook entry not built: ${entry} (run npm run build in packages/codex-adapter)`);
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = ws.codexHome;
  try {
    const running = execFileAsync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    running.child.stdin?.end(JSON.stringify(payload));
    const { stdout, stderr } = await running;
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { status: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? failure.message ?? '' };
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

function correctionPayload(ws: WorkerWorkspace, turnId = TURN_1): Record<string, unknown> {
  return {
    session_id: ROOT_SESSION,
    turn_id: turnId,
    transcript_path: ws.transcriptPath,
    cwd: ws.root,
    hook_event_name: 'UserPromptSubmit',
    model: 'gpt-5.6-sol',
    permission_mode: 'bypassPermissions',
    prompt: CORRECTION,
  };
}

function trajectoryOf(root: string): Database.Database {
  return new Database(path.join(root, '.state', 'trajectory.db'));
}

function stateDbOf(root: string): Database.Database {
  return new Database(path.join(root, '.pd', 'state.db'), { readonly: true });
}

interface TaskRow { task_id: string; task_kind: string; status: string; attempt_count: number; max_attempts: number; input_ref: string | null; lease_owner: string | null; lease_expires_at: string | null }

function diagnosticianTask(root: string): TaskRow | undefined {
  const db = stateDbOf(root);
  try {
    return db.prepare("SELECT task_id, task_kind, status, attempt_count, max_attempts, input_ref, lease_owner, lease_expires_at FROM tasks WHERE task_kind = 'diagnostician'").get() as TaskRow | undefined;
  } finally {
    db.close();
  }
}

function candidateCount(root: string): number {
  const db = stateDbOf(root);
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM principle_candidates').get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

function runCount(root: string, taskId: string): number {
  const db = stateDbOf(root);
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE task_id = ?').get(taskId) as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

/** A schema-valid DiagnosticianOutputV1 the fake diagnosis produces. */
function fakeDiagnosis(taskId: string): DiagnosticianOutputV1 {
  return {
    valid: true,
    diagnosisId: `diag-${taskId}`,
    summary: '重复未调查既有实现即修改',
    rootCause: 'People: 修改前未调查既有实现',
    violatedPrinciples: [],
    evidence: [
      { sourceRef: 'codex:correction', note: 'owner correction text' },
      { sourceRef: 'codex:transcript', note: 'correction turn observed' },
    ],
    recommendations: [
      { kind: 'principle', description: '修改前先调查已有实现', abstractedPrinciple: '修改前先调查已有实现' },
    ],
    confidence: 0.9,
  };
}

/**
 * Fake the LLM boundary with REAL semantics: acquire the durable lease
 * through the production lease manager, commit the diagnosis through the
 * production committer (idempotent key), mark the task succeeded.
 * lease_conflict → structured failed result, exactly like the real
 * SplitDiagnosticianRunner.
 */
function spySplitPipelineSuccess(ws: WorkerWorkspace): { calls: string[] } {
  const calls: string[] = [];
  vi.spyOn(SplitDiagnosticianRunner.prototype, 'run').mockImplementation(async function (this: unknown, taskId: string) {
    calls.push(taskId);
    const self = this as unknown as { stateManager: RuntimeStateManager };
    try {
      const leased = await self.stateManager.acquireLease({ taskId, owner: 'split-diagnostician-orchestrator', runtimeKind: 'pi-ai' });
      const runId = `run_${taskId}_${leased.attemptCount}`;
      const connection = new SqliteConnection(ws.root);
      try {
        const committer = new SqliteDiagnosticianCommitter(connection);
        await committer.commit({ runId, taskId, output: fakeDiagnosis(taskId), idempotencyKey: `${taskId}:${runId}` });
      } finally {
        try { connection.close(); } catch { /* best-effort */ }
      }
      await self.stateManager.markTaskSucceeded(taskId, `diagnostician://${runId}`);
      return { status: 'succeeded', taskId, attemptCount: leased.attemptCount, output: fakeDiagnosis(taskId) };
    } catch (error) {
      const category = (error as { category?: string }).category;
      if (category === 'lease_conflict') {
        return { status: 'failed', taskId, errorCategory: 'lease_conflict', failureReason: 'Task is leased by another consumer', attemptCount: 1 };
      }
      return { status: 'failed', taskId, errorCategory: 'execution_failed', failureReason: String(error).slice(0, 200), attemptCount: 1 };
    }
  });
  return { calls };
}

beforeEach(() => {
  vi.restoreAllMocks();
  // Safety net for every test: the downstream dreamer LLM boundary is never
  // the subject here — a spied no-op keeps the shared consumer cycle from
  // spawning real host runtimes.
  vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async (taskId: string) => ({
    status: 'failed', taskId, errorCategory: 'execution_failed', failureReason: 'test double: dreamer not under test', attemptCount: 1,
  }));
});

afterEach(async () => {
  vi.restoreAllMocks();
  setCodexTranscriptPortForTest(null);
  // Release any cached-bridge handles the cycle created before removing temp
  // dirs; Windows may also release closed SQLite handles asynchronously, so
  // cleanup retries briefly before declaring a pinned file (a real leak).
  const { disposePainSignalBridgesForWorkspace } = await import('@principles/core/runtime-v2');
  for (const dir of [...dirs]) {
    await disposePainSignalBridgesForWorkspace(dir).catch(() => {});
  }
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const dir of dirs.splice(0)) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(150);
      }
    }
    if (lastError !== null) {
      const probe: string[] = [];
      try {
        const pdDir = path.join(dir, '.pd');
        for (const entry of fs.readdirSync(pdDir)) {
          try { fs.rmSync(path.join(pdDir, entry), { force: true }); probe.push(`${entry}:ok`); } catch { probe.push(`${entry}:LOCKED`); }
        }
      } catch { probe.push('.pd:unreadable'); }
      throw new Error(`cleanup EPERM on ${dir} after retries: ${probe.join(',')} :: ${String(lastError).slice(0, 120)}`);
    }
  }
});

/** Drive the real hook to admit ONE correction and leave a pending diagnostician task. */
async function seedAdmittedPendingTask(ws: WorkerWorkspace): Promise<{ painId: string; taskId: string }> {
  const result = await runHook(ws, correctionPayload(ws));
  expect(result.status).toBe(0);
  const db = trajectoryOf(ws.root);
  const pain = db.prepare('SELECT canonical_pain_id FROM pain_events').get() as { canonical_pain_id: string } | undefined;
  const marker = db.prepare('SELECT diagnostician_task_id FROM governance_signal_admissions').get() as { diagnostician_task_id: string } | undefined;
  db.close();
  expect(pain?.canonical_pain_id).toMatch(/^pain_host_[0-9a-f]{64}$/);
  expect(marker?.diagnostician_task_id).toBe(`diagnosis_${pain?.canonical_pain_id}`);
  const task = diagnosticianTask(ws.root);
  expect(task).toMatchObject({ status: 'pending', attempt_count: 0 });
  return { painId: pain?.canonical_pain_id ?? '', taskId: marker?.diagnostician_task_id ?? '' };
}

describe('worker cycle — SPEC §13 flag ladder (matrix B)', () => {
  it('host.codex=false → paused, no steps run', async () => {
    const ws = makeWorkspace({ hostCodex: false });
    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('host.codex_disabled');
    expect(result.report).toBeUndefined();
  });

  it('workspace missing → degraded, nothing mutated', async () => {
    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: path.join(os.tmpdir(), 'pd-definitely-missing-ws'), env: {} });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toBe('workspace_missing');
  });

  it('codex_conversation_ingestion=false → ZERO transcript I/O while reconcile + diagnostician still run', async () => {
    const ws = makeWorkspace({ ingestion: true });
    await seedAdmittedPendingTask(ws);
    // Flip ingestion off AFTER seeding; remove the sessions root so even a
    // directory walk would have to surface — a clean skip proves the gate.
    writeConfig(ws, { ingestion: false });
    fs.rmSync(path.join(ws.codexHome, 'sessions'), { recursive: true, force: true });
    const readCalls: string[] = [];
    setCodexTranscriptPortForTest({ read: (args: { canonicalPath: string }) => { readCalls.push(args.canonicalPath); throw new Error('must not read'); } });
    const spy = spySplitPipelineSuccess(ws);

    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(result.mode).toBe('ready');
    expect(readCalls).toEqual([]);
    const catchUp = result.report?.catchUp as CodexCatchUpResult;
    expect(catchUp).toMatchObject({ status: 'skipped', reason: 'feature_disabled' });
    // Reconciliation and execution are NOT gated by the ingestion flag.
    expect(result.report?.reconcile).toMatchObject({ ok: true });
    expect(result.report?.diagnostician).toMatchObject({ status: 'succeeded' });
    void spy;
  });

  it('internalization_auto_consumer=false → paused: NO lease, NO LLM, but catch-up attempt + reconcile continue', async () => {
    const ws = makeWorkspace({ consumer: false });
    await seedAdmittedPendingTask(ws);
    const spy = spySplitPipelineSuccess(ws);

    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('internalization_auto_consumer_disabled');
    expect(spy.calls).toEqual([]);
    expect(result.report?.diagnostician).toBeNull();
    expect(result.report?.downstream).toBeNull();
    expect(result.report?.reconcile).toMatchObject({ ok: true });
    expect(result.report?.catchUp).toBeDefined();
    const task = diagnosticianTask(ws.root);
    expect(task).toMatchObject({ status: 'pending' }); // execution paused ≠ evidence frozen; manual path available
  });
});

describe('worker cycle — diagnostician terminal closure (matrix C, acceptance #1)', () => {
  it('an admitted pain reaches terminal diagnosis exactly once, with 0 LLM inside the hook', async () => {
    const ws = makeWorkspace();
    // The hook admitted the pain and returned with the task still pending —
    // proving no LLM ran inside the hook; the worker closes it.
    const { taskId } = await seedAdmittedPendingTask(ws);
    const spy = spySplitPipelineSuccess(ws);

    const first = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(first.mode).toBe('ready');
    expect(first.report?.diagnostician).toMatchObject({ taskId, status: 'succeeded' });
    expect(candidateCount(ws.root)).toBe(1);
    // The real bridge committed candidates + seeded the downstream dreamer task.
    const db = stateDbOf(ws.root);
    const dreamerSeeded = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'dreamer'").get() as { n: number };
    db.close();
    expect(dreamerSeeded.n).toBeGreaterThanOrEqual(1);

    // Second cycle: nothing pending — exactly once, no duplicate candidate.
    const second = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(second.report?.diagnostician).toBeNull();
    expect(candidateCount(ws.root)).toBe(1);
    expect(spy.calls).toEqual([taskId]);
    expect(diagnosticianTask(ws.root)).toMatchObject({ status: 'succeeded' });
  });

  it('live lease held by another worker (not expired) → skipped, not stolen, no duplicate run', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);
    const stateManager = new RuntimeStateManager({ workspaceDir: ws.root });
    await stateManager.initialize();
    await stateManager.acquireLease({ taskId, owner: 'another-worker', runtimeKind: 'pi-ai', durationMs: 300_000 });
    await stateManager.close();
    const spy = spySplitPipelineSuccess(ws);

    await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(spy.calls).toEqual([]); // leased-valid task is not even attempted
    expect(candidateCount(ws.root)).toBe(0);
    expect(diagnosticianTask(ws.root)).toMatchObject({ status: 'leased', lease_owner: 'another-worker' });
  });

  it('EXPIRED lease → sweep flips it to retry_wait (fresh backoff), then the worker executes after the deadline', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);
    const stateManager = new RuntimeStateManager({ workspaceDir: ws.root });
    await stateManager.initialize();
    await stateManager.acquireLease({ taskId, owner: 'dead-worker', runtimeKind: 'pi-ai', durationMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stateManager.close();
    const spy = spySplitPipelineSuccess(ws);

    // Cycle 1: the recovery sweep flips the expired lease to retry_wait with a
    // NEW backoff deadline — the worker correctly does not execute yet.
    const first = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(first.report?.diagnostician).toMatchObject({ taskId, status: 'skipped', message: 'retry_wait_pending' });
    expect(spy.calls).toEqual([]);
    expect(diagnosticianTask(ws.root)).toMatchObject({ status: 'retry_wait' });

    // Backoff elapsed → the worker converges the crashed task.
    const writer = new Database(path.join(ws.root, '.pd', 'state.db'));
    writer.prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?').run(new Date(Date.now() - 60_000).toISOString(), taskId);
    writer.close();
    const second = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(second.report?.diagnostician).toMatchObject({ taskId, status: 'succeeded' });
    expect(spy.calls).toEqual([taskId]);
    expect(candidateCount(ws.root)).toBe(1);
  });
});

describe('worker cycle — SPEC §18 scenario 12: provider failure and recovery without duplicate candidates', () => {
  it('provider outage → retry_wait with preserved budget; backoff elapsed → next cycle succeeds; exactly one candidate', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);

    // Provider failure: acquire the lease, mark retry_wait (attempts=1), return retried.
    vi.spyOn(SplitDiagnosticianRunner.prototype, 'run').mockImplementation(async function (this: unknown) {
      const self = this as unknown as { stateManager: RuntimeStateManager };
      const leased = await self.stateManager.acquireLease({ taskId, owner: 'split-diagnostician-orchestrator', runtimeKind: 'pi-ai' });
      await self.stateManager.markTaskRetryWait(taskId, 'timeout', 'provider timeout (simulated)');
      return { status: 'retried', taskId, errorCategory: 'timeout', failureReason: 'provider timeout (simulated)', attemptCount: leased.attemptCount };
    });

    const first = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(first.report?.diagnostician).toMatchObject({ status: 'retried' });
    expect(diagnosticianTask(ws.root)).toMatchObject({ status: 'retry_wait', attempt_count: 1 });

    // Backoff window NOT elapsed: the next cycle must NOT run it again.
    const second = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(second.report?.diagnostician).toMatchObject({ status: 'skipped', message: 'retry_wait_pending' });
    expect(diagnosticianTask(ws.root)).toMatchObject({ status: 'retry_wait', attempt_count: 1 });

    // Backoff elapsed (retry deadline passed): recovery converges — no duplicate candidate.
    const db = stateDbOf(ws.root);
    void db;
    const writer = new Database(path.join(ws.root, '.pd', 'state.db'));
    writer.prepare('UPDATE tasks SET lease_expires_at = ? WHERE task_id = ?').run(new Date(Date.now() - 60_000).toISOString(), taskId);
    writer.close();
    vi.restoreAllMocks();
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async (id: string) => ({
      status: 'failed', taskId: id, errorCategory: 'execution_failed', failureReason: 'test double', attemptCount: 1,
    }));
    const spy = spySplitPipelineSuccess(ws);
    const third = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(third.report?.diagnostician).toMatchObject({ status: 'succeeded' });
    expect(spy.calls).toEqual([taskId]);
    expect(candidateCount(ws.root)).toBe(1);
    expect(runCount(ws.root, taskId)).toBe(2); // attempt 1 failed + attempt 2 succeeded — nothing more
  });

  it('review P1: an old retry_wait inside its backoff does not starve a younger elapsed one (no head-of-line blocking)', async () => {
    const ws = makeWorkspace();
    await seedAdmittedPendingTask(ws); // task A — oldest
    const secondHook = await runHook(ws, correctionPayload(ws, `${TURN_1.slice(0, 8)}-hol-second`));
    expect(secondHook.status).toBe(0); // task B — newer
    const db = stateDbOf(ws.root);
    const rows = db.prepare("SELECT task_id FROM tasks WHERE task_kind = 'diagnostician' AND status = 'pending' ORDER BY updated_at ASC").all() as Array<{ task_id: string }>;
    db.close();
    expect(rows).toHaveLength(2);
    const [taskA, taskB] = rows;
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
    // Both become retry_wait; A's backoff has NOT elapsed, B's HAS.
    const writer = new Database(path.join(ws.root, '.pd', 'state.db'));
    writer.prepare('UPDATE tasks SET status = ?, lease_expires_at = ?, attempt_count = 1 WHERE task_id = ?').run('retry_wait', new Date(Date.now() + 10 * 60_000).toISOString(), taskA.task_id);
    writer.prepare('UPDATE tasks SET status = ?, lease_expires_at = ?, attempt_count = 1 WHERE task_id = ?').run('retry_wait', new Date(Date.now() - 60_000).toISOString(), taskB.task_id);
    writer.close();

    const spy = spySplitPipelineSuccess(ws);
    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(spy.calls).toEqual([taskB.task_id]); // the ELIGIBLE one runs
    expect(result.report?.diagnostician).toMatchObject({ taskId: taskB.task_id, status: 'succeeded' });
    // A stays waiting with its budget untouched.
    expect(diagnosticianTask(ws.root)).toMatchObject({ task_id: taskA.task_id, status: 'retry_wait', attempt_count: 1 });
  });
});

describe('worker cycle — aggregated mode (review P1)', () => {
  it('a failed diagnostician surfaces the cycle as degraded with a structured reason', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);
    vi.spyOn(SplitDiagnosticianRunner.prototype, 'run').mockImplementation(async () => ({
      status: 'failed', taskId, errorCategory: 'execution_failed', failureReason: 'provider 500 (simulated)', attemptCount: 1,
    }));

    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toContain('diagnostician_failed');
    expect(result.report?.diagnostician).toMatchObject({ taskId, status: 'failed', errorCategory: 'execution_failed' });
  });

  it('a lease_conflict diagnostician failure is contention, NOT degradation', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);
    vi.spyOn(SplitDiagnosticianRunner.prototype, 'run').mockImplementation(async () => ({
      status: 'failed', taskId, errorCategory: 'lease_conflict', failureReason: 'Task is leased by another consumer', attemptCount: 1,
    }));

    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(result.mode).toBe('ready');
    expect(result.report?.diagnostician).toMatchObject({ taskId, status: 'failed', errorCategory: 'lease_conflict' });
  });
});

describe('worker cycle — backlog bound (matrix E)', () => {
  it('two pending diagnostics → exactly ONE executes per cycle, later cycles converge', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);
    const secondHook = await runHook(ws, correctionPayload(ws, `${TURN_1.slice(0, 8)}-second-turn`));
    expect(secondHook.status).toBe(0);
    const db = stateDbOf(ws.root);
    const count = db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician' AND status = 'pending'").get() as { n: number };
    db.close();
    expect(count.n).toBe(2);

    const spy = spySplitPipelineSuccess(ws);
    const cycle1 = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(spy.calls).toHaveLength(1);
    expect(cycle1.report?.diagnostician).toMatchObject({ status: 'succeeded' });
    const cycle2 = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(spy.calls).toHaveLength(2);
    expect(cycle2.report?.diagnostician).toMatchObject({ status: 'succeeded' });
    expect(candidateCount(ws.root)).toBe(2);
    expect(taskId.length).toBeGreaterThan(0);
  });
});

describe('worker cycle — concurrent consumers (matrix G)', () => {
  it('two worker cycles racing one ready task → exactly one lease, one execution, one candidate set', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);
    const spy = spySplitPipelineSuccess(ws);

    const [a, b] = await Promise.all([
      runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } }),
      runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } }),
    ]);
    // The durable lease admitted exactly one execution: at most one of the two
    // cycles executed (the loser either hit lease_conflict or arrived after
    // the task went terminal and found nothing pending).
    expect(spy.calls.length).toBeGreaterThanOrEqual(1);
    expect(spy.calls.length).toBeLessThanOrEqual(2);
    const statuses = [a.report?.diagnostician?.status, b.report?.diagnostician?.status].filter((value) => value !== undefined && value !== null);
    expect(statuses).toContain('succeeded');
    expect(statuses.filter((value) => value === 'succeeded')).toHaveLength(1);
    expect(candidateCount(ws.root)).toBe(1);
    expect(runCount(ws.root, taskId)).toBe(1);
    expect(diagnosticianTask(ws.root)).toMatchObject({ status: 'succeeded' });
  });
});

describe('worker cycle — multi-workspace isolation (matrix H)', () => {
  it('workspace A execution never touches workspace B state', async () => {
    const wsA = makeWorkspace();
    const wsB = makeWorkspace({ consumer: false });
    await seedAdmittedPendingTask(wsA);
    await seedAdmittedPendingTask(wsB);

    const spy = spySplitPipelineSuccess(wsA);
    const resultA = await runCodexWorkspaceWorkerCycle({ workspaceDir: wsA.root, env: { CODEX_HOME: wsA.codexHome } });
    const resultB = await runCodexWorkspaceWorkerCycle({ workspaceDir: wsB.root, env: { CODEX_HOME: wsB.codexHome } });

    expect(resultA.mode).toBe('ready');
    expect(resultB.mode).toBe('paused');
    expect(spy.calls).toHaveLength(1); // only workspace A's task
    expect(candidateCount(wsA.root)).toBe(1);
    expect(candidateCount(wsB.root)).toBe(0);
    expect(diagnosticianTask(wsB.root)).toMatchObject({ status: 'pending' }); // paused ≠ evidence mutation
  });
});

describe('worker cycle — reconciliation reuse (matrix D: Slice B seam)', () => {
  it('crash-before-link (Case B) is repaired by the worker cycle without creating a second task', async () => {
    const ws = makeWorkspace();
    const { taskId } = await seedAdmittedPendingTask(ws);
    // Simulate the crash window: the marker lost its link.
    const db = trajectoryOf(ws.root);
    db.prepare('UPDATE governance_signal_admissions SET diagnostician_task_id = NULL').run();
    db.close();

    const spy = spySplitPipelineSuccess(ws);
    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(result.report?.reconcile).toMatchObject({ ok: true, linksRepaired: 1 });
    const after = trajectoryOf(ws.root);
    const marker = after.prepare('SELECT diagnostician_task_id FROM governance_signal_admissions').get() as { diagnostician_task_id: string } | undefined;
    after.close();
    expect(marker?.diagnostician_task_id).toBe(taskId);
    const state = stateDbOf(ws.root);
    const tasks = state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get() as { n: number };
    state.close();
    expect(tasks.n).toBe(1);
    expect(spy.calls).toEqual([taskId]);
  });
});

describe('worker cycle — downstream reuse (shared executor)', () => {
  it('runs the dreamer successor through the shared consumer cycle in the same worker cycle', async () => {
    const ws = makeWorkspace();
    await seedAdmittedPendingTask(ws);
    const diagSpy = spySplitPipelineSuccess(ws);
    // This test overrides the safety net: dreamer succeeds through the real state manager.
    let dreamerRan: string | null = null;
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async (id: string) => {
      dreamerRan = id;
      const stateManager = new RuntimeStateManager({ workspaceDir: ws.root });
      await stateManager.initialize();
      try {
        await stateManager.markTaskSucceeded(id, 'dreamer://test-run');
      } finally {
        await stateManager.close();
      }
      return { status: 'succeeded', taskId: id, attemptCount: 1 } satisfies RunnerResult;
    });

    const result = await runCodexWorkspaceWorkerCycle({ workspaceDir: ws.root, env: { CODEX_HOME: ws.codexHome } });
    expect(diagSpy.calls).toHaveLength(1);
    expect(result.report?.downstream?.ran).toBe(true);
    expect(dreamerRan).not.toBeNull();
    expect(['dreamer', undefined]).toContain(result.report?.downstream?.taskKind);
  });
});
