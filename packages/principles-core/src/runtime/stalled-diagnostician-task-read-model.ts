/**
 * StalledDiagnosticianTaskReadModel — read model to detect stalled diagnostician tasks.
 *
 * A stalled task has taskKind = 'diagnostician', status = 'pending', attemptCount = 0,
 * no runs, and age > thresholdSeconds.
 *
 * PRI-377 — Surface stalled diagnostician tasks with explicit next actions.
 *
 * SPEC v0.8 §9.4 (L2b) extends this same read model with `getBacklog()`: the
 * Owner-facing answer to "is anything waiting, how long, and did anything
 * actually run recently?". It deliberately does NOT claim the executor is
 * alive — only whether execution activity was observed.
 */
import type { TaskRecord } from './task-status.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';

export interface StalledDiagnosticianTaskInfo {
  readonly taskId: string;
  readonly inputRef: string | null;
  readonly age: number; // in seconds
  readonly reason: string;
  readonly nextAction: string;
}

export interface StalledDiagnosticianTaskReadModelOptions {
  stateManager: RuntimeStateManager;
}

/** Task kind owned by this read model. */
const DIAGNOSTICIAN_TASK_KIND = 'diagnostician';

/**
 * Window that separates "a run start was observed" from "nothing was
 * observed". Only an observed `runs.started_at` counts as activity.
 */
export const RECENT_ACTIVITY_WINDOW_MS = 30 * 60 * 1000;

/**
 * L2b health verdicts. Wording boundary (SPEC §9.4 / TD §8.3.3): `stalled`
 * means "no execution activity was observed", never "the executor is dead".
 */
export type DiagnosticianBacklogHealth = 'idle' | 'running' | 'backlog' | 'stalled';

/**
 * Configuration facts for the backlog page. These do not claim the service is
 * running — they answer "is it switched on, and is there a binding to run?".
 */
export interface DiagnosticianBacklogConfiguration {
  readonly l3FlagEnabled: boolean;
  readonly capabilityAvailable: boolean;
  readonly runtimeBound: boolean;
}

export interface DiagnosticianBacklogSnapshot {
  readonly workspaceDir: string;
  readonly generatedAt: string;
  readonly pendingCount: number;
  readonly retryWaitCount: number;
  readonly leasedCount: number;
  readonly staleLeaseCount: number;
  readonly stalledCount: number;
  readonly oldestPendingTaskId: string | null;
  readonly oldestPendingPainId: string | null;
  readonly oldestPendingCreatedAt: string | null;
  readonly oldestPendingAgeMs: number | null;
  readonly lastRunStartedAt: string | null;
  readonly observedRecentActivity: boolean;
  readonly health: DiagnosticianBacklogHealth;
  readonly configuration: DiagnosticianBacklogConfiguration;
}

export interface DiagnosticianBacklogOptions {
  /** Configuration facts, resolved by the caller that owns config loading. */
  readonly configuration: DiagnosticianBacklogConfiguration;
  /** Stalled-task age threshold, default 300s (same as listStalledTasks). */
  readonly thresholdSeconds?: number;
  /** Injectable clock for deterministic reads/tests. */
  readonly now?: Date;
  /** Override of RECENT_ACTIVITY_WINDOW_MS (tests only). */
  readonly recentActivityWindowMs?: number;
}

/** Oldest pending task by created_at; unparsable timestamps are skipped, not guessed. */
function findOldestPending(tasks: readonly TaskRecord[]): TaskRecord | null {
  let oldest: TaskRecord | null = null;
  let oldestMs = Number.POSITIVE_INFINITY;
  for (const task of tasks) {
    const createdMs = new Date(task.createdAt).getTime();
    if (!Number.isFinite(createdMs)) continue;
    if (createdMs < oldestMs) {
      oldest = task;
      oldestMs = createdMs;
    }
  }
  return oldest;
}

export class StalledDiagnosticianTaskReadModel {
  private readonly stateManager: RuntimeStateManager;

  constructor(opts: StalledDiagnosticianTaskReadModelOptions) {
    this.stateManager = opts.stateManager;
  }

