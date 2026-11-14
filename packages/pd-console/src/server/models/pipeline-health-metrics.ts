/**
 * Pipeline health metrics (SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §3).
 *
 * Lives in the Console server model layer on purpose: it is a presentation read
 * model over core's persisted facts, not a domain capability. Keeping it here
 * means the core public surface does not grow for a single host consumer
 * (see the core export-surface admission rule).
 *
 * Read-model ONLY. Every number is derived from the facts the runtime already
 * persists (`tasks`, `runs`) — nothing here writes state, creates a second
 * source of truth, or estimates a value it cannot observe.
 *
 * Honesty rules (rc-9, SPEC §3.4):
 *   - a metric whose data is not persisted is reported `available: false` with
 *     an explicit reason. It is NEVER reported as 0.
 *   - percentiles are nearest-rank over the observed samples in the window; a
 *     sample count of 0 yields nulls, not zeros.
 *   - the window is explicit so a caller can never present lifetime totals as
 *     "recent".
 */
import type { TaskRecord } from '@principles/core/runtime';

/**
 * Structural mirror of `SqliteRunStore.listStageRunSamples`'s row shape
 * (core keeps that DTO module-internal). The store is the only producer; this
 * declaration must stay structurally identical.
 */
export interface StageRunSample {
  readonly runId: string;
  readonly taskId: string;
  readonly taskKind: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly executionStatus: string;
  readonly errorCategory: string | null;
  readonly attemptNumber: number;
}

export interface LatencySummary {
  readonly sampleCount: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly p99Ms: number | null;
  readonly maxMs: number | null;
}

export interface MetricAvailability<T> {
  readonly available: boolean;
  readonly value: T | null;
  readonly reason?: string;
}

export interface StageMetrics {
  readonly taskKind: string;
  readonly sampleCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly retryRunCount: number;
  readonly duration: LatencySummary;
}

export interface RecentPipelineExecution {
  readonly taskId: string;
  readonly parentTaskId: string | null;
  readonly stage: 'A' | 'B' | 'C' | null;
  readonly taskKind: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly errorCategory: string | null;
}

export interface PipelineHealthMetrics {
  readonly generatedAt: string;
  readonly windowMs: number;
  readonly queue: {
    /** Parent diagnostician tasks waiting for (or being) diagnosed. */
    readonly painQueueDepth: number;
    /** Downstream internalization tasks ready to run. */
    readonly readyQueueDepth: number;
    readonly retryQueueDepth: number;
    readonly leasedCount: number;
    readonly oldestPendingAgeMs: number | null;
    readonly oldestPendingTaskKind: string | null;
  };
  readonly stage2: {
    readonly pendingDepth: MetricAvailability<number>;
  };
  readonly stages: {
    readonly a: StageMetrics;
    readonly b: StageMetrics;
    readonly c: StageMetrics;
  };
  readonly queueWait: LatencySummary;
  readonly reliability: {
    readonly stageRetryCount: number;
    /** Leases that are leased RIGHT NOW but already expired. */
    readonly expiredActiveLeaseCount: number;
    readonly diagnosisSuccessRate: MetricAvailability<number>;
    readonly leaseRenewalFailureCount: MetricAvailability<number>;
    readonly leaseRecoveryCount: MetricAvailability<number>;
    readonly staleCommitRejectedCount: MetricAvailability<number>;
  };
  readonly provider: {
    readonly errorRate: MetricAvailability<number>;
    readonly errorCountsByCategory: Readonly<Record<string, number>>;
    readonly rateLimitCount: number;
    readonly timeoutCount: number;
  };
  readonly tokens: {
    readonly tokensPerPain: MetricAvailability<number>;
  };
  readonly lineage: {
    readonly available: boolean;
    readonly reason?: string;
    readonly recentExecutions: readonly RecentPipelineExecution[];
  };
  readonly notes: readonly string[];
}

export const DIAGNOSTICIAN_PARENT_TASK_KIND = 'diagnostician';
export const STAGE_TASK_KIND_A = 'diag_rootcause';
export const STAGE_TASK_KIND_B = 'diag_distiller';
export const STAGE_TASK_KIND_C = 'diag_router';

const INTERNALIZATION_KINDS = ['dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator', 'rollout_reviewer'] as const;
const STAGE_KINDS = [STAGE_TASK_KIND_A, STAGE_TASK_KIND_B, STAGE_TASK_KIND_C] as const;

const RECENT_EXECUTION_LIMIT = 20;

function available<T>(value: T): MetricAvailability<T> {
  return { available: true, value };
}

