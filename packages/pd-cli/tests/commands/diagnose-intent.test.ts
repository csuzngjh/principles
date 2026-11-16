/**
 * PRI-1231 + PRI-1232 / SPEC-PD-INTENT-UNIFICATION-001 §9.2 — `pd diagnose`
 * and `pd pain retry` pass the neutral host IntentDocReader into the real
 * Stage A, with snapshot retry-consistency semantics (SPEC §6.6):
 *
 *   capture  → flag-on first execution persists the snapshot on the STAGE task
 *   retry    → the SAME task reuses the persisted snapshot — INTENT.md edits
 *              between attempts never switch the strategic basis
 *   flag-off → no new capture; the historical snapshot survives untouched
 *   corrupt  → fail loud (input_invalid), never silently re-read
 *
 * REAL integration: the actual CLI handlers run against a real temp workspace
 * (config, trajectory, state.db, INTENT.md all real). Only the model boundary
 * is scripted: `TestDoubleRuntimeAdapter.prototype.fetchOutput` is spied to
 * serve the cached R6 fixtures with the session's trusted evidence ref (the
 * CLI builds its own adapter — this is not a mock of the pipeline).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { handlePainRecord } from '../../src/commands/pain-record.js';
import { handleDiagnoseRun } from '../../src/commands/diagnose.js';
import { handlePainRetry } from '../../src/commands/pain-retry.js';
import {
  RuntimeStateManager,
  TestDoubleRuntimeAdapter,
  computeIntentContentHash,
  invalidatePainSignalBridge,
} from '@principles/core/runtime';
import { resetHostIntentDocCacheForTest } from '@principles/host-runtime';
import {
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../../../principles-core/src/runtime/adapter/split-pipeline-fixtures.js';

const SESSION_ID = 'pri1231-session-1';
const CORRECTION_AT = '2026-01-01T10:00:00Z';
const TRUSTED_REF = `owner_message:${CORRECTION_AT}`;

const AUTHORED_INTENT = [
  '# INTENT.md',
  '',
  '## 1. Why',
  '',
  '保护 Owner 的长期注意力是这个阶段的最高优先级。',
  '',
  '## 2. Desired Outcome',
  '',
  '重复偏离在一个诊断周期内被识别并形成候选原则。',
  '',
  '## 3. Non-negotiables',
  '',
  '不牺牲诊断证据的真实性换取速度。',
  '',
  '## 4. Stop / Escalation',
  '',
  '诊断结论影响生产规则时必须请 Owner 决策。',
  '',
  '## 5. Current Strategic Focus',
  '',
  '证据链完整性优先于覆盖率。',
  '',
].join('\n');

const MODIFIED_INTENT = `${AUTHORED_INTENT}
## 追加战略注记
这一行是修改后的内容，绝不能出现在原始快照中。
`.replace('证据链完整性优先于覆盖率。', '证据链完整性优先于覆盖率。修改后的取舍观。');

interface Workspace {
  dir: string;
  taskId: string;
  painId: string;
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pd-diagnose-intent-'));
}

function writeConfig(workspaceDir: string, intentEnabled: boolean): void {
  const config = {
    version: 1,
    features: {
      intent_engineering: { category: 'quiet', enabled: intentEnabled },
      // Async submission: the record creates the durable pending task without
      // running Stage A — `pd diagnose` is then the REAL first execution.
      diagnostician_async_cli: { category: 'quiet', enabled: true },
    },
    runtimeProfiles: {
      'diag-profile': {
        type: 'pi-ai',
        provider: 'anthropic',
        model: 'claude-3-5-sonnet',
        apiKeyEnv: 'PRI1231_INTENT_TEST_KEY',
      },
    },
    internalAgents: {
      defaultRuntime: 'diag-profile',
      agents: { diagnostician: { enabled: true, runtimeProfile: 'diag-profile' } },
    },
  };
  fs.mkdirSync(path.join(workspaceDir, '.pd'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.pd', 'config.yaml'), JSON.stringify(config));
}

function writeIntent(workspaceDir: string, content: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.principles'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, '.principles', 'INTENT.zh-CN.md'), content, 'utf8');
}

function writeTrajectory(workspaceDir: string): void {
  fs.mkdirSync(path.join(workspaceDir, '.state'), { recursive: true });
  const db = new Database(path.join(workspaceDir, '.state', 'trajectory.db'));
  try {
    db.exec(`
      CREATE TABLE sessions (session_id TEXT PRIMARY KEY, started_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE user_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        raw_excerpt TEXT,
        correction_detected INTEGER,
        correction_cue TEXT,
        created_at TEXT
      );
    `);
    db.prepare('INSERT INTO sessions (session_id, started_at, updated_at) VALUES (?, ?, ?)')
      .run(SESSION_ID, CORRECTION_AT, CORRECTION_AT);
    db.prepare('INSERT INTO user_turns (session_id, raw_excerpt, correction_detected, correction_cue, created_at) VALUES (?, ?, 1, ?, ?)')
      .run(SESSION_ID, '不要自作主张，先调查已有实现再修改。', 'imperative_negative', CORRECTION_AT);
  } finally {
    db.close();
  }
}

/**
 * Script the model boundary on the CLI-built test-double adapter: stage-aware
 * dispatch of the cached R6 fixtures, with evidence refs bound to the
 * session's trusted correction ref and the distiller's artifact linkage fixed
 * to the real root-cause stage task.
 */
