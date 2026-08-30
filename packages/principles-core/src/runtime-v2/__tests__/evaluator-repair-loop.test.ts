/**
 * PRI-509: Evaluator→Artificer Repair Loop — TDD tests (Slice 4 + 5).
 *
 * RED phase: tests define the expected contract for:
 *   - Slice 4: evaluator decision='needs_revision' + flag enabled → seed artificer
 *     repair task with repairPayload (repairIteration = priorRound + 1).
 *   - Slice 5: prior repairIteration >= 2 + flag enabled → mark evaluator task
 *     needs_human_review (fail loud, EP-03) + emit observable event (rc-9).
 *
 * Trust boundary (rc-1, rc-2): evaluator output is untrusted LLM output.
 * requiredChanges / concerns are validated as unknown → string[] before being
 * placed into repairPayload (no `as` casts that bypass validation).
 *
 * Loop state freshness (rc-7, EP-05, ERR-015/018/019): repairIteration is read
 * from the dependency artificer task's repairPayload (written at task creation
 * time, never inferred at read). Each evaluator round reads the CURRENT
 * artificer's repairPayload — never a cached value.
 *
 * Fail loud (rc-3, rc-9, EP-03, ERR-002): when priorRepairIteration >= 2, the
 * evaluator task is marked needs_human_review with a structured reason +
 * nextAction event. No silent fallback.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EvaluatorRunner } from '../internalization/evaluator-runner.js';
import type { EvaluatorRunnerDeps, SeedArtificerRepairParams } from '../internalization/evaluator-runner.js';
import type { PIArtifactStore, PIArtifactRecord } from '../internalization/pi-artifact.js';
import { MemoryPIArtifactStore } from '../internalization/pi-artifact-store.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PDRuntimeAdapter, RunHandle, RunStatus } from '../runtime-protocol.js';
import type { StoreEventEmitter } from '../store/event-emitter.js';
import type { EvaluatorOutputV1 } from '../internalization/evaluator-output.js';
import { DefaultEvaluatorValidator } from '../internalization/evaluator-output.js';
import {
  createPITaskDiagnosticJson,
} from '../internalization/pitask-metadata.js';
import type { RepairPayload } from '../internalization/pitask-metadata.js';
import type { TaskRecord } from '../task-status.js';

const ARTIFICER_TASK_ID = 'artificer-001';
const ARTIFICER_REPAIR_TASK_ID_PREFIX = 'artificer-repair-';
const SCRIBE_TASK_ID = 'scribe-001';
const EVALUATOR_TASK_ID = 'evaluator-001';
const ARTIFICER_ARTIFACT_ID = 'pi-art-artificer-001-run-001';
const SCRIBE_ARTIFACT_ID = 'pi-art-scribe-001';

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeScribeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: SCRIBE_TASK_ID,
    taskKind: 'scribe',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'scribe://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [],
      outputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ARTIFACT_ID }],
    }),
    ...overrides,
  };
}

function makeArtificerTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: ARTIFICER_TASK_ID,
    taskKind: 'artificer',
    status: 'succeeded',
    attemptCount: 1,
    maxAttempts: 3,
    resultRef: 'artificer://run-001',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [SCRIBE_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ARTIFACT_ID }],
      outputArtifactRefs: [{ artifactType: 'principle', ref: ARTIFICER_ARTIFACT_ID }],
    }),
    ...overrides,
  };
}

function makeArtificerTaskWithRepairPayload(repairIteration: number): TaskRecord {
  const repairPayload: RepairPayload = {
    requiredChanges: ['previous required change'],
    concerns: ['previous concern'],
    previousScore: 0.55,
    repairIteration,
    sourceArtificerArtifactId: 'pi-art-artificer-previous',
    sourceEvaluatorTaskId: 'evaluator-previous',
  };
  return makeArtificerTask({
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [SCRIBE_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: SCRIBE_ARTIFACT_ID }],
      outputArtifactRefs: [{ artifactType: 'principle', ref: ARTIFICER_ARTIFACT_ID }],
      repairPayload,
    }),
  });
}

function makeEvaluatorTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: EVALUATOR_TASK_ID,
    taskKind: 'evaluator',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    diagnosticJson: createPITaskDiagnosticJson({
      dependencyTaskIds: [ARTIFICER_TASK_ID],
      channel: 'prompt',
      timeoutMs: 300_000,
      inputArtifactRefs: [{ artifactType: 'principle', ref: ARTIFICER_ARTIFACT_ID }],
      outputArtifactRefs: [],
    }),
    ...overrides,
  };
}

function makeScribeArtifact(): PIArtifactRecord {
  return {
    artifactId: SCRIBE_ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: SCRIBE_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      principleDraft: {
        title: 'Always validate async input',
        statement: 'Every async function must validate its input before processing.',
      },
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeArtificerArtifact(): PIArtifactRecord {
  return {
    artifactId: ARTIFICER_ARTIFACT_ID,
    artifactKind: 'principle',
    sourceTaskId: ARTIFICER_TASK_ID,
    lineageArtifactIds: [],
    validationStatus: 'pending',
    contentJson: JSON.stringify({
      taskId: ARTIFICER_TASK_ID,
      sourceScribeArtifactId: SCRIBE_ARTIFACT_ID,
      implementationPlan: {
        summary: 'Add input validation to all async operations',
        targetSurface: 'src/async-ops/*.ts',
        changes: ['Add try-catch to asyncOp1', 'Add error boundary to asyncOp2'],
        tests: ['Unit test for asyncOp1 error handling'],
        rolloutNotes: ['Deploy behind feature flag'],
        confidence: 0.85,
      },
      sourceTrace: {
        scribeArtifactId: SCRIBE_ARTIFACT_ID,
      },
      risks: ['May add latency'],
      generatedAt: new Date().toISOString(),
    }),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeNeedsRevisionOutput(overrides: Partial<EvaluatorOutputV1> = {}): EvaluatorOutputV1 {
  return {
    taskId: EVALUATOR_TASK_ID,
    sourceArtificerArtifactId: ARTIFICER_ARTIFACT_ID,
    evaluation: {
      decision: 'needs_revision',
      summary: 'Implementation has gaps in error handling coverage',
      score: 0.65,
      strengths: ['Clear structure'],
      concerns: ['Missing timeout handling', 'No retry logic for transient failures'],
      requiredChanges: [
        'Add explicit timeout handling to asyncOp1',
        'Implement retry with exponential backoff for transient failures',
      ],
    },
    sourceTrace: {
      artificerArtifactId: ARTIFICER_ARTIFACT_ID,
      scribeArtifactId: SCRIBE_ARTIFACT_ID,
    },
    risks: ['May need additional integration tests'],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeApprovedOutput(): EvaluatorOutputV1 {
  return {
    taskId: EVALUATOR_TASK_ID,
    sourceArtificerArtifactId: ARTIFICER_ARTIFACT_ID,
    evaluation: {
      decision: 'approved',
      summary: 'Implementation is well-structured and feasible',
      score: 0.85,
      strengths: ['Clear change descriptions', 'Good test coverage plan'],
      concerns: [],
      requiredChanges: [],
    },
    sourceTrace: {
      artificerArtifactId: ARTIFICER_ARTIFACT_ID,
      scribeArtifactId: SCRIBE_ARTIFACT_ID,
    },
    risks: [],
    generatedAt: new Date().toISOString(),
  };
}

// ── Mock deps factory ────────────────────────────────────────────────────────

function createMockDeps(overrides: {
  artificerTask?: TaskRecord;
  evaluatorOutput?: EvaluatorOutputV1;
  isRepairLoopEnabled?: () => boolean;
  seedArtificerRepairTask?: (params: SeedArtificerRepairParams) => Promise<string>;
  /**
   * When true AND isRepairLoopEnabled is provided, the deps will NOT inject
   * seedArtificerRepairTask — used to test the "seeder missing" fail-loud path.
   */
  omitSeeder?: boolean;
  artifactStore?: PIArtifactStore;
}): {
  deps: EvaluatorRunnerDeps;
  stateManager: RuntimeStateManager;
  artifactStore: PIArtifactStore;
  seedArtificerRepairTask: ReturnType<typeof vi.fn> | null;
} {
  const artifactStore = overrides.artifactStore ?? new MemoryPIArtifactStore();
  const evaluatorTask = makeEvaluatorTask();
  const artificerTask = overrides.artificerTask ?? makeArtificerTask();
  const scribeTask = makeScribeTask();

  const stateManager = {
    acquireLease: vi.fn().mockResolvedValue(evaluatorTask),
    getTask: vi.fn().mockImplementation((id: string) => {
      if (id === EVALUATOR_TASK_ID) return Promise.resolve(evaluatorTask);
      if (id === ARTIFICER_TASK_ID) return Promise.resolve(artificerTask);
      if (id === SCRIBE_TASK_ID) return Promise.resolve(scribeTask);
      return Promise.resolve(null);
    }),
    getRunsByTask: vi.fn().mockResolvedValue([{
      runId: 'run-evaluator-001',
      taskId: EVALUATOR_TASK_ID,
      runtimeKind: 'evaluator',
      startedAt: new Date().toISOString(),
    }]),
    getValidRunsByTaskTolerant: vi.fn().mockResolvedValue({
      runs: [{ runId: 'run-evaluator-001', taskId: EVALUATOR_TASK_ID, runtimeKind: 'evaluator', startedAt: new Date().toISOString() }],
      degradedRuns: [],
    }),
    updateRunOutput: vi.fn().mockResolvedValue(undefined),
    markTaskSucceeded: vi.fn().mockResolvedValue(undefined),
      updateTaskDiagnosticJson: vi.fn().mockResolvedValue(undefined), // P0-3: runner verdict 前置写入
    markTaskFailed: vi.fn().mockResolvedValue(undefined),
    markTaskRetryWait: vi.fn().mockResolvedValue(undefined),
    updateTask: vi.fn().mockImplementation(async (taskId: string, patch: Record<string, unknown>) => {
      // 忠实 store 语义: updateTask 成功 ⇒ 后续 getTask 读回新状态
      // (markNeedsHumanReviewOrThrow 的 read-back invariant 依赖)
      if (taskId === EVALUATOR_TASK_ID && typeof patch.status === 'string') {
        (evaluatorTask as Record<string, unknown>).status = patch.status;
      }
      return {
        ...evaluatorTask,
        taskId,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
    }),
    createTask: vi.fn().mockImplementation(async (record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>) => ({
      ...record,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    getRetryPolicy: vi.fn().mockReturnValue({ shouldRetry: () => false }),
  } as unknown as RuntimeStateManager;

  const runHandle: RunHandle = { runId: 'run-evaluator-001', runtimeKind: 'test-double', startedAt: new Date().toISOString() };
  const succeededStatus: RunStatus = { status: 'succeeded', runId: 'run-evaluator-001' };

  const runtimeAdapter = {
    startRun: vi.fn().mockResolvedValue(runHandle),
    pollRun: vi.fn().mockResolvedValue(succeededStatus),
    fetchOutput: vi.fn().mockResolvedValue({
      payload: overrides.evaluatorOutput ?? makeNeedsRevisionOutput(),
    }),
    cancelRun: vi.fn().mockResolvedValue(undefined),
  } as unknown as PDRuntimeAdapter;

  const eventEmitter = {
    emitTelemetry: vi.fn(),
  } as unknown as StoreEventEmitter;

  const validator = new DefaultEvaluatorValidator();

  // PRI-509: default seeder mock used when isRepairLoopEnabled is enabled.
  // The test asserts against this mock's calls instead of stateManager.createTask
  // because core peer runners delegate task creation to the plugin layer
  // (architecture-regression.test.ts forbids 'createTask' string in evaluator-runner.ts).
  const defaultSeedArtificerRepairTask = vi.fn().mockImplementation(async (params: SeedArtificerRepairParams) => {
    return `${ARTIFICER_REPAIR_TASK_ID_PREFIX}${params.repairPayload.repairIteration}-${Date.now()}`;
  });

  // Wrap any override in vi.fn() so the returned type is consistently Mock
  // (a plain function vs vi.fn() Mock would otherwise produce an unassignable union).
  const seederMock = overrides.seedArtificerRepairTask
    ? vi.fn(overrides.seedArtificerRepairTask)
    : defaultSeedArtificerRepairTask;

  // When omitSeeder is true, do NOT inject seedArtificerRepairTask even if
  // isRepairLoopEnabled is provided — simulates a plugin-layer wiring bug
  // where the flag is on but the seeder was never injected.
  const shouldInjectSeeder = overrides.isRepairLoopEnabled !== undefined
    && overrides.omitSeeder !== true;

  const deps: EvaluatorRunnerDeps = {
    stateManager,
    runtimeAdapter,
    eventEmitter,
    validator,
    artifactStore,
    ...(overrides.isRepairLoopEnabled !== undefined
      ? { isRepairLoopEnabled: overrides.isRepairLoopEnabled }
      : {}),
    ...(shouldInjectSeeder
      ? { seedArtificerRepairTask: seederMock }
      : {}),
  };

  return {
    deps,
    stateManager,
    artifactStore,
    seedArtificerRepairTask: shouldInjectSeeder
      ? seederMock
      : null,
  };
}

async function seedArtifacts(store: PIArtifactStore): Promise<void> {
  await store.upsertArtifact(makeScribeArtifact());
  await store.upsertArtifact(makeArtificerArtifact());
}


/** PRI-629: NHR 写入携带 humanReviewContext (status+context 原子同写) — 谓词断言。 */
function expectNhrWriteWithReason(stateManager: unknown, expectedReason: string): void {
  const calls = (stateManager as { updateTask: { mock: { calls: unknown[][] } } }).updateTask.mock.calls as [string, Record<string, unknown>][];
  const hit = calls.some(([id, patch]) => {
    if (id !== EVALUATOR_TASK_ID || patch?.status !== 'needs_human_review' || typeof patch.diagnosticJson !== 'string') return false;
    try {
      const parsed = JSON.parse(patch.diagnosticJson) as { pi_metadata?: { humanReviewContext?: { reasonCode?: string } } };
      return parsed.pi_metadata?.humanReviewContext?.reasonCode === expectedReason;
    } catch {
      return false;
    }
  });
  if (!hit) throw new Error(`expected needs_human_review write with reasonCode=${expectedReason}`);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PRI-509: Evaluator→Artificer Repair Loop (Slice 4 + 5)', () => {
  beforeEach(() => {
    // Reset vi mocks between tests (defensive — createMockDeps returns fresh mocks each call)
    vi.clearAllMocks();
  });

  // ── Slice 4: seed artificer repair task on needs_revision ───────────────────

  describe('Slice 4: needs_revision → seed artificer repair task', () => {
    it('flag enabled + no prior repairPayload → seeder called with repairIteration=1', async () => {
      const store = new MemoryPIArtifactStore();
      await seedArtifacts(store);
      const { deps, stateManager, seedArtificerRepairTask } = createMockDeps({
        artifactStore: store,
        isRepairLoopEnabled: () => true,
        artificerTask: makeArtificerTask(), // no repairPayload → priorRepairIteration = 0
        evaluatorOutput: makeNeedsRevisionOutput(),
      });

      const runner = new EvaluatorRunner(deps, {
        owner: 'test',
        runtimeKind: 'evaluator',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });

      const result = await runner.run(EVALUATOR_TASK_ID);
      expect(result.status).toBe('succeeded');

      // Core peer runner delegates to the injected seeder instead of calling
      // stateManager task-creation directly (architecture boundary enforced
      // by architecture-regression.test.ts).
      expect(seedArtificerRepairTask).not.toBeNull();
      expect(seedArtificerRepairTask).toHaveBeenCalledTimes(1);
      // Guard before property access (lint: no-non-null-assertion).
      if (!seedArtificerRepairTask) throw new Error('seeder unexpectedly null');
      const seedCall = seedArtificerRepairTask.mock.calls[0]?.[0] as SeedArtificerRepairParams | undefined;
      expect(seedCall).toBeDefined();
      // After toBeDefined assertion, narrow the type explicitly (TS doesn't narrow via expect).
      if (!seedCall) throw new Error('seedCall unexpectedly undefined');

      // repairPayload has the 6 required fields with repairIteration=1
      const {repairPayload} = seedCall;
      expect(repairPayload.repairIteration).toBe(1);
      expect(repairPayload.requiredChanges).toEqual([
        'Add explicit timeout handling to asyncOp1',
        'Implement retry with exponential backoff for transient failures',
      ]);
      expect(repairPayload.concerns).toEqual([
        'Missing timeout handling',
        'No retry logic for transient failures',
      ]);
      expect(repairPayload.previousScore).toBe(0.65);
      expect(repairPayload.sourceArtificerArtifactId).toBe(ARTIFICER_ARTIFACT_ID);
      expect(repairPayload.sourceEvaluatorTaskId).toBe(EVALUATOR_TASK_ID);

      // inheritedDependencyTaskIds come from the original artificer task (→ scribe)
      expect(seedCall?.inheritedDependencyTaskIds).toEqual([SCRIBE_TASK_ID]);

      // State manager was NOT called directly for task creation (boundary preserved)
      expect(stateManager.createTask).not.toHaveBeenCalled();
    });

    it('flag disabled → seeder NOT called (backward compat)', async () => {
      const store = new MemoryPIArtifactStore();
      await seedArtifacts(store);
      const { deps, stateManager, seedArtificerRepairTask } = createMockDeps({
        artifactStore: store,
        // isRepairLoopEnabled omitted = disabled (backward compat)
        artificerTask: makeArtificerTask(),
        evaluatorOutput: makeNeedsRevisionOutput(),
      });

      const runner = new EvaluatorRunner(deps, {
        owner: 'test',
        runtimeKind: 'evaluator',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });

      const result = await runner.run(EVALUATOR_TASK_ID);
      expect(result.status).toBe('succeeded');

      // No repair task seeded — backward compatible behavior
      expect(seedArtificerRepairTask).toBeNull();
      expect(stateManager.createTask).not.toHaveBeenCalled();
    });

    it('flag enabled + decision=approved → seeder NOT called', async () => {
      const store = new MemoryPIArtifactStore();
      await seedArtifacts(store);
      const { deps, stateManager, seedArtificerRepairTask } = createMockDeps({
        artifactStore: store,
        isRepairLoopEnabled: () => true,
        artificerTask: makeArtificerTask(),
        evaluatorOutput: makeApprovedOutput(),
      });

      const runner = new EvaluatorRunner(deps, {
        owner: 'test',
        runtimeKind: 'evaluator',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });

      const result = await runner.run(EVALUATOR_TASK_ID);
      expect(result.status).toBe('succeeded');

      // approved never triggers repair seeding
      expect(seedArtificerRepairTask).not.toBeNull();
      expect(seedArtificerRepairTask).not.toHaveBeenCalled();
      expect(stateManager.createTask).not.toHaveBeenCalled();
    });
  });

  // ── Slice 5: max iterations → needs_human_review (fail loud) ───────────────

  describe('Slice 5: priorRepairIteration >= 2 → needs_human_review', () => {
    it('flag enabled + prior repairIteration=2 → mark needs_human_review + no seed', async () => {
      const store = new MemoryPIArtifactStore();
      await seedArtifacts(store);
      const { deps, stateManager, seedArtificerRepairTask } = createMockDeps({
        artifactStore: store,
        isRepairLoopEnabled: () => true,
        artificerTask: makeArtificerTaskWithRepairPayload(2), // prior round = 2 → max reached
        evaluatorOutput: makeNeedsRevisionOutput(),
      });

      const runner = new EvaluatorRunner(deps, {
        owner: 'test',
        runtimeKind: 'evaluator',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });

      const result = await runner.run(EVALUATOR_TASK_ID);

      // Runner returns succeeded (it produced a valid verdict) but the task
      // itself is marked needs_human_review.
      expect(result.status).toBe('succeeded');

      // No 3rd repair task seeded — fail loud, not infinite loop
      expect(seedArtificerRepairTask).not.toBeNull();
      expect(seedArtificerRepairTask).not.toHaveBeenCalled();
      expect(stateManager.createTask).not.toHaveBeenCalled();

      // Task marked needs_human_review (fail loud, EP-03, ERR-002)
      expect(stateManager.updateTask).toHaveBeenCalledWith(
        EVALUATOR_TASK_ID,
        expect.objectContaining({
          status: 'needs_human_review',
        }),
      );
      // PRI-629 (SPEC §4): status 与 humanReviewContext 同一次 task-row mutation,
      // reasonCode 为拆分后的 budget-exhausted (decision-capable)。
      expectNhrWriteWithReason(stateManager, 'evaluator_repair_budget_exhausted');

      // Observable event emitted (rc-9 — no silent fallback).
      // Convention: emitEvent prefixes with runnerName → 'evaluator_repair_loop_max_iterations'.
      const eventEmitter = deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> };
      const telemetryCalls = eventEmitter.emitTelemetry.mock.calls;
      const maxIterationsCall = telemetryCalls.find(
        (call: readonly unknown[]) => typeof call[0] === 'object' && call[0] !== null
          && (call[0] as Record<string, unknown>).eventType === 'evaluator_repair_loop_max_iterations',
      );
      expect(maxIterationsCall).toBeDefined();
      const eventPayload = (maxIterationsCall?.[0] as Record<string, unknown>)?.payload as Record<string, unknown> | undefined;
      expect(eventPayload?.reason).toBe('max_repair_iterations_exceeded');
      expect(eventPayload?.nextAction).toBe('owner_manual_review_required');
      expect(eventPayload?.priorRepairIteration).toBe(2);
    });

    it('flag enabled + prior repairIteration=1 → seed repair task with repairIteration=2', async () => {
      const store = new MemoryPIArtifactStore();
      await seedArtifacts(store);
      const { deps, stateManager, seedArtificerRepairTask } = createMockDeps({
        artifactStore: store,
        isRepairLoopEnabled: () => true,
        artificerTask: makeArtificerTaskWithRepairPayload(1), // prior round = 1 → seed Round 2
        evaluatorOutput: makeNeedsRevisionOutput(),
      });

      const runner = new EvaluatorRunner(deps, {
        owner: 'test',
        runtimeKind: 'evaluator',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });

      const result = await runner.run(EVALUATOR_TASK_ID);
      expect(result.status).toBe('succeeded');

      // Round 2 repair task seeded (NOT fail loud — only 1 prior round)
      expect(seedArtificerRepairTask).not.toBeNull();
      expect(seedArtificerRepairTask).toHaveBeenCalledTimes(1);
      // Guard before property access (lint: no-non-null-assertion).
      if (!seedArtificerRepairTask) throw new Error('seeder unexpectedly null');
      const seedCall = seedArtificerRepairTask.mock.calls[0]?.[0] as SeedArtificerRepairParams | undefined;
      expect(seedCall?.repairPayload.repairIteration).toBe(2);

      // Task NOT marked needs_human_review (only 1 prior round)
      expect(stateManager.updateTask).not.toHaveBeenCalledWith(
        EVALUATOR_TASK_ID,
        expect.objectContaining({ status: 'needs_human_review' }),
      );
    });
  });

  // ── Regression: all max_iterations_reached paths must mark needs_human_review ──
  //
  // P1 bug fix: previously only the `priorRepairIteration >= 2` path called
  // stateManager.updateTask; the other 3 paths (lineage missing, seeder missing,
  // seeder throws) returned max_iterations_reached WITHOUT updating task state,
  // leaving the task in 'leased' state → lease expiry → infinite re-evaluation.
  //
  // The fix unifies the updateTask call in the caller for ALL max_iterations_reached
  // returns. These tests verify the 2 reachable degraded paths.
  //
  // Note: the lineage-missing path (sourceArtificerArtifactId unresolved) is
  // defensively unreachable through normal flow — the validator requires
  // sourceArtificerArtifactId to be a non-empty string, so output rejected by
  // validation never reaches maybeSeedArtificerRepair. The defensive check
  // remains in place for defense-in-depth.

  describe('Regression: max_iterations_reached paths mark needs_human_review (P1 fix)', () => {
    it('seeder not injected despite flag enabled → mark needs_human_review', async () => {
      const store = new MemoryPIArtifactStore();
      await seedArtifacts(store);
      const { deps, stateManager, seedArtificerRepairTask } = createMockDeps({
        artifactStore: store,
        isRepairLoopEnabled: () => true,
        omitSeeder: true, // simulate plugin-layer wiring bug: flag on, seeder missing
        artificerTask: makeArtificerTask(), // priorRepairIteration = 0 (no payload)
        evaluatorOutput: makeNeedsRevisionOutput(),
      });

      const runner = new EvaluatorRunner(deps, {
        owner: 'test',
        runtimeKind: 'evaluator',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });

      const result = await runner.run(EVALUATOR_TASK_ID);
      expect(result.status).toBe('succeeded');

      // No seeder was injected → no seeding happened
      expect(seedArtificerRepairTask).toBeNull();

      // P1 fix: task must be marked needs_human_review (not left in 'leased')
      expect(stateManager.updateTask).toHaveBeenCalledWith(
        EVALUATOR_TASK_ID,
        expect.objectContaining({ status: 'needs_human_review' }),
      );

      // Observable event emitted (rc-9 — no silent fallback)
      const eventEmitter = deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> };
      const telemetryCalls = eventEmitter.emitTelemetry.mock.calls;
      const seederMissingCall = telemetryCalls.find(
        (call: readonly unknown[]) => typeof call[0] === 'object' && call[0] !== null
          && (call[0] as Record<string, unknown>).eventType === 'evaluator_repair_loop_seeder_missing',
      );
      expect(seederMissingCall).toBeDefined();

      // task_needs_human_review event also emitted (caller's fail-loud signal)
      const reviewCall = telemetryCalls.find(
        (call: readonly unknown[]) => typeof call[0] === 'object' && call[0] !== null
          && (call[0] as Record<string, unknown>).eventType === 'evaluator_task_needs_human_review',
      );
      expect(reviewCall).toBeDefined();
    });

    it('seeder throws → mark needs_human_review (no silent swallow)', async () => {
      const store = new MemoryPIArtifactStore();
      await seedArtifacts(store);
      const { deps, stateManager, seedArtificerRepairTask } = createMockDeps({
        artifactStore: store,
        isRepairLoopEnabled: () => true,
        seedArtificerRepairTask: async () => {
          throw new Error('plugin-layer seed failed: store unavailable');
        },
        artificerTask: makeArtificerTask(), // priorRepairIteration = 0 (no payload)
        evaluatorOutput: makeNeedsRevisionOutput(),
      });

      const runner = new EvaluatorRunner(deps, {
        owner: 'test',
        runtimeKind: 'evaluator',
        pollIntervalMs: 10,
        timeoutMs: 1000,
      });

      const result = await runner.run(EVALUATOR_TASK_ID);
      expect(result.status).toBe('succeeded');

      // Seeder was invoked but threw
      expect(seedArtificerRepairTask).not.toBeNull();
      expect(seedArtificerRepairTask).toHaveBeenCalledTimes(1);

      // P1 fix: task must be marked needs_human_review (not left in 'leased')
      expect(stateManager.updateTask).toHaveBeenCalledWith(
        EVALUATOR_TASK_ID,
        expect.objectContaining({ status: 'needs_human_review' }),
      );

      // Observable events emitted: seed failure + needs_human_review
      const eventEmitter = deps.eventEmitter as unknown as { emitTelemetry: ReturnType<typeof vi.fn> };
      const telemetryCalls = eventEmitter.emitTelemetry.mock.calls;
      const seedFailedCall = telemetryCalls.find(
        (call: readonly unknown[]) => typeof call[0] === 'object' && call[0] !== null
          && (call[0] as Record<string, unknown>).eventType === 'evaluator_repair_task_seed_failed',
      );
      expect(seedFailedCall).toBeDefined();

      const reviewCall = telemetryCalls.find(
        (call: readonly unknown[]) => typeof call[0] === 'object' && call[0] !== null
          && (call[0] as Record<string, unknown>).eventType === 'evaluator_task_needs_human_review',
      );
      expect(reviewCall).toBeDefined();
    });
  });
});
