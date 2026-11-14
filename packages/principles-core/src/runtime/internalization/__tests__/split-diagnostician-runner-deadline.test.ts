/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.1 — Parent Deadline contract.
 *
 * `SplitDiagnosticianRunner` mints ONE monotonic deadline when the pipeline
 * starts and every stage, retry and backoff must live inside it. This suite
 * proves the observable properties of that deadline:
 *
 *   1. a budget already spent before lease acquisition acquires no lease and
 *      runs no stage, yet the parent still reaches a terminal `failed` state;
 *   2. an exhausted budget after Stage A never starts Stage B;
 *   3. an exhausted budget after Stage B never starts Stage C;
 *   4. a Stage C result that arrives at/after the deadline is NOT committed;
 *   5. a retry that cannot fit the budget is never started;
 *   6. backoff is capped by the remaining budget, and every stage receives the
 *      SAME absolute parent deadline (a stage cannot extend it).
 *
 * Harness: real SQLite `RuntimeStateManager` (real leases through
 * `acquireLeaseDetailed`, real task/run rows), mock stage runners, and an
 * injected monotonic clock — so the deadline is deterministic and no test
 * waits on wall-clock time.
 *
 * ERR entries considered:
 *   - ERR-002: a budget failure must be observable, never silently swallowed
 *   - ERR-015: loop state (attempt/backoff) must be judged against the CURRENT
 *     deadline, never a stale or freshly-earned one
 *   - ERR-025: exercise the runner through its real state-manager boundary
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PeerRunnerResult } from '../../runner/peer-runner-types.js';
import type { DiagRootCauseOutputV1 } from '../../diagnostician/diag-rootcause-output.js';
import type { DiagDistillerOutputV1 } from '../../diagnostician/diag-distiller-output.js';
import type { DiagnosticianOutputV2 } from '../../diagnostician-output.js';
import type { RetryPolicy } from '../../store/lifecycle/retry-policy.js';
import { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import { SplitDiagnosticianRunner } from '../split-diagnostician-runner.js';
import {
  MOCK_DISTILLER_OUTPUTS,
  MOCK_ROOT_CAUSE_OUTPUTS,
  MOCK_ROUTER_OUTPUTS,
} from '../../adapter/split-pipeline-fixtures.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PARENT_TASK_ID = 'diagnosis_pain-deadline';
const STAGE_A_TASK_ID = `diag_rootcause-${PARENT_TASK_ID}`;
const STAGE_B_TASK_ID = `diag_distiller-${PARENT_TASK_ID}`;
const STAGE_C_TASK_ID = `diag_router-${PARENT_TASK_ID}`;

const PER_STAGE_TIMEOUT_MS = 5_000;
const PARENT_BUDGET_MS = 10_000;
/** (Re)configured stage backoff; deliberately far larger than the budget used below. */
const FIXED_BACKOFF_MS = 30_000;

// ── Fake monotonic clock ──────────────────────────────────────────────────────

interface FakeClock {
  readonly now: () => number;
  readonly set: (value: number) => void;
  readonly advance: (ms: number) => void;
}

function makeClock(start: number): FakeClock {
  let value = start;
  return {
    now: () => value,
    set: (next: number) => {
      value = next;
    },
    advance: (ms: number) => {
      value += ms;
    },
  };
}

/**
 * A clock whose successive reads are scripted. Used to model a worker that had
 * already burned its whole budget before the pipeline body began (the parent
 * budget is minted and immediately found to be spent).
 */
function makeScriptedClock(values: readonly number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0;
    index += 1;
    return value;
  };
}

// ── Real SQLite harness ───────────────────────────────────────────────────────

interface StoreHarness {
  readonly stateManager: RuntimeStateManager;
  readonly close: () => void;
}