function installTestDoubleSpy(): { fetchOutput: ReturnType<typeof vi.fn>; rootCauseModelCalls: string[] } {
  const runIdToTaskId = new Map<string, string>();
  const rootCauseModelCalls: string[] = [];
  let rootCauseTaskId: string | null = null;

  vi.spyOn(TestDoubleRuntimeAdapter.prototype, 'startRun').mockImplementation(async (input) => {
    const taskId = input.taskRef?.taskId;
    // Reproduce the real double's run id convention so store linkage holds.
    const runId = typeof taskId === 'string' ? `run_${taskId}_1` : `td-run-${runIdToTaskId.size + 1}`;
    if (typeof taskId === 'string') runIdToTaskId.set(runId, taskId);
    return {
      runId,
      runtimeKind: 'test-double',
      startedAt: new Date().toISOString(),
      systemPromptDigest: undefined,
    };
  });
  const fetchOutput = vi.spyOn(TestDoubleRuntimeAdapter.prototype, 'fetchOutput').mockImplementation(async (runId: string) => {
    const taskId = runIdToTaskId.get(runId);
    if (taskId !== undefined && taskId.includes('diag_distiller')) {
      const sourceRootCauseArtifactId = `pi-art-${rootCauseTaskId ?? ''}-run_${rootCauseTaskId ?? ''}_1`;
      return { runId, payload: { ...MOCK_DISTILLER_OUTPUTS.R6, taskId, sourceRootCauseArtifactId } };
    }
    if (taskId !== undefined && taskId.includes('diag_router')) {
      return {
        runId,
        payload: {
          ...MOCK_ROUTER_OUTPUTS.R6,
          evidence: [{ sourceRef: TRUSTED_REF, note: 'Owner corrected repeated unauthorized changes.' }],
          recommendations: MOCK_ROUTER_OUTPUTS.R6.recommendations.map((rec) =>
            rec.kind === 'rule' && rec.principleAssociation
              ? { ...rec, principleAssociation: { ...rec.principleAssociation, evidenceRefs: [TRUSTED_REF] } }
              : rec,
          ),
        },
      };
    }
    rootCauseTaskId = taskId ?? null;
    if (taskId !== undefined) rootCauseModelCalls.push(taskId);
    const r6 = MOCK_ROOT_CAUSE_OUTPUTS.R6;
    return {
      runId,
      payload: {
        ...r6,
        taskId: taskId ?? 'pri1231-task',
        evidence: [{ sourceRef: TRUSTED_REF, note: 'Owner corrected repeated unauthorized changes.' }],
        causalChain: r6.causalChain.map((entry) => ({ ...entry, evidenceRefs: [TRUSTED_REF] })),
      },
    };
  });
  return { fetchOutput, rootCauseModelCalls };
}

