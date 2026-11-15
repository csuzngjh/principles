/**
 * Test support for the fenced lease API introduced by
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.3.
 *
 * Runner unit tests use plain object doubles of `RuntimeStateManager`. The
 * production runners now acquire through `acquireLeaseDetailed`, renew/probe
 * with a `LeaseFence`, and persist diagnostic JSON through
 * `applyFencedDiagnosticJson`. This helper upgrades an existing double in
 * place so the tests keep exercising the SAME wiring without each file
 * re-implementing the fencing semantics.
 *
 * It models one live lease PER TASK ID (a split pipeline acquires a parent
 * lease and then one per stage), which is the shape the runner tests use.
 */
import { vi } from 'vitest';
import type { TaskRecord } from '../../task-status.js';
import type { RuntimeStateManager } from '../../store/runtime-state-manager.js';
import type { LeaseFence } from '../../store/lifecycle/lease-fence.js';

export interface FencedLeaseMockOptions {
  /**
   * The runId the fake acquisition reports as its execution identity. When
   * omitted the helper derives it from the double's run accessors — the same
   * "latest run" resolution the pre-SPEC runner used.
   */
  runId?: string;
  /** Fencing token minted by the fake acquisition (default 1). */
  leaseGeneration?: number;
  /** Lease validity window used by renewals (default 300s). */
  ttlMs?: number;
}

interface LeasedEntry {
  task: TaskRecord;
  fence: LeaseFence;
}

interface FencedLeaseState {
  entries: Map<string, LeasedEntry>;
  ttlMs: number;
}

const STATES = new WeakMap<object, FencedLeaseState>();

