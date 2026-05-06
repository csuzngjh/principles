/**
 * InternalizationOrchestrator — Core-owned Skeleton (PRI-68)
 *
 * Consumes hydrated PITaskRecords, applies state-machine decisions,
 * acquires leases through RuntimeStateManager, and proposes successor
 * tasks — WITHOUT executing LLM calls or calling peer runners.
 *
 * Design:
 *   - Single-step processing: wakeOnce() handles one task per call
 *   - Host (plugin CLI or heartbeat trigger) decides when to call
 *   - All task mutation goes through RuntimeStateManager (not direct store)
 *   - Pure orchestration: no timers, no LLM calls, no peer runner imports
 *
 * @see docs/adr/0003-peer-agent-state-machine-orchestration.md
 */

import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PeerRunnerKind } from './peer-runner-contracts.js';
import type { DependencyGateResult, NextTaskProposal } from './internalization-state-machine.js';
import { hydratePITaskRecord } from './pitask-metadata.js';
import { isPeerRunnerKind } from './peer-runner-contracts.js';
import {
  validateInternalizationTaskReady,
  createNextTaskProposal,
} from './internalization-state-machine.js';
import { PDRuntimeError } from '../error-categories.js';

// ── Result Types ─────────────────────────────────────────────────────────────

export interface NoReadyTasksResult {
  decision: 'no_ready_tasks';
  inspectedCount: number;
}

export interface BlockedResult {
  decision: 'blocked';
  taskId: string;
  taskKind: PeerRunnerKind;
  blockedBy: string[];
}

export interface DependencyFailedResult {
  decision: 'dependency_failed';
  taskId: string;
  taskKind: PeerRunnerKind;
  failedDependencies: string[];
}

export interface LeasedResult {
  decision: 'leased';
  taskId: string;
  taskKind: PeerRunnerKind;
  attemptCount: number;
}

export interface WouldLeaseResult {
  decision: 'would_lease';
  taskId: string;
  taskKind: PeerRunnerKind;
  gateResult: DependencyGateResult;
}

export interface LeaseConflictResult {
  decision: 'lease_conflict';
  taskId: string;
  conflictReason: string;
}

export interface InvalidTaskMetadataResult {
  decision: 'invalid_task_metadata';
  taskId: string;
  taskKind: string;
}

// Const array for runtime exhaustiveness checking (used in switch statements)
export const WAKE_ONCE_DECISIONS = [
  'no_ready_tasks',
  'blocked',
  'dependency_failed',
  'leased',
  'would_lease',
  'lease_conflict',
  'invalid_task_metadata',
] as const;

export type WakeOnceResult =
  | NoReadyTasksResult
  | BlockedResult
  | DependencyFailedResult
  | LeasedResult
  | WouldLeaseResult
  | LeaseConflictResult
  | InvalidTaskMetadataResult;

export interface ProposalCreatedResult {
  decision: 'proposal_created';
  taskId: string;
  taskKind: PeerRunnerKind;
  proposal: NextTaskProposal;
}

export type ProposeNextTaskResult = ProposalCreatedResult | null;

// ── Constructor Options ───────────────────────────────────────────────────────

export interface InternalizationOrchestratorOptions {
  /** Lease owner identifier (injected by host) */
  owner: string;
  /** Runtime kind for lease records */
  runtimeKind: string;
  /** If true, evaluate but do NOT acquire lease (inspection / dry-run mode) */
  dryRun?: boolean;
}

export interface InternalizationOrchestratorDeps {
  readonly stateManager: RuntimeStateManager;
}

// ── InternalizationOrchestrator ───────────────────────────────────────────────

export class InternalizationOrchestrator {
  private readonly owner: string;
  private readonly runtimeKind: string;
  private readonly dryRun: boolean;
  private readonly stateManager: RuntimeStateManager;

  constructor(deps: InternalizationOrchestratorDeps, options: InternalizationOrchestratorOptions) {
    this.stateManager = deps.stateManager;
    this.owner = options.owner;
    this.runtimeKind = options.runtimeKind;
    this.dryRun = options.dryRun ?? false;
  }

  // ── wakeOnce ──────────────────────────────────────────────────────────────