function unavailable<T>(reason: string): MetricAvailability<T> {
  return { available: false, value: null, reason };
}

/** Nearest-rank percentile over a NON-EMPTY, ascending array. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length - 1, rank - 1)] ?? 0;
}

export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  const clean = samples.filter((value) => Number.isFinite(value) && value >= 0).slice().sort((a, b) => a - b);
  if (clean.length === 0) {
    return { sampleCount: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  }
  return {
    sampleCount: clean.length,
    p50Ms: percentile(clean, 0.5),
    p95Ms: percentile(clean, 0.95),
    p99Ms: percentile(clean, 0.99),
    maxMs: clean[clean.length - 1] ?? null,
  };
}

function durationMs(startedAt: string, endedAt: string | null): number | null {
  if (endedAt === null) return null;
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function stageOf(taskKind: string): 'A' | 'B' | 'C' | null {
  if (taskKind === STAGE_TASK_KIND_A) return 'A';
  if (taskKind === STAGE_TASK_KIND_B) return 'B';
  if (taskKind === STAGE_TASK_KIND_C) return 'C';
  return null;
}

/** `diag_rootcause-<parentTaskId>` → `<parentTaskId>`; anything else → null. */
export function parentTaskIdFromStageTaskId(taskId: string): string | null {
  const match = /^(?:diag_rootcause|diag_distiller|diag_router)-(.+)$/.exec(taskId);
  return match?.[1] ?? null;
}

function stageMetrics(taskKind: string, runs: readonly StageRunSample[]): StageMetrics {
  const stageRuns = runs.filter((run) => run.taskKind === taskKind);
  const durations: number[] = [];
  let successCount = 0;
  let failureCount = 0;
  let retryRunCount = 0;
  for (const run of stageRuns) {
    const d = durationMs(run.startedAt, run.endedAt);
    if (d !== null) durations.push(d);
    if (run.executionStatus === 'succeeded') successCount += 1;
    if (run.executionStatus === 'failed') failureCount += 1;
    if (run.attemptNumber > 0) retryRunCount += 1;
  }
  return {
    taskKind,
    sampleCount: stageRuns.length,
    successCount,
    failureCount,
    retryRunCount,
    duration: summarizeLatencies(durations),
  };
}

function ageMs(iso: string | undefined, nowMs: number): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, nowMs - parsed);
}

/** First attempt's start minus the task's creation = time spent waiting. */
function queueWaitSamples(
  tasksById: ReadonlyMap<string, TaskRecord>,
  runs: readonly StageRunSample[],
): number[] {
  const firstStartByTask = new Map<string, number>();
  for (const run of runs) {
    const start = Date.parse(run.startedAt);
    if (!Number.isFinite(start)) continue;
    const current = firstStartByTask.get(run.taskId);
    if (current === undefined || start < current) firstStartByTask.set(run.taskId, start);
  }
  const samples: number[] = [];
  for (const [taskId, start] of firstStartByTask) {
    const task = tasksById.get(taskId);
    if (!task) continue;
    const created = Date.parse(task.createdAt);
    if (!Number.isFinite(created) || start < created) continue;
    samples.push(start - created);
  }
  return samples;
}

