/**
 * PRI-510 (DEFECT-004): EvaluatorRunner repair-loop CLI wiring (EP-02).
 *
 * Tests that the CLI production path constructs `EvaluatorRunner` with the
 * repair-loop deps (`isRepairLoopEnabled` + `seedArtificerRepairTask`) so the
 * PRI-509 core logic is actually invoked at runtime. Without this wiring, the
 * repair loop is dead code in production — `evaluator needs_revision` seeds
 * nothing (EP-02: component exists with isolated tests but real path never
 * calls it).
 *
 * Trust boundary (rc-1, rc-2): the seeder writes `repairPayload` (sourced from
 * evaluator LLM output) into `diagnosticJson` via the validated
 * `createPITaskDiagnosticJson` serializer — no `as` bypass.
 *
 * Loop state freshness (rc-7, EP-05): the seeder does NOT infer
 * `repairIteration` from any cached value; it uses the `repairPayload`
 * constructed by the evaluator runner (which reads it from the dependency
 * artificer task's metadata, written at task creation time).
 *
 * Fail loud (rc-9, EP-03): when `isRepairLoopEnabled` returns false, the
 * `EvaluatorRunner` follows the legacy path (no seeder call). This is
 * observable backward-compatible behavior, not a silent fallback.
 *
 * ERR refs:
 *   - EP-02 / ERR-011 / ERR-024: production path wiring — fix the wiring,
 *     not just the leaf helper.
 *   - EP-04 / cli-7-test-wiring: tests exercise the real helper used by both
 *     CLI construction sites (`runtime-internalization-run-once.ts`,
 *     `rulehost-pipeline-runner.ts`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createEvaluatorRunnerDeps } from '../rulehost-pipeline-runner.js';
import type { SeedArtificerRepairParams } from '@principles/core/runtime';
import type { RuntimeStateManager, TaskRecord } from '@principles/core/runtime';

// ─── Test workspace helpers ────────────────────────────────────────────────

function createTempWorkspace(featureFlagEnabled: boolean | null): string {
  // CodeQL: use mkdtempSync for atomic, unpredictable temp dir creation
  // (avoids path-prediction risk from Date.now() + Math.random()).
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri-510-'));
  const pdDir = path.join(tmpDir, '.pd');
  fs.mkdirSync(pdDir, { recursive: true });
  // When featureFlagEnabled is null, write a config WITHOUT the
  // evaluator_artificer_repair_loop entry (defaults apply → false).
  // Otherwise include the 3 core features + the repair-loop flag.
  const repairFlagEntry =
    featureFlagEnabled === null
      ? ''
      : `  evaluator_artificer_repair_loop: { category: quiet, enabled: ${featureFlagEnabled}, since: '2026-07-04' }\n`;
  const yaml = `
version: 1
features:
  prompt: { category: core, enabled: true }
  code_tool_hook: { category: core, enabled: true }
  defer_archive: { category: core, enabled: true }
${repairFlagEntry}workspace:
  default: ${tmpDir.replace(/\\/g, '/')}
internalAgents:
  defaultRuntime: pi-ai.lmstudio
  agents:
    diagnostician:
      enabled: true
    dreamer:
      enabled: true
    philosopher:
      enabled: true
    scribe:
      enabled: true
    artificer:
      enabled: true
runtimeProfiles:
  pi-ai.lmstudio:
    type: pi-ai
    provider: lmstudio
    model: qwen3.6-27b-mtp
    apiKeyEnv: LMSTUDIO_API_KEY
    baseUrl: http://localhost:1234/v1
`;
  fs.writeFileSync(path.join(pdDir, 'config.yaml'), yaml, 'utf-8');
  return tmpDir;
}

function cleanupWorkspace(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

// ─── Mock stateManager ─────────────────────────────────────────────────────

function createMockStateManager(): {
  stateManager: RuntimeStateManager;
  createdTasks: TaskRecord[];
} {
  const createdTasks: TaskRecord[] = [];
  const stateManager = {
    getTask: vi.fn(async (taskId: string) =>
      createdTasks.find((t) => t.taskId === taskId) ?? null),
    createTask: vi.fn(async (record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>) => {
      const now = new Date().toISOString();
      const task: TaskRecord = { ...record, createdAt: now, updatedAt: now };
      createdTasks.push(task);
      return task;
    }),
    // 简化 CAS: 仅在 diagnosticJson 逐字节一致时应用 patch, 否则返回 null —
    // 与生产 store 的前提失败语义同形 (precondition-only, 不模拟 lease 竞争)。
    updateTaskIfDiagnosticJsonUnchanged: vi.fn(async (
      taskId: string,
      expectedDiagnosticJson: string | null,
      patch: Record<string, unknown>,
    ) => {
      const task = createdTasks.find((t) => t.taskId === taskId);
      if (!task) return null;
      if ((task.diagnosticJson ?? null) !== expectedDiagnosticJson) return null;
      Object.assign(task, patch);
      return task;
    }),
  } as unknown as RuntimeStateManager;
  return { stateManager, createdTasks };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function makeValidSeedParams(): SeedArtificerRepairParams {
  return {
    repairPayload: {
      requiredChanges: ['fix path validation', 'add error handling'],
      concerns: ['code quality is poor'],
      previousScore: 0.55,
      repairIteration: 1,
      sourceArtificerArtifactId: 'pi-art-artificer-original',
      sourceEvaluatorTaskId: 'evaluator-r0',
    },
    inheritedDependencyTaskIds: ['scribe-task-001'],
    inheritedChannel: 'prompt',
    inheritedTimeoutMs: 300_000,
    inheritedInputArtifactRefs: [
      { artifactType: 'principle', ref: 'pi-art-scribe-001' },
    ],
    ownerEvidenceSelection: {
      sourcePainId: 'pain-cli-001',
      sourceNegativeToolCallId: 42,
      positiveToolCallIds: [7],
      ownerDesiredOutcome: 'preserve the Owner-selected example set',
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('PRI-510 (DEFECT-004): createEvaluatorRunnerDeps wires repair loop into CLI (EP-02)', () => {
  let tmpWorkspaces: string[] = [];

  beforeEach(() => {
    tmpWorkspaces = [];
  });

  afterEach(() => {
    for (const dir of tmpWorkspaces) cleanupWorkspace(dir);
    tmpWorkspaces = [];
  });

  it('flag enabled → isRepairLoopEnabled() returns true (EP-02: production wiring works)', () => {
    const workspaceDir = createTempWorkspace(true);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager } = createMockStateManager();

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir,
    });

    expect(deps.isRepairLoopEnabled).toBeDefined();
    expect(typeof deps.isRepairLoopEnabled).toBe('function');
    // Guard before call — rc-2: no `!` non-null assertion (lint rule).
    if (typeof deps.isRepairLoopEnabled !== 'function') throw new Error('isRepairLoopEnabled missing');
    expect(deps.isRepairLoopEnabled()).toBe(true);
  });

  it('flag disabled → isRepairLoopEnabled() returns false (backward compatible)', () => {
    const workspaceDir = createTempWorkspace(false);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager } = createMockStateManager();

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir,
    });

    expect(typeof deps.isRepairLoopEnabled).toBe('function');
    if (typeof deps.isRepairLoopEnabled !== 'function') throw new Error('isRepairLoopEnabled missing');
    expect(deps.isRepairLoopEnabled()).toBe(false);
  });

  it('flag absent in config → isRepairLoopEnabled() returns true (P0-D: default-on since core-loop closure)', () => {
    const workspaceDir = createTempWorkspace(null);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager } = createMockStateManager();

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir,
    });

    expect(typeof deps.isRepairLoopEnabled).toBe('function');
    if (typeof deps.isRepairLoopEnabled !== 'function') throw new Error('isRepairLoopEnabled missing');
    // 契约变更 (2026-08-18, INV-02): registry 默认 ON;flag 缺省 = 默认生效
    expect(deps.isRepairLoopEnabled()).toBe(true);
  });

  it('malformed config → isRepairLoopEnabled() falls back to registry defaults (default-on), never throws', () => {
    // CodeQL: use mkdtempSync for atomic, unpredictable temp dir creation.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pri-510-malformed-'));
    tmpWorkspaces.push(tmpDir);
    const pdDir = path.join(tmpDir, '.pd');
    fs.mkdirSync(pdDir, { recursive: true });
    fs.writeFileSync(path.join(pdDir, 'config.yaml'), 'this: is: not: valid: yaml: [', 'utf-8');

    const { stateManager } = createMockStateManager();

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir: tmpDir,
    });

    // Malformed config must NOT throw — falls back to registry defaults
    // (P0-D: evaluator_artificer_repair_loop default-on since core-loop closure).
    expect(typeof deps.isRepairLoopEnabled).toBe('function');
    if (typeof deps.isRepairLoopEnabled !== 'function') throw new Error('isRepairLoopEnabled missing');
    expect(deps.isRepairLoopEnabled()).toBe(true);
  });

  it('seedArtificerRepairTask → creates artificer task with repairPayload in diagnosticJson (rc-1, rc-6)', async () => {
    const workspaceDir = createTempWorkspace(true);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager, createdTasks } = createMockStateManager();
    const params = makeValidSeedParams();

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir,
    });

    expect(deps.seedArtificerRepairTask).toBeDefined();
    expect(typeof deps.seedArtificerRepairTask).toBe('function');
    if (typeof deps.seedArtificerRepairTask !== 'function') throw new Error('seedArtificerRepairTask missing');
    // PRI-1293 Phase 3: 来源 evaluator 必须真实存在且链可回溯根 dreamer —
    // seeder 的血缘收口按设计拒绝不可证明的来源。
    await stateManager.createTask({
      taskId: 'dreamer-r0-src', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }, candidateId: 'cand-r0' }),
    });
    await stateManager.createTask({
      taskId: 'evaluator-r0', taskKind: 'evaluator', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [], correlationId: 'cand-r0', parentTaskId: 'dreamer-r0-src' } }),
    });
    const repairTaskId = await deps.seedArtificerRepairTask(params);

    // Returns a non-empty task ID
    expect(typeof repairTaskId).toBe('string');
    expect(repairTaskId.length).toBeGreaterThan(0);

    // Exactly one ARTIFICER task created (the two lineage fixtures above are
    // the dreamer root and the source evaluator).
    const createdArtificers = createdTasks.filter((t) => t.taskKind === 'artificer');
    expect(createdArtificers).toHaveLength(1);
    const [task] = createdArtificers;
    if (!task) throw new Error('task not created');

    // PRI-1293 Phase 3: repair 任务血缘 — parentTaskId=来源 evaluator, id 经
    // 权威解析恢复。
    const createdPi = JSON.parse(task.diagnosticJson ?? '{}') as { pi_metadata?: Record<string, unknown> };
    expect(createdPi.pi_metadata?.parentTaskId).toBe('evaluator-r0');
    expect(createdPi.pi_metadata?.correlationId).toBe('cand-r0');

    // D1 (PRI-509): task kind is 'artificer' (reuses artificer-runner, not a
    // new runner type)
    expect(task.taskKind).toBe('artificer');

    // Task starts pending so the orchestrator can pick it up
    expect(task.status).toBe('pending');

    // Task ID matches what the seeder returns
    expect(task.taskId).toBe(repairTaskId);

    // diagnosticJson must contain the repairPayload — round-trip via the
    // parser to verify the validated shape (rc-1: treat parsed JSON as
    // unknown; rc-2: no `as` bypass; rc-6: lineage fields consistent).
    expect(task.diagnosticJson).toBeDefined();
    expect(typeof task.diagnosticJson).toBe('string');
    if (typeof task.diagnosticJson !== 'string') throw new Error('diagnosticJson not a string');
    const parsed = JSON.parse(task.diagnosticJson);
    const meta = parsed.pi_metadata;
    expect(meta).toBeDefined();
    expect(meta.repairPayload).toEqual(params.repairPayload);

    // Inherited lineage must be preserved (PRI-508 context + PRI-509 deps)
    expect(meta.dependencyTaskIds).toEqual(params.inheritedDependencyTaskIds);
    expect(meta.channel).toBe(params.inheritedChannel);
    expect(meta.timeoutMs).toBe(params.inheritedTimeoutMs);
    expect(meta.inputArtifactRefs).toEqual(params.inheritedInputArtifactRefs);
    expect(meta.ownerEvidenceSelection).toEqual(params.ownerEvidenceSelection);
  });

  it('seedArtificerRepairTask → deterministic id + replay reuse (P0-4); 不同 iteration 不同 id (rc-7)', async () => {
    const workspaceDir = createTempWorkspace(true);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager } = createMockStateManager();
    const params = makeValidSeedParams();
    // PRI-1293 Phase 3: 可证明来源链 (同上)。
    await stateManager.createTask({
      taskId: 'dreamer-r0-src', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }, candidateId: 'cand-r0' }),
    });
    await stateManager.createTask({
      taskId: 'evaluator-r0', taskKind: 'evaluator', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [], correlationId: 'cand-r0', parentTaskId: 'dreamer-r0-src' } }),
    });

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir,
    });

    if (typeof deps.seedArtificerRepairTask !== 'function') throw new Error('seedArtificerRepairTask missing');
    const id1 = await deps.seedArtificerRepairTask(params);
    // P0-4: 同一 evaluator+iteration 的重放 (consumer 重复周期 / crash 恢复)
    // reuse 同一确定性 id,不重复创建
    expect(id1).toBe(`artificer-repair-${params.repairPayload.sourceEvaluatorTaskId}-r${params.repairPayload.repairIteration}`);
    const id2 = await deps.seedArtificerRepairTask(params);
    expect(id2).toBe(id1);
    // 不同 iteration (下一逻辑修复轮) → 不同 id
    const id3 = await deps.seedArtificerRepairTask({
      ...params,
      repairPayload: { ...params.repairPayload, repairIteration: params.repairPayload.repairIteration + 1 },
    });
    expect(id3).not.toBe(id1);
  });

  it('seedArtificerRepairTask → terminal (succeeded/failed/NHR) round refuses reuse (PRI-718 revise ≠ resume)', async () => {
    const workspaceDir = createTempWorkspace(true);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager, createdTasks } = createMockStateManager();
    const params = makeValidSeedParams();

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir,
    });
    if (typeof deps.seedArtificerRepairTask !== 'function') throw new Error('seedArtificerRepairTask missing');

    // Stage a pre-existing TERMINAL repair round under the deterministic id
    // (EP002-R2: the seed found the finished r2 and "reused" it, so the
    // evaluator re-evaluated the same artifact forever).
    const repairTaskId = `artificer-repair-${params.repairPayload.sourceEvaluatorTaskId}-r${params.repairPayload.repairIteration}`;
    const now = new Date().toISOString();
    const base = { taskId: repairTaskId, taskKind: 'artificer', attemptCount: 1, maxAttempts: 3, createdAt: now, updatedAt: now, diagnosticJson: '{}' };
    for (const terminalStatus of ['succeeded', 'failed', 'needs_human_review'] as const) {
      createdTasks.length = 0;
      createdTasks.push({ ...base, status: terminalStatus });
      await expect(deps.seedArtificerRepairTask(params)).rejects.toThrow(new RegExp(`terminal status ${terminalStatus}`));
    }
  });

  it('PRI-1293 review: 旧版无亲缘 repair task 复用前 CAS 补齐 parentTaskId + correlationId; 来源不可证明则拒绝', async () => {
    const workspaceDir = createTempWorkspace(true);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager, createdTasks } = createMockStateManager();
    const params = makeValidSeedParams();

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: {} as never,
      eventEmitter: {} as never,
      validator: {} as never,
      artifactStore: {} as never,
      workspaceDir,
    });
    if (typeof deps.seedArtificerRepairTask !== 'function') throw new Error('seedArtificerRepairTask missing');

    // 可证明来源链: dreamer(seed cand-r0) ← evaluator-r0。
    await stateManager.createTask({
      taskId: 'dreamer-r0-src', taskKind: 'dreamer', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] }, candidateId: 'cand-r0' }),
    });
    await stateManager.createTask({
      taskId: 'evaluator-r0', taskKind: 'evaluator', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [], correlationId: 'cand-r0', parentTaskId: 'dreamer-r0-src' } }),
    });

    // 升级前创建的旧 repair task: 确定性 id 相同, 但无 parentTaskId /
    // correlationId。复用不得绕过血缘门禁 — 按权威来源 CAS 补齐, 不重建。
    const repairTaskId = `artificer-repair-${params.repairPayload.sourceEvaluatorTaskId}-r${params.repairPayload.repairIteration}`;
    const legacyJson = JSON.stringify({ pi_metadata: { dependencyTaskIds: ['scribe-task-001'], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [], repairPayload: params.repairPayload } });
    await stateManager.createTask({
      taskId: repairTaskId, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: legacyJson,
    });
    const countBefore = createdTasks.length;
    const reused = await deps.seedArtificerRepairTask(params);
    expect(reused).toBe(repairTaskId);
    expect(createdTasks.length).toBe(countBefore); // 复用不新建
    const after = createdTasks.find((t) => t.taskId === repairTaskId);
    const afterMeta = JSON.parse(after?.diagnosticJson ?? '{}') as { pi_metadata?: Record<string, unknown> };
    expect(afterMeta.pi_metadata?.parentTaskId).toBe('evaluator-r0');
    expect(afterMeta.pi_metadata?.correlationId).toBe('cand-r0');
    // 既有字段保持 (merge 而非重建)。
    expect(afterMeta.pi_metadata?.repairPayload).toEqual(params.repairPayload);

    // 反向: 来源链不可证明时, 旧 repair task 的复用同样被拒绝且零写入。
    createdTasks.length = 0;
    await stateManager.createTask({
      taskId: 'evaluator-orphan-cli', taskKind: 'evaluator', status: 'succeeded', attemptCount: 1, maxAttempts: 3,
      diagnosticJson: JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] } }),
    });
    const orphanRepairId = 'artificer-repair-evaluator-orphan-cli-r1';
    const orphanJson = JSON.stringify({ pi_metadata: { dependencyTaskIds: [], channel: 'prompt', timeoutMs: 300_000, inputArtifactRefs: [], outputArtifactRefs: [] } });
    await stateManager.createTask({
      taskId: orphanRepairId, taskKind: 'artificer', status: 'pending', attemptCount: 0, maxAttempts: 3,
      diagnosticJson: orphanJson,
    });
    const orphanParams = {
      ...params,
      repairPayload: { ...params.repairPayload, sourceEvaluatorTaskId: 'evaluator-orphan-cli' },
    };
    await expect(deps.seedArtificerRepairTask(orphanParams)).rejects.toThrow(/evaluator_repair_seed_lineage_refused/);
    expect(createdTasks.find((t) => t.taskId === orphanRepairId)?.diagnosticJson).toBe(orphanJson);
  });

  it('deps spread contains all required base PeerRunnerDeps fields (EP-02: real path gets full deps)', () => {
    const workspaceDir = createTempWorkspace(true);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager } = createMockStateManager();
    const fakeRuntimeAdapter = { kind: () => 'pi-ai' } as never;
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    const fakeEventEmitter = { emit: () => {} } as never;
    const fakeValidator = { validate: () => ({ ok: true, value: {} }) } as never;
    const fakeArtifactStore = { get: () => null } as never;

    const deps = createEvaluatorRunnerDeps({
      stateManager,
      runtimeAdapter: fakeRuntimeAdapter,
      eventEmitter: fakeEventEmitter,
      validator: fakeValidator,
      artifactStore: fakeArtifactStore,
      workspaceDir,
    });

    // Base PeerRunnerDeps preserved
    expect(deps.stateManager).toBe(stateManager);
    expect(deps.runtimeAdapter).toBe(fakeRuntimeAdapter);
    expect(deps.eventEmitter).toBe(fakeEventEmitter);
    expect(deps.validator).toBe(fakeValidator);
    expect(deps.artifactStore).toBe(fakeArtifactStore);

    // Repair-loop deps present
    expect(deps.isRepairLoopEnabled).toBeTypeOf('function');
    expect(deps.seedArtificerRepairTask).toBeTypeOf('function');
  });
});