  /**
   * Find the first leasable PI task, validate dependencies, and acquire lease
   * (or return a structured decision without mutating state).
   *
   * Algorithm:
   *   1. listTasks(pending) → filter PeerRunnerKind → hydrate
   *   2. If none, try listTasks(retry_wait) for recovery candidates
   *   3. For first valid PITaskRecord, resolve dependencyTaskIds via getTask
   *   4. validateInternalizationTaskReady → branch on gate result
   *   5. On proceed + dryRun → would_lease; on proceed + !dryRun → acquireLease
   *   6. On lease_conflict PDRuntimeError → structured LeaseConflictResult
   */
  async wakeOnce(): Promise<WakeOnceResult> {
    const candidates = await this.findCandidates();
    let inspectedCount = candidates.length;

    for (const rawTask of candidates) {
      const piTask = hydratePITaskRecord(rawTask);

      if (!piTask) {
        // Hydration failed — invalid PI metadata
        return {
          decision: 'invalid_task_metadata',
          taskId: rawTask.taskId,
          taskKind: rawTask.taskKind,
        };
      }

      // Resolve all dependency records
      const dependencies = await this.resolveDependencies(piTask.dependencyTaskIds);

      // Evaluate dependency gate
      const gateResult = validateInternalizationTaskReady(piTask, dependencies);

      if (gateResult.decision === 'blocked') {
        return {
          decision: 'blocked',
          taskId: piTask.taskId,
          taskKind: piTask.taskKind,
          blockedBy: gateResult.blockedBy,
        };
      }

      if (gateResult.decision === 'dependency_failed') {
        return {
          decision: 'dependency_failed',
          taskId: piTask.taskId,
          taskKind: piTask.taskKind,
          failedDependencies: gateResult.failedDependencies,
        };
      }

      // gateResult.decision === 'proceed'
      if (this.dryRun) {
        return {
          decision: 'would_lease',
          taskId: piTask.taskId,
          taskKind: piTask.taskKind,
          gateResult,
        };
      }

      // Actually attempt to acquire the lease
      try {
        const leased = await this.stateManager.acquireLease({
          taskId: piTask.taskId,
          owner: this.owner,
          runtimeKind: this.runtimeKind,
        });
        return {
          decision: 'leased',
          taskId: leased.taskId,
          taskKind: piTask.taskKind,
          attemptCount: leased.attemptCount,
        };
      } catch (error) {
        if (error instanceof PDRuntimeError && error.category === 'lease_conflict') {
          return {
            decision: 'lease_conflict',
            taskId: piTask.taskId,
            conflictReason: error.message,
          };
        }
        // Re-throw with task context for correlation
        const pdError = error instanceof PDRuntimeError ? error : new PDRuntimeError('runtime_unavailable', String(error));
        throw new PDRuntimeError(
          pdError.category ?? 'runtime_unavailable',
          `wakeOnce lease acquisition failed for task ${piTask.taskId}: ${pdError.message}`,
          { cause: error }
        );
      }
    }

    return {
      decision: 'no_ready_tasks',
      inspectedCount,
    };
  }

  // ── proposeNextTask ──────────────────────────────────────────────────────

  /**
   * Generate a successor task proposal for a succeeded task.
   *
   * Does NOT create the task — the caller decides whether to persist
   * the proposal via RuntimeStateManager.createTask().
   *
   * Returns null if:
   *   - Task not found
   *   - Task not a valid PITaskRecord (hydration fails)
   *   - Task status is not 'succeeded'
   *   - No valid successor exists in the job graph
   */
  async proposeNextTask(taskId: string): Promise<ProposeNextTaskResult> {
    const rawTask = await this.stateManager.getTask(taskId);
    if (!rawTask) {
      return null;
    }

    const piTask = hydratePITaskRecord(rawTask);
    if (!piTask) {
      return null;
    }

    // Guard against non-PI task kinds (would cause getAllowedSuccessors to return undefined)
    if (!isPeerRunnerKind(piTask.taskKind)) {
      return null;
    }

    if (piTask.status !== 'succeeded') {
      return null;
    }

    const proposal = createNextTaskProposal(piTask, []);
    if (!proposal) {
      return null;
    }

    return {
      decision: 'proposal_created',
      taskId: piTask.taskId,
      taskKind: piTask.taskKind,
      proposal,
    };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Find candidate PI tasks by querying pending and retry_wait statuses.
   * Filters to only PeerRunnerKind taskKinds and hydrates to PITaskRecord.
   */
  private async findCandidates(): Promise<TaskRecord[]> {
    const allCandidates: TaskRecord[] = [];
    try {
      const pending = await this.stateManager.listTasks({ status: 'pending' });
      const retryWait = await this.stateManager.listTasks({ status: 'retry_wait' });
      allCandidates.push(...pending, ...retryWait);
    } catch (error) {
      if (error instanceof PDRuntimeError) throw error;
      throw new PDRuntimeError('runtime_unavailable', 'findCandidates failed', { cause: error });
    }

    // Filter to PeerRunnerKind tasks only (skip diagnostician, etc.)
    const peerTasks = allCandidates.filter(t => isPeerRunnerKind(t.taskKind));

    return peerTasks;
  }

  /**
   * Resolve an array of dependency task IDs into TaskRecord instances.
   * Missing tasks (not yet created) are excluded from the result — this
   * causes validateInternalizationTaskReady to fail closed (treat as blocked).
   */
  private async resolveDependencies(depIds: readonly string[]): Promise<TaskRecord[]> {
    if (depIds.length === 0) {
      return [];
    }

    // Use allSettled so one bad depId doesn't kill the entire resolution
    const results = await Promise.allSettled(
      depIds.map(depId => this.stateManager.getTask(depId))
    );

    return results
      .filter((r): r is PromiseFulfilledResult<TaskRecord | null> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((t): t is TaskRecord => t !== null);
  }
}
