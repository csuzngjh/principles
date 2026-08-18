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
import type { SeedArtificerRepairParams } from '@principles/core/runtime-v2';
import type { RuntimeStateManager, TaskRecord } from '@principles/core/runtime-v2';

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
    createTask: vi.fn(async (record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>) => {
      const now = new Date().toISOString();
      const task: TaskRecord = { ...record, createdAt: now, updatedAt: now };
      createdTasks.push(task);
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
    const repairTaskId = await deps.seedArtificerRepairTask(params);

    // Returns a non-empty task ID
    expect(typeof repairTaskId).toBe('string');
    expect(repairTaskId.length).toBeGreaterThan(0);

    // Exactly one task created
    expect(createdTasks).toHaveLength(1);
    const [task] = createdTasks;
    if (!task) throw new Error('task not created');

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
  });

  it('seedArtificerRepairTask → each call returns a UNIQUE task ID (rc-7: no stale state)', async () => {
    const workspaceDir = createTempWorkspace(true);
    tmpWorkspaces.push(workspaceDir);
    const { stateManager } = createMockStateManager();
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
    const id1 = await deps.seedArtificerRepairTask(params);
    const id2 = await deps.seedArtificerRepairTask(params);

    expect(id1).not.toBe(id2);
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