  async checkStalledTask(
    taskId: string,
    thresholdSeconds = 300,
    nowMs: number = Date.now(),
  ): Promise<StalledDiagnosticianTaskInfo | null> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      return null;
    }

    if (
      task.taskKind === 'diagnostician' &&
      task.status === 'pending' &&
      task.attemptCount === 0
    ) {
      const runs = await this.stateManager.getRunsByTask(taskId);
      if (runs.length === 0) {
        const createdAtTime = new Date(task.createdAt).getTime();
        const ageSeconds = Math.floor((nowMs - createdAtTime) / 1000);
        if (ageSeconds > thresholdSeconds) {
          const { workspaceDir } = this.stateManager;
          const nextAction = `pd diagnose run --task-id ${taskId} --workspace "${workspaceDir}" --runtime pi-ai --json`;
          return {
            taskId,
            inputRef: task.inputRef ?? null,
            age: ageSeconds,
            reason: `Task is pending with 0 attempts and no execution runs after ${thresholdSeconds}s (submitted-without-run).`,
            nextAction,
          };
        }
      }
    }

    return null;
  }

  async listStalledTasks(
    thresholdSeconds = 300,
    nowMs: number = Date.now(),
  ): Promise<StalledDiagnosticianTaskInfo[]> {
    const tasks = await this.stateManager.listTasks({ taskKind: 'diagnostician', status: 'pending' });
    const stalled: StalledDiagnosticianTaskInfo[] = [];
    for (const task of tasks) {
      if (task.attemptCount === 0) {
        const runs = await this.stateManager.getRunsByTask(task.taskId);
        if (runs.length === 0) {
          const createdAtTime = new Date(task.createdAt).getTime();
          const ageSeconds = Math.floor((nowMs - createdAtTime) / 1000);
          if (ageSeconds > thresholdSeconds) {
            const { workspaceDir } = this.stateManager;
            const nextAction = `pd diagnose run --task-id ${task.taskId} --workspace "${workspaceDir}" --runtime pi-ai --json`;
            stalled.push({
              taskId: task.taskId,
              inputRef: task.inputRef ?? null,
              age: ageSeconds,
              reason: `Task is pending with 0 attempts and no execution runs after ${thresholdSeconds}s (submitted-without-run).`,
              nextAction,
            });
          }
        }
      }
    }
    return stalled;
  }

  /**
   * L2b backlog snapshot (SPEC v0.8 §9.4, TD §8.3.3).
   *
   * Activity comes from `runs.started_at` only. `tasks.updated_at` must not be
   * used: createTask writes created_at and updated_at together, so a freshly
   * created pending task would masquerade as recent activity (F10/T35).
   */
  async getBacklog(opts: DiagnosticianBacklogOptions): Promise<DiagnosticianBacklogSnapshot> {
    const now = opts.now ?? new Date();
    const nowMs = now.getTime();
    const thresholdSeconds = opts.thresholdSeconds ?? 300;
    const recentActivityWindowMs = opts.recentActivityWindowMs ?? RECENT_ACTIVITY_WINDOW_MS;

    const [pendingTasks, retryWaitTasks, leasedTasks, stalledTasks] = await Promise.all([
      this.stateManager.listTasks({ taskKind: DIAGNOSTICIAN_TASK_KIND, status: 'pending' }),
      this.stateManager.listTasks({ taskKind: DIAGNOSTICIAN_TASK_KIND, status: 'retry_wait' }),
      this.stateManager.listTasks({ taskKind: DIAGNOSTICIAN_TASK_KIND, status: 'leased' }),
      this.listStalledTasks(thresholdSeconds, nowMs),
    ]);

    const staleLeaseCount = leasedTasks.filter((task) => {
      if (!task.leaseExpiresAt) return false;
      const expiresMs = new Date(task.leaseExpiresAt).getTime();
      return Number.isFinite(expiresMs) && expiresMs < nowMs;
    }).length;

    const oldest = findOldestPending(pendingTasks);

    const lastRunStartedAt = await this.stateManager.runStore.getLatestRunStartedAtForTaskKind(DIAGNOSTICIAN_TASK_KIND);
    const lastRunMs = lastRunStartedAt === null ? Number.NaN : new Date(lastRunStartedAt).getTime();
    const observedRecentActivity = Number.isFinite(lastRunMs) && nowMs - lastRunMs < recentActivityWindowMs;

    const hasBacklog = pendingTasks.length + retryWaitTasks.length > 0;
    const health: DiagnosticianBacklogHealth =
      leasedTasks.length > 0
        ? 'running'
        : !hasBacklog
          ? 'idle'
          : observedRecentActivity
            ? 'backlog'
            : 'stalled';

    return {
      workspaceDir: this.stateManager.workspaceDir,
      generatedAt: now.toISOString(),
      pendingCount: pendingTasks.length,
      retryWaitCount: retryWaitTasks.length,
      leasedCount: leasedTasks.length,
      staleLeaseCount,
      stalledCount: stalledTasks.length,
      oldestPendingTaskId: oldest?.taskId ?? null,
      oldestPendingPainId: oldest?.inputRef ?? null,
      oldestPendingCreatedAt: oldest?.createdAt ?? null,
      oldestPendingAgeMs: oldest === null ? null : nowMs - new Date(oldest.createdAt).getTime(),
      lastRunStartedAt,
      observedRecentActivity,
      health,
      configuration: opts.configuration,
    };
  }
}

