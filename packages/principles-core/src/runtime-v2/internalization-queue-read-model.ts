/**
 * InternalizationQueueReadModel — Read-only snapshot of PI task queue health (PRI-73).
 *
 * Provides a statistical snapshot of all pending/retry_wait PI tasks:
 *   - counts by taskKind / channel / status
 *   - invalid metadata samples (hydration failures)
 *   - blocked dependency samples
 *   - dependency_failed samples
 *   - ready task list
 *   - no_ready_tasks diagnosis
 *
 * All counts and aggregations are scoped to PI peer-runner tasks only
 * (excludes diagnostician, evaluator_janitor, and other non-peer-runner kinds).
 * This is a READ-ONLY model — it never acquires leases or mutates state.
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */
import type { TaskRecord } from './task-status.js';
import type { RuntimeStateHandle } from './runtime-state-handle.js';
import { createRuntimeStateHandle } from './runtime-state-handle.js';
import type { RunnerKind, InternalizationChannel } from './internalization/peer-runner-contracts.js';
import { isRunnerKind } from './internalization/peer-runner-contracts.js';
import { hydratePITaskRecord } from './internalization/pitask-metadata.js';
import { validateInternalizationTaskReady } from './internalization/internalization-state-machine.js';
import { isUnresolvable } from './internalization/internalization-task-guards.js';
import { classifyTaskActionability, type ActionabilityPolicyInput, MVP_CORE_TASK_KINDS, type SuppressedDiagnostic } from './internalization/queue-actionability.js';

// ── Output types ────────────────────────────────────────────────────────────

export interface BlockedSample {
  taskId: string;
  taskKind: RunnerKind;
  blockedBy: string[];
}

export interface DependencyFailedSample {
  taskId: string;
  taskKind: RunnerKind;
  failedDependencies: string[];
}

export interface ReadyTask {
  taskId: string;
  taskKind: RunnerKind;
  channel: InternalizationChannel;
}

export type QueueNoReadyTasksReason =
  | 'no_candidates'
  | 'all_hydration_failed'
  | 'all_blocked'
  | 'all_dependency_failed'
  | 'all_retry_wait_pending'
  | 'all_lease_conflict'
  | 'all_unresolvable';

export interface NoReadyTasksDiagnosis {
  reason: QueueNoReadyTasksReason;
  inspectedCount: number;
}

export interface RetryWaitPendingSample {
  taskId: string;
  taskKind: RunnerKind;
  retryAfter: string;
}

export interface LeaseConflictSample {
  taskId: string;
  taskKind: RunnerKind;
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface UnresolvableSample {
  taskId: string;
  taskKind: RunnerKind;
  rejectionCount: number;
}

export interface InternalizationQueueSnapshot {
  pendingCount: number;
  retryWaitCount: number;
  countsByTaskKind: Record<string, number>;
  countsByChannel: Record<string, number>;
  invalidMetadataCount: number;
  sampleInvalidTaskIds: string[];
  blockedSummary: { count: number; samples: BlockedSample[] };
  dependencyFailedSummary: { count: number; samples: DependencyFailedSample[] };
  leaseConflictSummary: { count: number; samples: LeaseConflictSample[]; sampleTaskIds: string[] };
  retryWaitPendingSummary: { count: number; samples: RetryWaitPendingSample[] };
  unresolvableSummary: { count: number; samples: UnresolvableSample[] };
  readyTasks: ReadyTask[];
  noReadyTasks: NoReadyTasksDiagnosis | null;
  /** Tasks suppressed from the actionable queue — disabled channels or non-MVP task kinds */
  suppressedTasks: SuppressedDiagnostic[];
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_SAMPLES = 3;

function hasUnexpiredLease(
  task: { status: string; leaseOwner?: string; leaseExpiresAt?: string },
  nowMs: number,
): boolean {
  if (task.status !== 'pending') return false;
  if (!task.leaseOwner || !task.leaseExpiresAt) return false;
  const leaseExpiresAtMs = new Date(task.leaseExpiresAt).getTime();
  if (Number.isNaN(leaseExpiresAtMs)) return false;
  return leaseExpiresAtMs > nowMs;
}

// ── Read Model ───────────────────────────────────────────────────────────────

export class InternalizationQueueReadModel {
  private policy: ActionabilityPolicyInput | null = null;

  constructor(private readonly stateManager: RuntimeStateHandle['stateManager']) {}

  setPolicy(policy: ActionabilityPolicyInput): void {
    this.policy = policy;
  }