/** Submit an async pain record through the REAL CLI and return its durable ids. */
async function submitAsyncRecord(workspaceDir: string): Promise<{ painId: string; taskId: string }> {
  const log: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  try {
    await handlePainRecord({
      reason: '诊断入口接线验证——重复偏离',
      score: 70,
      json: true,
      session: SESSION_ID,
      workspace: workspaceDir,
    } as never);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  const jsonLine = log.find((line) => line.trim().startsWith('{'));
  expect(jsonLine).toBeDefined();
  const outcome = JSON.parse(jsonLine as string) as { painId?: string; taskId?: string; status?: string };
  expect(outcome.taskId).toBeDefined();
  return { painId: outcome.painId as string, taskId: outcome.taskId as string };
}

/** Run the REAL diagnose command on the durable task (test-double runtime). */
async function runDiagnose(workspaceDir: string, taskId: string): Promise<Record<string, unknown>> {
  const log: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  try {
    await handleDiagnoseRun({
      taskId,
      workspace: workspaceDir,
      runtime: 'test-double',
      json: true,
    } as never);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  const jsonLine = [...log].reverse().find((line) => line.trim().startsWith('{'));
  return jsonLine ? (JSON.parse(jsonLine) as Record<string, unknown>) : {};
}

/** Run the REAL pain-retry command on the durable task (test-double runtime). */
async function runPainRetry(workspaceDir: string, painId: string): Promise<Record<string, unknown>> {
  const log: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    log.push(args.map(String).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as () => never);
  try {
    await handlePainRetry({
      painId,
      workspace: workspaceDir,
      runtime: 'test-double',
      json: true,
    } as never);
  } finally {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  }
  const jsonLine = [...log].reverse().find((line) => line.trim().startsWith('{'));
  return jsonLine ? (JSON.parse(jsonLine) as Record<string, unknown>) : {};
}

async function withStateManager<T>(workspaceDir: string, fn: (sm: RuntimeStateManager) => Promise<T>): Promise<T> {
  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    return await fn(stateManager);
  } finally {
    await stateManager.close().catch(() => undefined);
  }
}

/** The persisted intent snapshot of the root-cause STAGE task (or undefined). */
async function readStageSnapshot(workspaceDir: string, taskId: string): Promise<{ contentHash?: string } | undefined> {
  return withStateManager(workspaceDir, async (sm) => {
    const stageId = `diag_rootcause-${taskId}`;
    const task = await sm.getTask(stageId);
    if (task?.diagnosticJson === undefined || task.diagnosticJson === null) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(task.diagnosticJson);
    } catch {
      return undefined;
    }
    if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'pi_metadata')) return undefined;
    const metadata = (parsed as Record<string, unknown>).pi_metadata;
    if (metadata === null || typeof metadata !== 'object' || !Object.hasOwn(metadata as object, 'intentSnapshot')) return undefined;
    return (metadata as Record<string, unknown>).intentSnapshot as { contentHash?: string };
  });
}

/** Reset the parent + stage tasks to a retry_wait state (crash-after-persist). */
async function resetToRetryWait(workspaceDir: string, taskId: string): Promise<void> {
  await withStateManager(workspaceDir, async (sm) => {
    for (const candidateId of [taskId, `diag_rootcause-${taskId}`, `diag_distiller-${taskId}`, `diag_router-${taskId}`]) {
      const task = await sm.getTask(candidateId);
      if (task === null) continue;
      await sm.updateTask(candidateId, { status: 'retry_wait', attemptCount: 1, lastError: null });
    }
  });
}

async function makeSubmittedWorkspace(intentEnabled: boolean, intentContent: string): Promise<Workspace> {
  const dir = makeWorkspace();
  writeConfig(dir, intentEnabled);
  writeTrajectory(dir);
  writeIntent(dir, intentContent);
  const { painId, taskId } = await submitAsyncRecord(dir);
  return { dir, taskId, painId };
}

