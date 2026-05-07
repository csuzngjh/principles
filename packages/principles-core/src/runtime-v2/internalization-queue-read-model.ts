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
 * This is a READ-ONLY model — it never acquires leases or mutates state.
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */
import type { TaskRecord } from './task-status.js';
import type { RuntimeStateManager } from './store/runtime-state-manager.js';
import type { PeerRunnerKind, InternalizationChannel } from './internalization/peer-runner-contracts.js';
import { isPeerRunnerKind } from './internalization/peer-runner-contracts.js';
import { hydratePITaskRecord } from './internalization/pitask-metadata.js';
import { validateInternalizationTaskReady } from './internalization/internalization-state-machine.js';

// ── Output types ────────────────────────────────────────────────────────────

export interface BlockedSample {
  taskId: string;
  taskKind: PeerRunnerKind;
  blockedBy: string[];
}

export interface DependencyFailedSample {
  taskId: string;
  taskKind: PeerRunnerKind;
  failedDependencies: string[];
}

export interface ReadyTask {
  taskId: string;
  taskKind: PeerRunnerKind;
  channel: InternalizationChannel;
}

export interface NoReadyTasksDiagnosis {
  reason: 'no_candidates' | 'all_hydration_failed' | 'all_blocked' | 'all_dependency_failed' | 'all_lease_conflict';
  inspectedCount: number;
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
  readyTasks: ReadyTask[];
  noReadyTasks: NoReadyTasksDiagnosis | null;
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_SAMPLES = 3;

// ── Read Model ───────────────────────────────────────────────────────────────

export class InternalizationQueueReadModel {
  constructor(private readonly stateManager: RuntimeStateManager) {}

  async getSnapshot(): Promise<InternalizationQueueSnapshot> {
    const [pending, retryWait] = await Promise.all([
      this.stateManager.listTasks({ status: 'pending' }),
      this.stateManager.listTasks({ status: 'retry_wait' }),
    ]);

    const pendingCount = pending.length;
    const retryWaitCount = retryWait.length;

    // Filter to PeerRunnerKind tasks
    const peerTasks = [...pending, ...retryWait].filter(t => isPeerRunnerKind(t.taskKind));

    // Accumulators
    const countsByTaskKind: Record<string, number> = {};
    const countsByChannel: Record<string, number> = {};
    let invalidMetadataCount = 0;
    const sampleInvalidTaskIds: string[] = [];
    const blockedSamples: BlockedSample[] = [];
    const dependencyFailedSamples: DependencyFailedSample[] = [];
    const readyTasks: ReadyTask[] = [];

    let hydrationFailures = 0;
    let blockedCount = 0;
    let dependencyFailures = 0;

    for (const rawTask of peerTasks) {
      const piTask = hydratePITaskRecord(rawTask);

      if (!piTask) {
        invalidMetadataCount++;
        hydrationFailures++;
        if (sampleInvalidTaskIds.length < MAX_SAMPLES) {
          sampleInvalidTaskIds.push(rawTask.taskId);
        }
        continue;
      }

      // Aggregate counts
      countsByTaskKind[piTask.taskKind] = (countsByTaskKind[piTask.taskKind] ?? 0) + 1;
      countsByChannel[piTask.channel] = (countsByChannel[piTask.channel] ?? 0) + 1;

      // Resolve dependencies for gate evaluation
      const dependencies = await this.resolveDependencies(piTask.dependencyTaskIds);
      const gateResult = validateInternalizationTaskReady(piTask, dependencies);

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

      // decision === 'proceed' — task is ready to lease
      readyTasks.push({ taskId: piTask.taskId, taskKind: piTask.taskKind, channel: piTask.channel });
    }

    // Determine noReadyTasks reason using dominance logic (same as orchestrator)
    const inspectedCount = peerTasks.length;
    let noReadyTasks: InternalizationQueueSnapshot['noReadyTasks'] = null;

    if (readyTasks.length === 0) {
      const reason: NoReadyTasksDiagnosis['reason'] =
        hydrationFailures > 0 && hydrationFailures >= dependencyFailures && hydrationFailures >= blockedCount
          ? 'all_hydration_failed'
          : dependencyFailures >= blockedCount
            ? 'all_dependency_failed'
            : blockedCount > 0
              ? 'all_blocked'
              : 'no_candidates';
      noReadyTasks = { reason, inspectedCount };
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
      readyTasks,
      noReadyTasks,
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