  async getSnapshot(): Promise<InternalizationQueueSnapshot> {
    const [pending, retryWait] = await Promise.all([
      this.stateManager.listTasks({ status: 'pending' }),
      this.stateManager.listTasks({ status: 'retry_wait' }),
    ]);

    // Filter to RunnerKind tasks — includes both PeerRunnerKind and DiagnosticianStageKind
    const runnerTasks = [...pending, ...retryWait].filter(t => isRunnerKind(t.taskKind));

    let pendingCount = 0;
    let retryWaitCount = 0;

    // Accumulators (actionable-only, except invalidMetadata which is always visible)
    const countsByTaskKind: Record<string, number> = {};
    const countsByChannel: Record<string, number> = {};
    let invalidMetadataCount = 0;
    const sampleInvalidTaskIds: string[] = [];
    const blockedSamples: BlockedSample[] = [];
    const dependencyFailedSamples: DependencyFailedSample[] = [];
    const leaseConflictSamples: LeaseConflictSample[] = [];
    const retryWaitPendingSamples: RetryWaitPendingSample[] = [];
    const unresolvableSamples: UnresolvableSample[] = [];
    const readyTasks: ReadyTask[] = [];
    const suppressedTasks: SuppressedDiagnostic[] = [];

    let hydrationFailures = 0;
    let blockedCount = 0;
    let dependencyFailures = 0;
    let leaseConflicts = 0;
    let retryWaitPendingCount = 0;
    let unresolvableCount = 0;
    let actionableInspected = 0;

    const nowMs = Date.now();

    for (const rawTask of runnerTasks) {
      const piTask = hydratePITaskRecord(rawTask);

      if (!piTask) {
        // Malformed metadata — always visible, always can degrade
        invalidMetadataCount++;
        hydrationFailures++;
        if (sampleInvalidTaskIds.length < MAX_SAMPLES) {
          sampleInvalidTaskIds.push(rawTask.taskId);
        }
        continue;
      }

      // Apply actionability policy IMMEDIATELY after successful hydration.
      // Suppressed tasks go to diagnostics only — they do NOT participate in
      // actionable counts, dependency blocking, no-ready reason, or canary health.
      if (this.policy) {
        const classification = classifyTaskActionability(
          { taskId: piTask.taskId, taskKind: piTask.taskKind, channel: piTask.channel },
          this.policy,
        );
        if (!classification.actionable) {
          suppressedTasks.push(classification.diagnostic);
          continue;
        }
      }

      // ── Everything below is actionable-only ──────────────────────────────────

      actionableInspected++;
      if (piTask.status === 'pending') pendingCount++;
      else if (piTask.status === 'retry_wait') retryWaitCount++;

      countsByTaskKind[piTask.taskKind] = (countsByTaskKind[piTask.taskKind] ?? 0) + 1;
      countsByChannel[piTask.channel] = (countsByChannel[piTask.channel] ?? 0) + 1;

      if (hasUnexpiredLease(piTask, nowMs)) {
        leaseConflicts++;
        if (leaseConflictSamples.length < MAX_SAMPLES) {
          leaseConflictSamples.push({
            taskId: piTask.taskId,
            taskKind: piTask.taskKind,
            leaseOwner: piTask.leaseOwner ?? '',
            leaseExpiresAt: piTask.leaseExpiresAt ?? '',
          });
        }
        continue;
      }

      if (isUnresolvable(piTask)) {
        unresolvableCount++;
        if (unresolvableSamples.length < MAX_SAMPLES) {
          unresolvableSamples.push({
            taskId: piTask.taskId,
            taskKind: piTask.taskKind,
            rejectionCount: piTask.rejectionCount,
          });
        }
        continue;
      }

      // Resolve dependencies for gate evaluation
      const dependencies = await this.resolveDependencies(piTask.dependencyTaskIds);
      const gateResult = validateInternalizationTaskReady(piTask, dependencies, nowMs);

      if (gateResult.decision === 'retry_wait_pending') {
        retryWaitPendingCount++;
        if (retryWaitPendingSamples.length < MAX_SAMPLES) {
          retryWaitPendingSamples.push({
            taskId: piTask.taskId,
            taskKind: piTask.taskKind,
            retryAfter: gateResult.retryAfter ?? piTask.leaseExpiresAt ?? '',
          });
        }
        continue;
      }

      if (gateResult.decision === 'blocked') {
        blockedCount++;
        if (blockedSamples.length < MAX_SAMPLES) {
          blockedSamples.push({ taskId: piTask.taskId, taskKind: piTask.taskKind, blockedBy: gateResult.blockedBy });
        }
        continue;
      }

      if (gateResult.decision === 'dependency_failed') {
        dependencyFailures++;
        if (dependencyFailedSamples.length < MAX_SAMPLES) {
          dependencyFailedSamples.push({
            taskId: piTask.taskId,
            taskKind: piTask.taskKind,
            failedDependencies: gateResult.failedDependencies,
          });
        }
        continue;
      }

      // decision === 'proceed' — task passed dependency gate, actionable
      readyTasks.push({ taskId: piTask.taskId, taskKind: piTask.taskKind, channel: piTask.channel });
    }

    // Determine noReadyTasks reason using dominance logic (same as orchestrator)
    // inspectedCount includes actionable tasks AND malformed tasks (always visible).
    // Clean suppressed tasks are excluded — they're not actionable and not broken.
    const inspectedCount = actionableInspected + hydrationFailures;
    let noReadyTasks: InternalizationQueueSnapshot['noReadyTasks'] = null;

    if (readyTasks.length === 0) {
      // Empty queue: no candidates at all — must be no_candidates regardless of counts
      if (inspectedCount === 0) {
        noReadyTasks = { reason: 'no_candidates', inspectedCount };
      } else {
        const reason: QueueNoReadyTasksReason =
          unresolvableCount > 0 && unresolvableCount >= hydrationFailures && unresolvableCount >= dependencyFailures && unresolvableCount >= blockedCount && unresolvableCount >= retryWaitPendingCount && unresolvableCount >= leaseConflicts
            ? 'all_unresolvable'
            : retryWaitPendingCount > 0 && retryWaitPendingCount >= hydrationFailures && retryWaitPendingCount >= dependencyFailures && retryWaitPendingCount >= blockedCount
              ? 'all_retry_wait_pending'
              : leaseConflicts > 0 && leaseConflicts >= hydrationFailures && leaseConflicts >= dependencyFailures && leaseConflicts >= blockedCount
                ? 'all_lease_conflict'
                : hydrationFailures > 0 && hydrationFailures >= dependencyFailures && hydrationFailures >= blockedCount
                  ? 'all_hydration_failed'
                  : dependencyFailures >= blockedCount
                    ? 'all_dependency_failed'
                    : 'all_blocked';
        noReadyTasks = { reason, inspectedCount };
      }
    }

    return {
      pendingCount,
      retryWaitCount,
      countsByTaskKind,
      countsByChannel,
      invalidMetadataCount,
      sampleInvalidTaskIds,
      blockedSummary: { count: blockedCount, samples: blockedSamples },
      dependencyFailedSummary: { count: dependencyFailures, samples: dependencyFailedSamples },
      leaseConflictSummary: {
        count: leaseConflicts,
        samples: leaseConflictSamples,
        sampleTaskIds: leaseConflictSamples.map((sample) => sample.taskId),
      },
      retryWaitPendingSummary: { count: retryWaitPendingCount, samples: retryWaitPendingSamples },
      unresolvableSummary: { count: unresolvableCount, samples: unresolvableSamples },
      readyTasks,
      noReadyTasks,
      suppressedTasks,
    };
  }