export function buildPipelineHealthMetrics(input: {
  readonly nowMs: number;
  readonly windowMs: number;
  readonly tasks: readonly TaskRecord[];
  readonly stageRuns: readonly StageRunSample[];
}): PipelineHealthMetrics {
  const { nowMs, windowMs, tasks, stageRuns } = input;
  const sinceMs = nowMs - windowMs;
  const inWindow = stageRuns.filter((run) => {
    const started = Date.parse(run.startedAt);
    return Number.isFinite(started) && started >= sinceMs;
  });

  const tasksById = new Map(tasks.map((task) => [task.taskId, task] as const));

  const painQueueDepth = tasks.filter(
    (task) => task.taskKind === DIAGNOSTICIAN_PARENT_TASK_KIND && (task.status === 'pending' || task.status === 'retry_wait'),
  ).length;
  const readyQueueDepth = tasks.filter(
    (task) => task.status === 'pending' && (INTERNALIZATION_KINDS as readonly string[]).includes(task.taskKind),
  ).length;
  const retryQueueDepth = tasks.filter(
    (task) => task.status === 'retry_wait' && (INTERNALIZATION_KINDS as readonly string[]).includes(task.taskKind),
  ).length;
  const leasedCount = tasks.filter((task) => task.status === 'leased').length;
  const expiredActiveLeaseCount = tasks.filter((task) => {
    if (task.status !== 'leased' || typeof task.leaseExpiresAt !== 'string') return false;
    const expiresAtMs = Date.parse(task.leaseExpiresAt);
    return Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
  }).length;

  const pendingLike = tasks.filter(
    (task) =>
      (task.status === 'pending' || task.status === 'leased' || task.status === 'retry_wait')
      && (task.taskKind === DIAGNOSTICIAN_PARENT_TASK_KIND || (STAGE_KINDS as readonly string[]).includes(task.taskKind)),
  );
  let oldestPendingAgeMs: number | null = null;
  let oldestPendingTaskKind: string | null = null;
  for (const task of pendingLike) {
    const age = ageMs(task.createdAt, nowMs);
    if (age === null) continue;
    if (oldestPendingAgeMs === null || age > oldestPendingAgeMs) {
      oldestPendingAgeMs = age;
      oldestPendingTaskKind = task.taskKind;
    }
  }

  const stageC = stageMetrics(STAGE_TASK_KIND_C, inWindow);
  const stageCTotal = stageC.successCount + stageC.failureCount;
  const diagnosisSuccessRate = stageCTotal === 0
    ? unavailable<number>('no completed Stage C runs in the window')
    : available(stageC.successCount / stageCTotal);

  const failedRuns = inWindow.filter((run) => run.executionStatus === 'failed');
  const providerErrorRate = inWindow.length === 0
    ? unavailable<number>('no diagnostician stage runs in the window')
    : available(failedRuns.length / inWindow.length);

  const errorCountsByCategory: Record<string, number> = {};
  for (const run of failedRuns) {
    const key = run.errorCategory ?? 'unclassified';
    errorCountsByCategory[key] = (errorCountsByCategory[key] ?? 0) + 1;
  }

  const stageRetryCount = inWindow.filter((run) => run.attemptNumber > 0).length;

  const recentExecutions: RecentPipelineExecution[] = inWindow
    .slice()
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, RECENT_EXECUTION_LIMIT)
    .map((run) => {
      const task = tasksById.get(run.taskId);
      return {
        taskId: run.taskId,
        parentTaskId: parentTaskIdFromStageTaskId(run.taskId),
        stage: stageOf(run.taskKind),
        taskKind: run.taskKind,
        status: run.executionStatus,
        attemptCount: task?.attemptCount ?? run.attemptNumber,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
        durationMs: durationMs(run.startedAt, run.endedAt),
        errorCategory: run.errorCategory,
      };
    });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowMs,
    queue: {
      painQueueDepth,
      readyQueueDepth,
      retryQueueDepth,
      leasedCount,
      oldestPendingAgeMs,
      oldestPendingTaskKind,
    },
    stage2: {
      pendingDepth: unavailable(
        'Stage-2 confirmations live in trajectory.db (signal_confirmations); this console read model only opens state.db',
      ),
    },
    stages: {
      a: stageMetrics(STAGE_TASK_KIND_A, inWindow),
      b: stageMetrics(STAGE_TASK_KIND_B, inWindow),
      c: stageC,
    },
    queueWait: summarizeLatencies(queueWaitSamples(tasksById, inWindow)),
    reliability: {
      stageRetryCount,
      expiredActiveLeaseCount,
      diagnosisSuccessRate,
      leaseRenewalFailureCount: unavailable(
        'lease renewal failures are emitted as telemetry events (lease_renewal_failed), not persisted as task/run rows',
      ),
      leaseRecoveryCount: unavailable(
        'the recovery sweep does not persist a per-task recovery marker; recovered counts are emitted as consumer cycle events',
      ),
      staleCommitRejectedCount: unavailable(
        'stale_commit_rejected is emitted as a telemetry event, not persisted as a task/run row',
      ),
    },
    provider: {
      errorRate: providerErrorRate,
      errorCountsByCategory,
      rateLimitCount: errorCountsByCategory.rate_limit ?? 0,
      timeoutCount: errorCountsByCategory.timeout ?? 0,
    },
    tokens: {
      tokensPerPain: unavailable(
        'provider token usage is recorded per invocation in runtime telemetry, not aggregated in state.db',
      ),
    },
    lineage: {
      available: recentExecutions.length > 0,
      ...(recentExecutions.length === 0 ? { reason: 'no stage runs in the window' } : {}),
      recentExecutions,
    },
    notes: [
      'All values are DERIVED from state.db (tasks + runs) for the stated window; nothing is estimated.',
      'Unavailable metrics are reported as available=false with a reason — never as 0.',
      'A/B/C = diag_rootcause / diag_distiller / diag_router; parentTaskId is parsed from the stage task id.',
    ],
  };
}
