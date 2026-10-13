/**
 * WorkBuddy workspace worker cycle tests (SPEC workbuddy-host-adapter §5
 * Part 5): the flag ladder is WorkBuddy's OWN (no Codex flag borrowing), the
 * shared reconcile/downstream authorities run on the real SQLite governance
 * workspace, and the WorkBuddy host tool declaration is persisted for
 * host-neutral consumers. LLM-execution paths reuse the exact Codex-tested
 * bridge contract and are exercised end-to-end in the real-chain acceptance;
 * here the empty-queue cycle proves the production wiring with zero LLM.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DreamerRunner,
  getDefaultPdConfig,
  disposePainSignalBridgesForWorkspace,
  RuntimeStateManager,
  SplitDiagnosticianRunner,
  SqliteConnection,
  SqliteDiagnosticianCommitter,
  type DiagnosticianOutputV1,
} from '@principles/core/runtime-v2';
import type { HostEvent } from '@principles/core/host';
import { createProductionPainEvidenceHandler, resetProductionPainCooldownForTest } from '@principles/host-runtime';
import { runWorkbuddyWorkspaceWorkerCycle } from '../src/worker/workspace-worker.js';
import { makeHome, makeGovernance, cleanupTempDirs } from './helpers/workbench.js';

const TRAJECTORY_DDL = [
  'CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL)',
  'CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, outcome TEXT NOT NULL, duration_ms INTEGER, exit_code INTEGER, error_type TEXT, error_message TEXT, gfi_before REAL, gfi_after REAL, params_json TEXT NOT NULL, result_preview TEXT, created_at TEXT NOT NULL)',
  'CREATE TABLE pain_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, source TEXT NOT NULL, score REAL NOT NULL, reason TEXT, severity TEXT, origin TEXT, confidence REAL, text TEXT, canonical_pain_id TEXT, runtime_task_id TEXT, host_kind TEXT, created_at TEXT NOT NULL)',
  'CREATE UNIQUE INDEX idx_pain_events_canonical_pain_id ON pain_events(canonical_pain_id) WHERE canonical_pain_id IS NOT NULL',
];

interface WorkerOverrides {
  workbuddy?: boolean;
  consumer?: boolean;
  codex?: boolean;
  malformed?: boolean;
}

function makeWorkerWorkspace(overrides: WorkerOverrides = {}): string {
  const home = makeHome();
  const governance = makeGovernance(home, { workbuddyFlag: overrides.workbuddy ?? true, malformed: overrides.malformed });
  if (!overrides.malformed) {
    const configPath = path.join(governance, '.pd', 'config.yaml');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { features: Record<string, { enabled: boolean } | undefined> };
    if (config.features['internalization_auto_consumer']) config.features['internalization_auto_consumer'].enabled = overrides.consumer ?? true;
    if (config.features['host.codex']) config.features['host.codex'].enabled = overrides.codex ?? false;
    fs.writeFileSync(configPath, JSON.stringify(config));
  }
  fs.mkdirSync(path.join(governance, '.state'), { recursive: true });
  const trajectory = new Database(path.join(governance, '.state', 'trajectory.db'));
  for (const statement of TRAJECTORY_DDL) trajectory.prepare(statement).run();
  trajectory.close();
  return governance;
}

afterAll(() => {
  cleanupTempDirs();
});

describe('WorkBuddy worker cycle — flag ladder', () => {
  it('host.workbuddy=false → paused, no steps run (host.codex=true does NOT activate it)', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: false, codex: true });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('host.workbuddy_disabled');
    expect(result.report).toBeUndefined();
    // No host declaration, no downstream writes on a paused workspace.
    expect(fs.existsSync(path.join(governance, '.pd', 'host-tool-semantics'))).toBe(false);
  });

  it('workspace missing → degraded, nothing mutated', async () => {
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: path.join(os.tmpdir(), 'pd-workbuddy-definitely-missing') });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toBe('workspace_missing');
  });

  it('malformed governance config → degraded with the pd_config_invalid reason', async () => {
    const governance = makeWorkerWorkspace({ malformed: true });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toContain('pd_config_invalid');
  });

  it('internalization_auto_consumer=false → paused execution (reconcile already ran)', async () => {
    const governance = makeWorkerWorkspace({ consumer: false });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('paused');
    expect(result.reason).toBe('internalization_auto_consumer_disabled');
    expect(result.report?.downstream).toBeNull();
    expect(fs.existsSync(path.join(governance, '.pd', 'host-tool-semantics'))).toBe(false);
  });
});

describe('WorkBuddy worker cycle — production ready path (empty queue, zero LLM)', () => {
  it('runs reconcile + downstream and persists the WorkBuddy host tool declaration', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('ready');
    expect(result.reason).toBeUndefined();
    expect(result.report?.reconcile.ok).toBe(true);
    expect(result.report?.diagnostician).toBeNull();
    expect(result.report?.downstream).not.toBeNull();

    // The declaration names the WorkBuddy host with the probe-verified tool
    // mappings — host-neutral consumers must resolve workbuddy semantics.
    const declarationPath = path.join(governance, '.pd', 'host-tool-semantics', 'workbuddy.json');
    expect(fs.existsSync(declarationPath)).toBe(true);
    const declaration = JSON.parse(fs.readFileSync(declarationPath, 'utf8')) as { hostKind: string; version: number };
    expect(declaration.hostKind).toBe('workbuddy');
    expect(declaration.version).toBe(1);
  });

  it('declaration persist failure degrades and SKIPS the downstream cycle', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    // Block the declarations directory with a regular file so
    // saveHostToolDeclaration cannot create workbuddy.json.
    fs.writeFileSync(path.join(governance, '.pd', 'host-tool-semantics'), 'not a directory');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.reason).toContain('host_tool_declaration_persist_failed');
    expect(result.report?.downstream).toBeNull();
  });

  it('never borrows the Codex catch-up: no CODEX_HOME/env read, no transcript access', async () => {
    const governance = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    // The cycle options carry no Codex env at all — if the cycle tried any
    // Codex ingestion it would need CODEX_HOME or a sessions directory;
    // neither exists. The run must still be ready.
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('ready');
  });
});

describe('WorkBuddy worker status mode (host-runtime authority)', () => {
  it('mirrors the flag ladder without executing anything', async () => {
    const { computeWorkbuddyWorkerStatusMode } = await import('@principles/host-runtime');
    const off = makeWorkerWorkspace({ workbuddy: false });
    expect(computeWorkbuddyWorkerStatusMode({ workspaceDir: off, registeredInInstallManifest: true })).toMatchObject({ mode: 'paused', reason: 'host.workbuddy_disabled' });
    const ready = makeWorkerWorkspace({ workbuddy: true, consumer: true });
    expect(computeWorkbuddyWorkerStatusMode({ workspaceDir: ready, registeredInInstallManifest: true })).toMatchObject({ mode: 'ready' });
    expect(computeWorkbuddyWorkerStatusMode({ workspaceDir: ready, registeredInInstallManifest: false })).toMatchObject({ mode: 'manual_action_required', reason: 'workspace_not_in_install_manifest' });
  });
});

describe('WorkBuddy worker cycle — bare pain admission wiring (R2/P1)', () => {
  /**
   * Write one bare workbuddy pain through the REAL production pain handler —
   * the exact shared code the pd-hook dist entry dispatches to (proven against
   * the real entry in pd-hook-production.test.ts). The handler is what leaves
   * the stranded evidence row this wiring must pick up.
   */
  async function writeBarePainViaProductionHandler(governance: string): Promise<string | null> {
    resetProductionPainCooldownForTest();
    const handler = createProductionPainEvidenceHandler({ hostKind: 'workbuddy' });
    const event: HostEvent = {
      kind: 'after_tool_call',
      context: {
        workspaceDir: governance,
        sessionId: 'wb-r2-session-1',
        turnId: 'wb-r2-turn-1',
        toolName: 'Write',
        toolInput: { file_path: path.join(path.parse(governance).root, 'etc', 'wb-r2-protected.txt'), content: 'x' },
        toolOutput: { error: 'EACCES permission denied', result: { exitCode: 1 }, durationMs: 5 },
      },
      rawPayload: { host: 'r2-worker-test' },
      source: 'workbuddy:post_tool_use',
    };
    const result = await handler(event);
    const painId = result.metadata?.painId;
    return typeof painId === 'string' ? painId : null;
  }

  /**
   * Fake ONLY the LLM boundary with REAL semantics (the exact Codex-tested
   * bridge pattern): acquire the durable lease through the production lease
   * manager, commit through the production committer, mark the task succeeded.
   * Zero provider calls; everything else on the cycle is the production path.
   */
  function spyDiagnosticianSuccess(governance: string): string[] {
    const calls: string[] = [];
    vi.spyOn(SplitDiagnosticianRunner.prototype, 'run').mockImplementation(async function (taskId: string) {
      calls.push(taskId);
      const self = this as unknown as { stateManager: RuntimeStateManager };
      try {
        const leased = await self.stateManager.acquireLease({ taskId, owner: 'split-diagnostician-orchestrator', runtimeKind: 'pi-ai' });
        const runId = `run_${taskId}_${leased.attemptCount}`;
        const diagnosis: DiagnosticianOutputV1 = {
          valid: true,
          diagnosisId: `diag-${taskId}`,
          summary: '受保护路径写入失败',
          rootCause: 'Tooling: 外部路径权限拒绝',
          violatedPrinciples: [],
          evidence: [
            { sourceRef: 'workbuddy:tool_failure', note: 'bare workbuddy pain admitted by the worker sweep' },
          ],
          recommendations: [
            { kind: 'principle', description: '写入受保护路径前先确认权限', abstractedPrinciple: '修改前先调查并确认执行边界' },
          ],
          confidence: 0.9,
        };
        const connection = new SqliteConnection(governance);
        try {
          const committer = new SqliteDiagnosticianCommitter(connection);
          await committer.commit({ runId, taskId, output: diagnosis, idempotencyKey: `${taskId}:${runId}` });
        } finally {
          try { connection.close(); } catch { /* best-effort */ }
        }
        await self.stateManager.markTaskSucceeded(taskId, `diagnostician://${runId}`);
        return { status: 'succeeded', taskId, attemptCount: leased.attemptCount, output: diagnosis };
      } catch (error) {
        return { status: 'failed' as const, taskId, errorCategory: 'execution_failed', failureReason: String(error).slice(0, 200), attemptCount: 1 };
      }
    });
    // Safety net: the downstream dreamer LLM boundary is never the subject of
    // this suite — a spied no-op keeps the shared consumer cycle from spawning
    // real host runtimes (same discipline as the Codex worker suite).
    vi.spyOn(DreamerRunner.prototype, 'run').mockImplementation(async (taskId: string) => ({
      status: 'failed' as const, taskId, errorCategory: 'execution_failed', failureReason: 'test double: dreamer not under test', attemptCount: 1,
    }));
    return calls;
  }

  /** Workspaces this suite created — disposed + de-handle-pinned after each test (Windows file locks). */
  const createdWorkspaces: string[] = [];

  function trackWorkspace(governance: string): string {
    createdWorkspaces.push(governance);
    return governance;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    // Release the cached-bridge handles the worker cycle created BEFORE the
    // afterAll temp-dir sweep (the canonical Codex-worker-suite cleanup;
    // invalidatePainSignalBridge drops cache entries WITHOUT disposing).
    for (const dir of createdWorkspaces.splice(0)) {
      await disposePainSignalBridgesForWorkspace(dir).catch(() => undefined);
    }
  });

  it('admits a bare workbuddy pain into the existing governance queue and the diagnostician closes the task', async () => {
    const governance = trackWorkspace(makeWorkerWorkspace({ workbuddy: true, consumer: true }));
    const painId = await writeBarePainViaProductionHandler(governance);
    expect(painId).toMatch(/^pain_host_[0-9a-f]{64}$/);
    const executed = spyDiagnosticianSuccess(governance);

    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    // Admission report: the bare pain became a marker + a task in ONE cycle.
    expect(result.report?.admission).toMatchObject({ ok: true, admitted: 1, ensured: 1, skippedLowScore: 0 });

    const db = new Database(path.join(governance, '.state', 'trajectory.db'), { readonly: true });
    let marker: Record<string, unknown> | undefined;
    try {
      marker = db.prepare('SELECT * FROM governance_signal_admissions WHERE canonical_pain_id = ?').get(painId) as Record<string, unknown> | undefined;
    } finally {
      db.close();
    }
    expect(marker).toBeDefined();
    expect(marker?.host_kind).toBe('workbuddy');
    expect(marker?.logical_observation_key).toBe(`workbuddy|wb-r2-session-1|${painId}`);
    expect(marker?.diagnostician_task_id).toBe(`diagnosis_${painId}`);

    // The diagnostician step of the SAME cycle claimed and closed the
    // admission-created task through the real lease/commit path (LLM spied).
    expect(executed).toEqual([`diagnosis_${painId}`]);
    expect(result.report?.diagnostician).toMatchObject({ taskId: `diagnosis_${painId}`, status: 'succeeded' });
    expect(result.mode).toBe('ready');

    // Exactly ONE task exists and it reached terminal success — no second
    // queue, no re-execution.
    const state = new Database(path.join(governance, '.pd', 'state.db'), { readonly: true });
    try {
      const tasks = state.prepare("SELECT task_id, status FROM tasks WHERE task_kind = 'diagnostician'").all() as { task_id: string; status: string }[];
      expect(tasks).toEqual([{ task_id: `diagnosis_${painId}`, status: 'succeeded' }]);
    } finally {
      state.close();
    }
  });

  it('a second cycle over the same pain is an admission no-op (still exactly one, terminal task)', async () => {
    const governance = trackWorkspace(makeWorkerWorkspace({ workbuddy: true, consumer: true }));
    const painId = await writeBarePainViaProductionHandler(governance);
    expect(painId).not.toBeNull();
    spyDiagnosticianSuccess(governance);
    await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    const second = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(second.report?.admission).toMatchObject({ ok: true, admitted: 0, ensured: 0 });
    // The terminal task is not re-picked; no candidate executed again.
    expect(second.report?.diagnostician).toBeNull();
    const state = new Database(path.join(governance, '.pd', 'state.db'), { readonly: true });
    try {
      expect(state.prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_kind = 'diagnostician'").get()).toEqual({ n: 1 });
    } finally {
      state.close();
    }
  });

  it('an admission store failure degrades the cycle observably and stays retryable (rc-9)', async () => {
    const governance = trackWorkspace(makeWorkerWorkspace({ workbuddy: true, consumer: true }));
    expect(await writeBarePainViaProductionHandler(governance)).not.toBeNull();
    // Corrupt the trajectory store: reconcile AND admission must both report
    // the degradation; the cycle becomes degraded with a nextAction and no
    // silent skip.
    fs.writeFileSync(path.join(governance, '.state', 'trajectory.db'), 'definitely not a sqlite database');
    const result = await runWorkbuddyWorkspaceWorkerCycle({ workspaceDir: governance });
    expect(result.mode).toBe('degraded');
    expect(result.nextAction).toBeTruthy();
    expect(result.report?.admission.ok).toBe(false);
    expect(result.report?.reconcile.ok).toBe(false);
  });
});