function futureIso(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

/**
 * Seed/refresh the double's persisted lease row.
 *
 * Direct-lifecycle tests (which call `bindExecutionIdentity` without an
 * acquisition) use this so the fenced read-modify-write starts from the JSON
 * the task actually carried — the same row production would read back.
 */
export function seedFencedLeaseTask(stateManager: object, task: TaskRecord): void {
  const state = STATES.get(stateManager);
  if (!state) return;
  const existing = state.entries.get(task.taskId);
  const owner = existing?.fence.owner ?? task.leaseOwner;
  const generation = existing?.fence.leaseGeneration ?? task.leaseGeneration;
  const leased: TaskRecord = {
    ...task,
    status: 'leased',
    leaseOwner: owner,
    leaseGeneration: generation,
    leaseExpiresAt: futureIso(state.ttlMs),
  };
  if (owner && typeof generation === 'number') {
    state.entries.set(task.taskId, {
      task: leased,
      fence: { taskId: task.taskId, owner, leaseGeneration: generation },
    });
  }
}

/**
 * Add the router's atomic commit unit to a state-manager double.
 *
 * SPEC §5.3 folds artifact + candidate + PIArtifact + terminal task/run write
 * into one fenced call on the state manager. Doubles that previously wired a
 * standalone committer must expose that entry point; this helper keeps their
 * existing committer/artifact-store expectations meaningful.
 */
export function installDiagnosticianCommitMock(
  stateManager: Record<string, unknown>,
  options: {
    commit: (input: unknown) => Promise<{ commitId: string; artifactId: string; candidateCount: number }>;
    artifactStore?: { upsertArtifact: (record: never) => unknown };
    runId: string;
  },
): void {
  stateManager.commitDiagnosticianAndFinalize = vi.fn(async (input: {
    fence: LeaseFence;
    runId: string;
    resultRef?: string;
    commit: unknown;
    piArtifact?: {
      artifactId: string;
      artifactKind: string;
      sourceTaskId: string;
      lineageArtifactIds: string[];
      validationStatus: string;
      contentJson: string;
      createdAt: string;
      updatedAt: string;
    };
  }) => {
    const commit = await options.commit(input.commit);
    const resultRef = input.resultRef ?? `commit://${commit.commitId}`;
    if (options.artifactStore && input.piArtifact) {
      const { sourceTaskId, ...artifact } = input.piArtifact;
      // Awaited: a failing dual-write must fail the whole commit (PRI-667).
      await options.artifactStore.upsertArtifact({ ...artifact, sourceTaskId } as never);
    }
    const markSucceeded = stateManager.markTaskSucceeded as
      RuntimeStateManager['markTaskSucceeded'] | undefined;
    const task = markSucceeded
      ? await markSucceeded(input.fence.taskId, resultRef, input.fence, input.runId)
      : ({ taskId: input.fence.taskId, status: 'succeeded', resultRef } as TaskRecord);
    return { commit, task, resultRef };
  });
}

/**
 * Add the fenced lease surface to a `RuntimeStateManager` double.
 *
 * @param stateManager the plain double to upgrade (mutated in place)
 * @param options fake execution identity
 * @returns the same object, narrowed to a record for convenient chaining
 */
export function installFencedLeaseMock(
  stateManager: Record<string, unknown>,
  options: FencedLeaseMockOptions = {},
): Record<string, unknown> {
  const generation = options.leaseGeneration ?? 1;
  const ttlMs = options.ttlMs ?? 300_000;
  const state: FencedLeaseState = { entries: new Map(), ttlMs };
  STATES.set(stateManager, state);

  const originalGetTask = stateManager.getTask as ((taskId: string) => Promise<TaskRecord | null>) | undefined;

  const resolveRunId = async (taskId: string): Promise<string> => {
    if (options.runId) return options.runId;
    type RunListResult = { runs?: { runId?: unknown }[] };
    const tolerant = stateManager.getValidRunsByTaskTolerant as ((id: string) => Promise<RunListResult>) | undefined;
    if (tolerant) {
      const result = await tolerant(taskId);
      const runs = result?.runs ?? [];
      const last = runs[runs.length - 1];
      if (last && typeof last.runId === 'string') return last.runId;
    }
    const byTask = stateManager.getRunsByTask as ((id: string) => Promise<RunListResult>) | undefined;
    if (byTask) {
      const result = await byTask(taskId);
      const runs = result?.runs ?? [];
      const last = runs[runs.length - 1];
      if (last && typeof last.runId === 'string') return last.runId;
    }
    return 'run-001';
  };

  stateManager.acquireLeaseDetailed = vi.fn(async (acquireOptions: { taskId: string; owner: string }) => {
    const acquire = stateManager.acquireLease as ((opts: unknown) => Promise<TaskRecord>) | undefined;
    const acquired = acquire ? await acquire(acquireOptions) : null;
    // The split orchestrator acquires a parent row its store double may not
    // know about yet; never mint a lease with an undefined task id.
    const baseTask: TaskRecord = acquired ?? ({
      taskId: acquireOptions.taskId,
      taskKind: 'test',
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as TaskRecord);
    const runId = await resolveRunId(baseTask.taskId ?? acquireOptions.taskId);
    const leasedTask: TaskRecord = {
      ...baseTask,
      taskId: baseTask.taskId ?? acquireOptions.taskId,
      status: 'leased',
      leaseOwner: acquireOptions.owner,
      leaseGeneration: generation,
      leaseExpiresAt: futureIso(ttlMs),
    };
    const fence: LeaseFence = {
      taskId: leasedTask.taskId,
      owner: acquireOptions.owner,
      leaseGeneration: generation,
    };
    state.entries.set(leasedTask.taskId, { task: leasedTask, fence });
    return { task: leasedTask, runId, leaseGeneration: generation };
  });

  // Ownership probe: the persisted row for a leased task must read back as
  // live and owned by the same identity, otherwise the heartbeat (fail-closed)
  // refuses the terminal commit. Non-lease fields come from the double's own
  // row so store-backed writes (diagnostic JSON, result refs) stay observable.
  stateManager.getTask = vi.fn(async (taskId: string) => {
    const resolved = originalGetTask ? await originalGetTask(taskId) : null;
    const entry = state.entries.get(taskId);
    if (entry) {
      return {
        ...entry.task,
        ...(resolved ?? {}),
        status: entry.task.status,
        leaseOwner: entry.task.leaseOwner,
        leaseGeneration: entry.task.leaseGeneration,
        leaseExpiresAt: entry.task.leaseExpiresAt,
      };
    }
    return resolved;
  });

  stateManager.renewLease = vi.fn(async (renewFence: LeaseFence) => {
    const entry = state.entries.get(renewFence.taskId);
    if (!entry) {
      throw new Error(`renewLease: no lease held for ${renewFence.taskId}`);
    }
    entry.task = { ...entry.task, leaseExpiresAt: futureIso(ttlMs) };
    return entry.task;
  });

  stateManager.releaseLease = vi.fn(async (releaseFence: LeaseFence) => {
    const entry = state.entries.get(releaseFence.taskId);
    if (!entry) {
      throw new Error(`releaseLease: no lease held for ${releaseFence.taskId}`);
    }
    return entry.task;
  });

  stateManager.assertLeaseOwned = vi.fn(async (probeFence: LeaseFence) => {
    const entry = state.entries.get(probeFence.taskId);
    return Boolean(entry)
      && probeFence.leaseGeneration === entry?.fence.leaseGeneration
      && probeFence.owner === entry?.fence.owner;
  });

  // Keep the persisted row truthful: a store double that never applied
  // `updateTask` would still read back `leased` after a committer persisted a
  // new status, which the fenced read-back guards correctly reject.
  const originalUpdateTask = stateManager.updateTask as
    ((taskId: string, patch: Record<string, unknown>) => Promise<unknown>) | undefined;
  if (originalUpdateTask) {
    stateManager.updateTask = vi.fn(async (taskId: string, patch: Record<string, unknown>) => {
      const result = await originalUpdateTask(taskId, patch);
      const entry = state.entries.get(taskId);
      if (entry) {
        entry.task = { ...entry.task, ...patch };
      }
      return result;
    });
  }

  const applyTerminalStatus = (method: 'markTaskSucceeded' | 'markTaskFailed' | 'markTaskRetryWait', status: string): void => {
    const original = stateManager[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    stateManager[method] = vi.fn(async (...args: unknown[]) => {
      const result = original ? await original(...args) : undefined;
      const [taskId] = args;
      if (typeof taskId === 'string') {
        const entry = state.entries.get(taskId);
        if (entry) {
          entry.task = { ...entry.task, status } as TaskRecord;
        }
      }
      return result;
    });
  };
  applyTerminalStatus('markTaskSucceeded', 'succeeded');
  applyTerminalStatus('markTaskFailed', 'failed');
  applyTerminalStatus('markTaskRetryWait', 'retry_wait');

  // Diagnostic-json CAS (SPEC-PD-STRATEGIC-INTENT-ANCHORING-001 §6.6). Applies
  // the patch only while the persisted JSON is byte-equal to the expectation,
  // and keeps the entry's row truthful so a follow-up read observes the write.
  stateManager.updateTaskIfDiagnosticJsonUnchanged = vi.fn(async (
    taskId: string,
    expectedDiagnosticJson: string | null,
    patch: Record<string, unknown>,
  ) => {
    const entry = state.entries.get(taskId);
    const currentJson = entry?.task.diagnosticJson ?? null;
    if (currentJson !== expectedDiagnosticJson) return null;
    if (entry) {
      entry.task = { ...entry.task, ...patch };
    }
    const updateTask = stateManager.updateTask as ((id: string, p: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (updateTask) {
      await updateTask(taskId, patch);
    }
    return entry?.task ?? null;
  });

  // Fenced read-modify-write. Delegates to the double's `updateTask` (when it
  // has one) so existing persisted-JSON assertions keep observing the SAME
  // write, exactly as the pre-fence implementation did.
  stateManager.applyFencedDiagnosticJson = vi.fn(async (
    writeFence: LeaseFence,
    mutate: (current: string | null) => string,
  ) => {
    const entry = state.entries.get(writeFence.taskId);
    const currentJson = entry?.task.diagnosticJson ?? null;
    const nextJson = mutate(currentJson);
    if (entry) {
      entry.task = { ...entry.task, diagnosticJson: nextJson };
    }
    const updateTask = stateManager.updateTask as ((taskId: string, patch: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (updateTask) {
      await updateTask(writeFence.taskId, { diagnosticJson: nextJson });
    }
    return entry?.task ?? ({ taskId: writeFence.taskId, status: 'leased' } as TaskRecord);
  });

  return stateManager;
}

/**
 * Convenience wrapper for `RuntimeStateManager` doubles, typed the same way the
 * tests already cast their literals.
 */
export function fencedStateManager(stateManager: Record<string, unknown>): RuntimeStateManager {
  // runtime-contract-exempt: ERR-001 — test double limited to the state-manager surface; no production runtime data crosses this cast.
  return installFencedLeaseMock(stateManager) as unknown as RuntimeStateManager;
}