async function openStore(): Promise<StoreHarness> {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-split-deadline-'));
  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();
  return {
    stateManager,
    close: () => {
      stateManager.close();
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

/** The bridge creates the parent diagnosis task before the runner is invoked. */
async function seedParentTask(stateManager: RuntimeStateManager): Promise<void> {
  await stateManager.createTask({
    taskId: PARENT_TASK_ID,
    taskKind: 'diagnostician',
    inputRef: 'pain-deadline',
    status: 'pending',
    attemptCount: 0,
    maxAttempts: 3,
    diagnosticJson: '{"pi_metadata":{"channel":"prompt"}}',
  });
}

// ── Stage runner doubles ──────────────────────────────────────────────────────

/** Produces the stage result for the task the orchestrator asks it to run. */
type StageHandler<T> = (taskId: string, deadline: number) => Promise<PeerRunnerResult<T>> | PeerRunnerResult<T>;

function makeMockRunner<T>(handler: StageHandler<T>) {
  const run = vi.fn(async (taskId: string, deadline = Number.NaN) => handler(taskId, deadline));
  // The orchestrator drives stages through the deadline-aware entry point; the
  // double delegates so both call counts and the handed deadline are observable.
  const runWithDeadline = vi.fn((taskId: string, deadline: number) => run(taskId, deadline));
  return { run, runWithDeadline };
}

function succeedWith<T>(output: T, after?: (deadline: number) => void): StageHandler<T> {
  return (taskId, deadline) => {
    after?.(deadline);
    return { status: 'succeeded', taskId, attemptCount: 1, output };
  };
}

function makeFixedBackoffPolicy(): RetryPolicy {
  return {
    shouldRetry: () => true,
    calculateBackoff: () => FIXED_BACKOFF_MS,
    markRetryWait: async (taskId, errorCategory) => ({ taskId, errorCategory }),
    markFailed: async (taskId, errorCategory) => ({ taskId, errorCategory }),
  };
}

interface PipelineOptions {
  readonly clock: () => number;
  readonly stageA: StageHandler<DiagRootCauseOutputV1>;
  readonly stageB: StageHandler<DiagDistillerOutputV1>;
  readonly stageC: StageHandler<DiagnosticianOutputV2>;
}

function buildPipeline(stateManager: RuntimeStateManager, options: PipelineOptions) {
  const rootCauseRunner = makeMockRunner(options.stageA);
  const distillerRunner = makeMockRunner(options.stageB);
  const routerRunner = makeMockRunner(options.stageC);
  const committer = { commit: vi.fn() };
  const runner = new SplitDiagnosticianRunner({
    rootCauseRunner: rootCauseRunner as never,
    distillerRunner: distillerRunner as never,
    routerRunner: routerRunner as never,
    stateManager,
    committer,
    perStageTimeoutMs: PER_STAGE_TIMEOUT_MS,
    parentBudgetMs: PARENT_BUDGET_MS,
    retryPolicy: makeFixedBackoffPolicy(),
    monotonicClock: options.clock,
  });
  return { runner, rootCauseRunner, distillerRunner, routerRunner, committer };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SPEC §5.1: SplitDiagnosticianRunner parent deadline', () => {
  it('case 1: budget already exhausted before lease acquisition — no lease, no stage, parent failed', async () => {
    const store = await openStore();
    try {
      await seedParentTask(store.stateManager);
      // First read mints the deadline; the second read is already at it.
      const pipeline = buildPipeline(store.stateManager, {
        clock: makeScriptedClock([0, PARENT_BUDGET_MS]),
        stageA: succeedWith(MOCK_ROOT_CAUSE_OUTPUTS.R6),
        stageB: succeedWith(MOCK_DISTILLER_OUTPUTS.R6),
        stageC: succeedWith(MOCK_ROUTER_OUTPUTS.R6),
      });

      const result = await pipeline.runner.run(PARENT_TASK_ID);

      expect(result.status).toBe('failed');
      expect(result.errorCategory).toBe('timeout');
      expect(result.failureReason).toContain('budget');

      // No lease was acquired (acquireLeaseDetailed also creates the run row)…
      expect(await store.stateManager.getRunsByTask(PARENT_TASK_ID)).toHaveLength(0);
      // …no stage task was created, and no stage ran…
      expect(await store.stateManager.getTask(STAGE_A_TASK_ID)).toBeNull();
      expect(pipeline.rootCauseRunner.runWithDeadline).not.toHaveBeenCalled();
      // …yet the parent is terminal, so the consumer cannot re-run it forever.
      const parent = await store.stateManager.getTask(PARENT_TASK_ID);
      expect(parent?.status).toBe('failed');
      expect(parent?.lastError).toBe('timeout');
    } finally {
      store.close();
    }
  });

  it('case 2: budget exhausted after Stage A — Stage B is never invoked', async () => {
    const store = await openStore();
    try {
      await seedParentTask(store.stateManager);
      const clock = makeClock(0);
      const pipeline = buildPipeline(store.stateManager, {
        clock: clock.now,
        // Stage A consumes the entire remaining parent budget.
        stageA: succeedWith(MOCK_ROOT_CAUSE_OUTPUTS.R6, () => clock.set(PARENT_BUDGET_MS)),
        stageB: () => {
          throw new Error('Stage B must not start with no parent budget');
        },
        stageC: () => {
          throw new Error('Stage C must not start with no parent budget');
        },
      });

      const result = await pipeline.runner.run(PARENT_TASK_ID);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('budget');
      expect(result.failureReason).toContain('before Stage B');
      expect(pipeline.rootCauseRunner.runWithDeadline).toHaveBeenCalledTimes(1);
      expect(pipeline.distillerRunner.runWithDeadline).not.toHaveBeenCalled();
      expect(await store.stateManager.getTask(STAGE_B_TASK_ID)).toBeNull();
      expect((await store.stateManager.getTask(PARENT_TASK_ID))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('case 3: budget exhausted after Stage B — Stage C is never invoked', async () => {
    const store = await openStore();
    try {
      await seedParentTask(store.stateManager);
      const clock = makeClock(0);
      const pipeline = buildPipeline(store.stateManager, {
        clock: clock.now,
        stageA: succeedWith(MOCK_ROOT_CAUSE_OUTPUTS.R6),
        // Stage B consumes the entire remaining parent budget.
        stageB: succeedWith(MOCK_DISTILLER_OUTPUTS.R6, () => clock.set(PARENT_BUDGET_MS)),
        stageC: () => {
          throw new Error('Stage C must not start with no parent budget');
        },
      });

      const result = await pipeline.runner.run(PARENT_TASK_ID);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('budget');
      expect(result.failureReason).toContain('before Stage C');
      expect(pipeline.rootCauseRunner.runWithDeadline).toHaveBeenCalledTimes(1);
      expect(pipeline.distillerRunner.runWithDeadline).toHaveBeenCalledTimes(1);
      expect(pipeline.routerRunner.runWithDeadline).not.toHaveBeenCalled();
      expect(await store.stateManager.getTask(STAGE_C_TASK_ID)).toBeNull();
      expect((await store.stateManager.getTask(PARENT_TASK_ID))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('case 4: a Stage C result that arrives after the deadline is not committed', async () => {
    const store = await openStore();
    try {
      await seedParentTask(store.stateManager);
      const clock = makeClock(0);
      const pipeline = buildPipeline(store.stateManager, {
        clock: clock.now,
        stageA: succeedWith(MOCK_ROOT_CAUSE_OUTPUTS.R6),
        stageB: succeedWith(MOCK_DISTILLER_OUTPUTS.R6),
        // Stage C returns succeeded, but its result is late.
        stageC: succeedWith(MOCK_ROUTER_OUTPUTS.R6, () => clock.set(PARENT_BUDGET_MS + 1)),
      });
      const markSucceeded = vi.spyOn(store.stateManager, 'markTaskSucceeded');
      const commitUnit = vi.spyOn(store.stateManager, 'commitDiagnosticianAndFinalize');

      const result = await pipeline.runner.run(PARENT_TASK_ID);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('budget');
      expect(result.failureReason).toContain('late result not committed');

      // No publication of the late result anywhere in the pipeline.
      expect(markSucceeded).not.toHaveBeenCalled();
      expect(commitUnit).not.toHaveBeenCalled();
      expect(pipeline.committer.commit).not.toHaveBeenCalled();
      expect(await store.stateManager.getCandidatesByTaskId(PARENT_TASK_ID)).toHaveLength(0);
      expect(await store.stateManager.piArtifactStore.listBySourceTaskId(STAGE_C_TASK_ID)).toHaveLength(0);

      const parent = await store.stateManager.getTask(PARENT_TASK_ID);
      expect(parent?.status).toBe('failed');
      expect(parent?.resultRef ?? null).toBeNull();
    } finally {
      store.close();
    }
  });

  it('case 5: a retry that cannot fit the parent budget is never started', async () => {
    const store = await openStore();
    try {
      await seedParentTask(store.stateManager);
      const clock = makeClock(0);
      const pipeline = buildPipeline(store.stateManager, {
        clock: clock.now,
        stageA: (taskId) => {
          // The stage itself spends the whole budget; a retry cannot fit.
          clock.set(PARENT_BUDGET_MS + 1);
          return {
            status: 'retried',
            taskId,
            errorCategory: 'output_invalid',
            failureReason: 'schema invalid',
            attemptCount: 1,
          };
        },
        stageB: () => {
          throw new Error('Stage B must not start');
        },
        stageC: () => {
          throw new Error('Stage C must not start');
        },
      });

      const result = await pipeline.runner.run(PARENT_TASK_ID);

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('budget');
      expect(result.failureReason).toContain('during retry backoff');
      // Exactly ONE attempt: the retry never started.
      expect(pipeline.rootCauseRunner.runWithDeadline).toHaveBeenCalledTimes(1);
      expect(pipeline.distillerRunner.runWithDeadline).not.toHaveBeenCalled();
      expect((await store.stateManager.getTask(PARENT_TASK_ID))?.status).toBe('failed');
    } finally {
      store.close();
    }
  });

  it('case 6: backoff is capped by the remaining budget and never sleeps past the deadline', async () => {
    const store = await openStore();
    try {
      await seedParentTask(store.stateManager);
      const clock = makeClock(0);
      const REMAINING_AT_FAILURE_MS = 300;
      const pipeline = buildPipeline(store.stateManager, {
        clock: clock.now,
        stageA: (taskId) => {
          // 300 ms of budget left — far less than the configured 30 s backoff.
          clock.set(PARENT_BUDGET_MS - REMAINING_AT_FAILURE_MS);
          // The scheduler may only wait up to the remaining budget; make the
          // clock cross the deadline long before any full backoff could end.
          setTimeout(() => clock.advance(REMAINING_AT_FAILURE_MS + 100), 2);
          return {
            status: 'retried',
            taskId,
            errorCategory: 'output_invalid',
            failureReason: 'schema invalid',
            attemptCount: 1,
          };
        },
        stageB: () => {
          throw new Error('Stage B must not start');
        },
        stageC: () => {
          throw new Error('Stage C must not start');
        },
      });

      const startedAt = Date.now();
      const result = await pipeline.runner.run(PARENT_TASK_ID);
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe('failed');
      expect(result.failureReason).toContain('budget');
      // The loop re-checks the SAME deadline after the capped sleep.
      expect(result.failureReason).toContain('before attempt 2');
      expect(pipeline.rootCauseRunner.runWithDeadline).toHaveBeenCalledTimes(1);
      // A full 30 s backoff would never fit; the wait is bounded by the budget.
      expect(elapsedMs).toBeLessThan(1_000);
    } finally {
      store.close();
    }
  });

  it('case 6: Stage A, B and C all receive the same absolute parent deadline', async () => {
    const store = await openStore();
    try {
      await seedParentTask(store.stateManager);
      const START_MS = 1_000;
      const clock = makeClock(START_MS);
      const handedDeadlines: number[] = [];
      const capture = <T>(output: T): StageHandler<T> => (taskId, deadline) => {
        handedDeadlines.push(deadline);
        return { status: 'succeeded', taskId, attemptCount: 1, output };
      };
      const pipeline = buildPipeline(store.stateManager, {
        clock: clock.now,
        stageA: capture(MOCK_ROOT_CAUSE_OUTPUTS.R6),
        stageB: capture(MOCK_DISTILLER_OUTPUTS.R6),
        stageC: capture(MOCK_ROUTER_OUTPUTS.R6),
      });

      const result = await pipeline.runner.run(PARENT_TASK_ID);

      expect(result.status).toBe('succeeded');
      expect(handedDeadlines).toEqual([
        START_MS + PARENT_BUDGET_MS,
        START_MS + PARENT_BUDGET_MS,
        START_MS + PARENT_BUDGET_MS,
      ]);
      expect((await store.stateManager.getTask(PARENT_TASK_ID))?.status).toBe('succeeded');
    } finally {
      store.close();
    }
  });
});