describe('PRI-1231/1232: pd diagnose + pd pain retry intent snapshot semantics', () => {
  beforeEach(() => {
    resetHostIntentDocCacheForTest();
    process.env.PRI1231_INTENT_TEST_KEY = 'sentinel';
  });

  afterEach(async () => {
    delete process.env.PRI1231_INTENT_TEST_KEY;
    vi.restoreAllMocks();
    resetHostIntentDocCacheForTest();
  });

  it('async submission does NOT capture a snapshot; the first diagnose run captures it (flag ON, authored)', async () => {
    const ws = await makeSubmittedWorkspace(true, AUTHORED_INTENT);
    try {
      // Async submit: Stage A has not run — no snapshot anywhere yet.
      expect(await readStageSnapshot(ws.dir, ws.taskId)).toBeUndefined();

      installTestDoubleSpy();
      await runDiagnose(ws.dir, ws.taskId);

      const snapshot = await readStageSnapshot(ws.dir, ws.taskId);
      expect(snapshot).toMatchObject({ contentHash: computeIntentContentHash(AUTHORED_INTENT), lang: 'zh-CN' });
    } finally {
      invalidatePainSignalBridge(ws.dir);
      fs.rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('retry after INTENT.md edit reuses the ORIGINAL snapshot through the real pd pain retry entry', async () => {
    const ws = await makeSubmittedWorkspace(true, AUTHORED_INTENT);
    try {
      installTestDoubleSpy();
      await runDiagnose(ws.dir, ws.taskId);
      const first = await readStageSnapshot(ws.dir, ws.taskId);
      expect(first).toBeDefined();

      // Owner edits INTENT.md between attempts.
      writeIntent(ws.dir, MODIFIED_INTENT);
      resetHostIntentDocCacheForTest();
      await resetToRetryWait(ws.dir, ws.taskId);

      await runPainRetry(ws.dir, ws.painId);

      const second = await readStageSnapshot(ws.dir, ws.taskId);
      // SPEC §6.6: the persisted snapshot is the input of record — its hash
      // must still be the ORIGINAL capture, never the modified file.
      expect(second?.contentHash).toBe(first?.contentHash);
      expect(second?.contentHash).toBe(computeIntentContentHash(AUTHORED_INTENT));
      expect(second?.contentHash).not.toBe(computeIntentContentHash(MODIFIED_INTENT));
    } finally {
      invalidatePainSignalBridge(ws.dir);
      fs.rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('flag OFF: no snapshot captured and the normal diagnosis path is unaffected', async () => {
    const ws = await makeSubmittedWorkspace(false, AUTHORED_INTENT);
    try {
      installTestDoubleSpy();
      await runDiagnose(ws.dir, ws.taskId);
      expect(await readStageSnapshot(ws.dir, ws.taskId)).toBeUndefined();
    } finally {
      invalidatePainSignalBridge(ws.dir);
      fs.rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('flag OFF retry keeps the historical snapshot untouched (no re-read, no deletion)', async () => {
    const ws = await makeSubmittedWorkspace(true, AUTHORED_INTENT);
    try {
      installTestDoubleSpy();
      await runDiagnose(ws.dir, ws.taskId);
      const first = await readStageSnapshot(ws.dir, ws.taskId);
      expect(first).toBeDefined();

      // Owner switches the flag OFF, edits the file, retries.
      writeConfig(ws.dir, false);
      writeIntent(ws.dir, MODIFIED_INTENT);
      resetHostIntentDocCacheForTest();
      await resetToRetryWait(ws.dir, ws.taskId);

      await runDiagnose(ws.dir, ws.taskId);

      const second = await readStageSnapshot(ws.dir, ws.taskId);
      // The historical snapshot is preserved verbatim (SPEC §10.3).
      expect(second?.contentHash).toBe(first?.contentHash);
    } finally {
      invalidatePainSignalBridge(ws.dir);
      fs.rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('a malformed persisted snapshot fails loud (input_invalid) — never silently re-reads INTENT.md', async () => {
    const ws = await makeSubmittedWorkspace(true, AUTHORED_INTENT);
    try {
      // First execution captures a real snapshot and creates the stage task.
      installTestDoubleSpy();
      await runDiagnose(ws.dir, ws.taskId);
      expect(await readStageSnapshot(ws.dir, ws.taskId)).toBeDefined();
      vi.restoreAllMocks();

      // Crash-after-persist, then the snapshot on disk gets corrupted.
      await resetToRetryWait(ws.dir, ws.taskId);
      await withStateManager(ws.dir, async (sm) => {
        const stageId = `diag_rootcause-${ws.taskId}`;
        const task = await sm.getTask(stageId);
        expect(task).not.toBeNull();
        const base = task?.diagnosticJson ? JSON.parse(task.diagnosticJson) as Record<string, unknown> : {};
        base.pi_metadata = { ...(base.pi_metadata as object | undefined), intentSnapshot: 'not-a-snapshot' };
        await sm.updateTask(stageId, { diagnosticJson: JSON.stringify(base) });
      });

      const spy = installTestDoubleSpy();
      const result = await runDiagnose(ws.dir, ws.taskId);

      // rc-3: corrupted strategic input is a real fault — the run must fail
      // loudly and the model must NOT have been called for root cause.
      expect(JSON.stringify(result)).toContain('input_invalid');
      expect(spy.rootCauseModelCalls).toHaveLength(0);
    } finally {
      invalidatePainSignalBridge(ws.dir);
      fs.rmSync(ws.dir, { recursive: true, force: true });
    }
  }, 180_000);
});