  private async resolveDependencies(depIds: readonly string[]): Promise<TaskRecord[]> {
    if (depIds.length === 0) return [];
    const results = await Promise.allSettled(depIds.map(id => this.stateManager.getTask(id)));
    return results
      .filter((r): r is PromiseFulfilledResult<TaskRecord | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((t): t is TaskRecord => t !== null);
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this
  async close(): Promise<void> {
    // No-op: RuntimeStateManager lifecycle managed by caller
  }
}

export interface InternalizationQueueReadModelHandle {
  readModel: InternalizationQueueReadModel;
  close: () => Promise<void>;
}

export interface CreateQueueReadModelOptions {
  workspaceDir: string;
  readonly?: boolean;
  /** Enabled activation channels — loaded from feature flags at CLI boundary */
  enabledChannels?: Set<string>;
}

export async function createInternalizationQueueReadModel(
  opts: CreateQueueReadModelOptions,
): Promise<InternalizationQueueReadModelHandle> {
  const handle = await createRuntimeStateHandle({ workspaceDir: opts.workspaceDir, readonly: opts.readonly });
  const readModel = new InternalizationQueueReadModel(handle.stateManager);
  readModel.setPolicy({
    enabledChannels: opts.enabledChannels ?? new Set(['prompt', 'code_tool_hook', 'defer_archive']),
    actionableTaskKinds: new Set(MVP_CORE_TASK_KINDS),
  });
  return {
    readModel,
    close: handle.close,
  };
}
