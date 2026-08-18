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

import type { TaskRecord, PDTaskStatus } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { RunnerKind } from './peer-runner-contracts.js';
import type { DependencyGateResult, NextTaskProposal } from './internalization-state-machine.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata } from './pitask-metadata.js';
import type { PITaskMetadata } from './pitask-metadata.js';
import { isPeerRunnerKind, isDiagnosticianStageKind, isRunnerKind } from './peer-runner-contracts.js';
import {
  validateInternalizationTaskReady,
  createNextTaskProposal,
} from './internalization-state-machine.js';
import { getDiagSuccessors } from './internalization-job-graph.js';
import {
  decideInternalizationTransition,
  transitionInputFromTask,
} from './internalization-transition-decision.js';
import { PDRuntimeError } from '../error-categories.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip a trailing `-<channel>` segment from a task id so that re-appending
 * `-${channel}` does not accumulate duplicates.
 *
 * Used as a fallback when proposal.correlationId is unavailable (e.g. legacy
 * diagnostician-chain seeds). Example: `dreamer-cand-1-prompt` + channel
 * `prompt` → `dreamer-cand-1`.
 *
 * Guarded: only strips when the suffix EXACTLY matches the channel, so task ids
 * that merely contain the channel substring elsewhere are left intact.
 */
function stripTrailingChannel(taskId: string, channel: string | undefined): string {
  if (!channel) return taskId;
  const suffix = `-${channel}`;
  return taskId.endsWith(suffix) ? taskId.slice(0, taskId.length - suffix.length) : taskId;
}

// ── Result Types ─────────────────────────────────────────────────────────────

export interface NoReadyTasksResult {
  decision: 'no_ready_tasks';
  inspectedCount: number;
  /** Why no task could be leased: specific diagnosis */
  reason: 'no_candidates' | 'filtered_out' | 'all_hydration_failed' | 'all_blocked' | 'all_dependency_failed' | 'all_lease_conflict' | 'all_retry_wait_pending';
}

export interface BlockedResult {
  decision: 'blocked';
  taskId: string;
  taskKind: RunnerKind;
  blockedBy: string[];
}

export interface DependencyFailedResult {
  decision: 'dependency_failed';
  taskId: string;
  taskKind: RunnerKind;
  failedDependencies: string[];
}

export interface LeasedResult {
  decision: 'leased';
  taskId: string;
  taskKind: RunnerKind;
  attemptCount: number;
}

export interface WouldLeaseResult {
  decision: 'would_lease';
  taskId: string;
  taskKind: RunnerKind;
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

/**
 * Runtime decision labels for WakeOnceResult — used by host layers for
 * logging, metrics bucketing, and switch-statement exhaustiveness checks.
 * @experimental — consumed at runtime only; not used by the TypeScript
 * type system (discriminated union handles compile-time exhaustiveness).
 */
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
  taskKind: RunnerKind;
  proposal: NextTaskProposal;
}

export type ProposeNextTaskResult = ProposalCreatedResult | null;

// ── Commit Next Task Result Types (PRI-88) ────────────────────────────────────

export type CommitNextTaskResult =
  | { decision: 'successor_created'; sourceTaskId: string; successorTaskId: string; successorKind: RunnerKind }
  | { decision: 'successor_exists'; sourceTaskId: string; successorTaskId: string; successorKind: RunnerKind }
  | { decision: 'no_successor'; sourceTaskId: string; reason: string }
  | { decision: 'invalid_task_metadata'; taskId: string; reason: string }
  | { decision: 'source_not_succeeded'; taskId: string; status: PDTaskStatus }
  | { decision: 'task_not_found'; taskId: string }
  /** INV-02: needs_revision — 不 seed 正常后继 (revision 由 runner 侧 repair/reopen 承担) */
  | { decision: 'blocked_by_revision'; sourceTaskId: string; reason: string; runnerDecision: string }
  /** INV-04: rejected — 终态拒绝, 无后继无 approval */
  | { decision: 'blocked_by_rejection'; sourceTaskId: string; reason: string; runnerDecision: string }
  /** artificer repair 任务完成 → 来源 evaluator 被 reopen 重跑修订轮 */
  | { decision: 'revision_reopened'; sourceTaskId: string; reopenedTaskId: string; reason: string }
  /** revision 波及下游: 已存在的 succeeded 后继被 reopen 重跑 (级联修订) */
  | { decision: 'successor_reopened'; sourceTaskId: string; reopenedTaskId: string; successorKind: RunnerKind };

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
    if (!options.owner || !options.runtimeKind) {
      throw new PDRuntimeError('input_invalid', 'InternalizationOrchestrator requires non-empty owner and runtimeKind');
    }
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
  async wakeOnce(taskKind?: RunnerKind): Promise<WakeOnceResult> {
    const candidates = await this.findCandidates(taskKind);
    const inspectedCount = candidates.length;

    if (inspectedCount === 0) {
      const allPeerCount = taskKind ? (await this.findCandidates()).length : 0;
      return {
        decision: 'no_ready_tasks',
        inspectedCount: 0,
        reason: allPeerCount > 0 ? 'filtered_out' : 'no_candidates',
      };
    }

    let hydrationFailures = 0;
    let blockedCount = 0;
    let dependencyFailures = 0;
    let retryWaitPendingCount = 0;
    let leaseConflictCount = 0;

    for (const rawTask of candidates) {
      const piTask = hydratePITaskRecord(rawTask);

      if (!piTask) {
        // Hydration failed — invalid PI metadata, skip and try next candidate
        hydrationFailures++;
        continue;
      }

      // Resolve all dependency records
      const dependencies = await this.resolveDependencies(piTask.dependencyTaskIds);

      // Evaluate dependency gate
      const gateResult = validateInternalizationTaskReady(piTask, dependencies);

      if (gateResult.decision === 'blocked') {
        // Non-terminal — skip and try next candidate
        blockedCount++;
        continue;
      }

      if (gateResult.decision === 'dependency_failed') {
        // Non-terminal — skip and try next candidate
        dependencyFailures++;
        continue;
      }

      if (gateResult.decision === 'retry_wait_pending') {
        retryWaitPendingCount++;
        continue;
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
          // Non-terminal — skip and try next candidate
          leaseConflictCount++;
          continue;
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

    // All candidates exhausted — determine dominant failure mode for diagnosis
    // Dominant mode: pick the failure type with the highest count; ties broken
    // by specificity priority (hydration > dependency > blocked > lease).
    // Hydration participates when it is the highest count (not just 100%).
    const reason: NoReadyTasksResult['reason'] =
      retryWaitPendingCount > 0 && retryWaitPendingCount >= hydrationFailures && retryWaitPendingCount >= dependencyFailures && retryWaitPendingCount >= blockedCount && retryWaitPendingCount >= leaseConflictCount
        ? 'all_retry_wait_pending'
        : hydrationFailures > 0 && hydrationFailures >= dependencyFailures && hydrationFailures >= blockedCount && hydrationFailures >= leaseConflictCount
          ? 'all_hydration_failed'
          : dependencyFailures >= blockedCount && dependencyFailures >= leaseConflictCount
            ? 'all_dependency_failed'
            : blockedCount >= leaseConflictCount
              ? 'all_blocked'
              : leaseConflictCount > 0
                ? 'all_lease_conflict'
                : 'no_candidates';

    return {
      decision: 'no_ready_tasks',
      inspectedCount,
      reason,
    };
  }

  // ── proposeNextTask ──────────────────────────────────────────────────────

  /**
   * Generate a successor task proposal for a succeeded task.
   *
   * Does NOT create the task — the caller decides whether to persist
   * the proposal via RuntimeStateManager.createTask().
   *
   * Note: existingTasks is hardcoded to [] — the host layer is responsible
   * for deduplicating proposals against tasks already in the queue before
   * calling createTask().
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

    if (piTask.status !== 'succeeded') {
      return null;
    }

    // Diagnostician chain: use getDiagSuccessors instead of peer runner job graph
    if (isDiagnosticianStageKind(piTask.taskKind)) {
      const diagSuccessors = getDiagSuccessors(piTask.taskKind);
      if (diagSuccessors.length === 0) {
        // diag_router is terminal — no successor
        return null;
      }
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const nextKind = diagSuccessors[0]!;
      return {
        decision: 'proposal_created',
        taskId: piTask.taskId,
        taskKind: piTask.taskKind,
        proposal: {
          taskKind: nextKind,
          parentTaskId: piTask.taskId,
          dependencyTaskIds: [piTask.taskId],
          inputArtifactRefs: [...piTask.outputArtifactRefs],
          channel: piTask.channel,
          correlationId: piTask.correlationId,
        },
      };
    }

    // Guard against non-PI task kinds (would cause getAllowedSuccessors to return undefined)
    if (!isPeerRunnerKind(piTask.taskKind)) {
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

  // ── commitNextTaskProposal ──────────────────────────────────────────────

  /**
   * Commit a successor task proposal for a succeeded source task.
   *
   * Idempotent: if a matching successor already exists (same parentTaskId +
   * successorKind + channel), returns successor_exists without creating a duplicate.
   *
   * Steps:
   *   1. getTask(taskId) → null → task_not_found
   *   2. hydratePITaskRecord(task) → null → invalid_task_metadata
   *   3. task.status !== 'succeeded' → source_not_succeeded
   *   4. proposeNextTask(taskId) → null → no_successor
   *   5. Deduplicate: scan pending tasks for matching successor
   *   6. Found → successor_exists
   *   7. Not found → createTask + write PI metadata → successor_created
   */
  async commitNextTaskProposal(taskId: string): Promise<CommitNextTaskResult> {
    const rawTask = await this.stateManager.getTask(taskId);
    if (!rawTask) {
      return { decision: 'task_not_found', taskId };
    }

    const piTask = hydratePITaskRecord(rawTask);
    if (!piTask) {
      return { decision: 'invalid_task_metadata', taskId, reason: 'Failed to hydrate PITaskRecord from diagnosticJson' };
    }

    // ── 单一迁移决策 (P0-D, INV-02) ──
    // runner 的 verdict 与状态迁移在此仲裁: needs_revision/rejected 不 seed
    // 正常后继; artificer repair 完成 reopen 来源 evaluator。
    const transition = decideInternalizationTransition(transitionInputFromTask(piTask));
    if (transition.kind === 'HUMAN_REVIEW_REQUIRED') {
      return { decision: 'source_not_succeeded', taskId, status: piTask.status };
    }
    if (transition.kind === 'NOT_ADVANCEABLE') {
      return { decision: 'source_not_succeeded', taskId, status: piTask.status };
    }
    if (transition.kind === 'REVISION_REQUIRED') {
      return {
        decision: 'blocked_by_revision',
        sourceTaskId: taskId,
        reason: transition.reason,
        runnerDecision: piTask.runnerDecision ?? 'unknown',
      };
    }
    if (transition.kind === 'TERMINAL_REJECT') {
      return {
        decision: 'blocked_by_rejection',
        sourceTaskId: taskId,
        reason: transition.reason,
        runnerDecision: piTask.runnerDecision ?? 'unknown',
      };
    }
    if (transition.kind === 'REOPEN_SOURCE_EVALUATOR' && piTask.repairPayload) {
      const reopened = await this.reopenTaskForRevision(piTask.repairPayload.sourceEvaluatorTaskId, {
        replaceArtificerDependencyWith: taskId,
        reason: 'artificer_repair_complete',
      });
      if (!reopened.ok) {
        // reopen 失败 (evaluator 缺失/状态不可 reopen) — 不 seed 正常后继,
        // 结构化返回让 host 层观测 (rc-9)。
        return { decision: 'no_successor', sourceTaskId: taskId, reason: `evaluator_reopen_failed:${reopened.reason}` };
      }
      return {
        decision: 'revision_reopened',
        sourceTaskId: taskId,
        reopenedTaskId: piTask.repairPayload.sourceEvaluatorTaskId,
        reason: transition.reason,
      };
    }
    // transition.kind === 'ADVANCE' → 正常推进

    if (piTask.status !== 'succeeded') {
      return { decision: 'source_not_succeeded', taskId, status: piTask.status };
    }

    const proposalResult = await this.proposeNextTask(taskId);
    if (!proposalResult) {
      return { decision: 'no_successor', sourceTaskId: taskId, reason: 'No valid successor in job graph for this task kind and channel' };
    }

    const {proposal} = proposalResult;

    const existingSuccessor = await this.findExistingSuccessor(taskId, proposal.taskKind, proposal.channel);
    if (existingSuccessor) {
      return {
        decision: 'successor_exists',
        sourceTaskId: taskId,
        successorTaskId: existingSuccessor.taskId,
        successorKind: proposal.taskKind,
      };
    }

    // Successor taskId must be STABLE across the whole peer-runner chain so that
    // every layer (dreamer/philosopher/scribe/artificer/evaluator) derives its id
    // from the SAME root, not from the predecessor's full id (which already
    // carries the channel suffix). Building from the source taskId caused the
    // channel suffix to accumulate on every hop:
    //   dreamer-<cand>-prompt → philosopher-dreamer-<cand>-prompt-prompt
    //                        → scribe-philosopher-dreamer-<cand>-prompt-prompt-prompt
    // and the scribe/evaluator output validators (which echo the task id they
    // received) then mismatched the DB id, breaking scribe→artificer→evaluator.
    //
    // Root = proposal.correlationId (the original candidateId set at intake,
    // see intake-to-internalization-bridge.ts). It is channel-free and identical
    // for every successor in the chain, so `${kind}-${root}-${channel}` is stable.
    // Fallback: when correlationId is absent (diagnostician chain seeds it as
    // undefined), use the source taskId but strip a trailing `-<channel>` so we
    // don't re-append the channel we are about to add back.
    const successorRoot = proposal.correlationId
      ?? stripTrailingChannel(taskId, proposal.channel);
    // Omit the channel segment entirely when it is absent, so the id never
    // ends with a literal "-undefined". (No current code path reaches here
    // with channel=undefined — the diagnostician chain terminates at
    // diag_router which has no successor — but this keeps the invariant
    // defensive rather than relying on that fact staying true.)
    const successorTaskId = proposal.channel
      ? `${proposal.taskKind}-${successorRoot}-${proposal.channel}`
      : `${proposal.taskKind}-${successorRoot}`;

    // ── 级联 reopen (revision wave) ──
    // 稳定 id 后继已存在且为 succeeded: 仅当源任务经历过 revision
    // (revisionCount > 0, 即上游被 reopen 后重新完成)时, 下游才必须重跑
    // (而非 successor_exists 停摆)。普通幂等重扫 (revisionCount=0) 不级联,
    // 保持既有 successor_exists 语义。pending/retry_wait 的存在后继仍走
    // findExistingSuccessor 的 successor_exists 分支。
    const existingById = (piTask.revisionCount ?? 0) > 0
      ? await this.stateManager.getTask(successorTaskId)
      : null;
    if (existingById && (existingById.status === 'succeeded' || existingById.status === 'needs_human_review')) {
      const reopened = await this.reopenTaskForRevision(successorTaskId, {
        reason: 'upstream_revision_cascade',
      });
      if (reopened.ok) {
        return {
          decision: 'successor_reopened',
          sourceTaskId: taskId,
          reopenedTaskId: successorTaskId,
          successorKind: proposal.taskKind,
        };
      }
      return {
        decision: 'successor_exists',
        sourceTaskId: taskId,
        successorTaskId,
        successorKind: proposal.taskKind,
      };
    }
    if (existingById) {
      // leased / retry_wait / pending(经直查而非 findExistingSuccessor 命中) — 在途,不重复处理
      return {
        decision: 'successor_exists',
        sourceTaskId: taskId,
        successorTaskId,
        successorKind: proposal.taskKind,
      };
    }

    const successorMetadata: PITaskMetadata = {
      dependencyTaskIds: proposal.dependencyTaskIds,
      channel: proposal.channel,
      timeoutMs: 300_000,
      inputArtifactRefs: proposal.inputArtifactRefs,
      outputArtifactRefs: [],
      parentTaskId: proposal.parentTaskId,
      correlationId: proposal.correlationId,
    };

     
    let successorRecord: TaskRecord;
    try {
      successorRecord = await this.stateManager.createTask({
        taskId: successorTaskId,
        taskKind: proposal.taskKind,
        status: 'pending',
        attemptCount: 0,
        maxAttempts: 3,
        inputRef: undefined,
        resultRef: undefined,
        lastError: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        diagnosticJson: createPITaskDiagnosticJson(successorMetadata),
      });
    } catch (createErr) {
      const errMsg = createErr instanceof Error ? createErr.message : String(createErr);
      if (errMsg.includes('UNIQUE constraint') || errMsg.includes('PRIMARY KEY') || errMsg.includes('already exists')) {
        return {
          decision: 'successor_exists',
          sourceTaskId: taskId,
          successorTaskId,
          successorKind: proposal.taskKind,
        };
      }
      throw createErr;
    }

    return {
      decision: 'successor_created',
      sourceTaskId: taskId,
      successorTaskId: successorRecord.taskId,
      successorKind: proposal.taskKind,
    };
  }

  // ── Revision reopen (P0-D, MVP_CORE_LOOP_CONTRACT INV-02/INV-07/INV-08) ─────

  /**
   * Reopen a terminal (succeeded / needs_human_review) task for a revision round:
   * status → pending, attemptCount reset (revision is a new round, not a failure
   * retry), revisionCount++, optional feedback injected, optional artificer
   * dependency swap (evaluator rounds read the repair artificer's payload and
   * artifacts via the FIRST artificer dep — resolvePriorRepairIteration).
   *
   * Idempotent (INV-08): target already pending/retry_wait → no-op ok.
   * Restart-safe: all state is durable; double-reopen collapses to a no-op.
   */
  async reopenTaskForRevision(
    taskId: string,
    options?: {
      revisionFeedback?: string;
      replaceArtificerDependencyWith?: string;
      reason?: string;
    },
  ): Promise<{ ok: boolean; reason: string }> {
    const rawTask = await this.stateManager.getTask(taskId);
    if (!rawTask) {
      return { ok: false, reason: 'task_not_found' };
    }
    const piTask = hydratePITaskRecord(rawTask);
    if (!piTask) {
      return { ok: false, reason: 'invalid_task_metadata' };
    }
    if (rawTask.status === 'pending' || rawTask.status === 'retry_wait') {
      // 已在待跑状态 — 视为幂等成功(更新依赖/反馈仍执行,保证 revision 输入最新)
    } else if (rawTask.status !== 'succeeded' && rawTask.status !== 'needs_human_review') {
      return { ok: false, reason: `task_in_flight_${rawTask.status}` };
    }

    const merged: PITaskMetadata = mergePITaskMetadata(piTask, {
      runnerDecision: undefined, // 新一轮 verdict 未定,清空旧判定 (INV-02 单一决策依据)
      revisionCount: (piTask.revisionCount ?? 0) + 1,
      revisionFeedback: options?.revisionFeedback ?? piTask.revisionFeedback,
    });

    if (options?.replaceArtificerDependencyWith) {
      // 替换 artificer 依赖为指定任务(修订轮读取其 repairPayload/artifacts)。
      // 链是线性的: evaluator 的 artificer dep 只有一个。
      const nonArtificerDeps: string[] = [];
      for (const depId of piTask.dependencyTaskIds) {
        if (depId === options.replaceArtificerDependencyWith) continue;
        const dep = await this.stateManager.getTask(depId);
        if (dep && dep.taskKind === 'artificer') continue;
        nonArtificerDeps.push(depId);
      }
      merged.dependencyTaskIds = [...nonArtificerDeps, options.replaceArtificerDependencyWith];
      // 修订轮 evaluator 的输入 artifact 来自新 artificer 任务的产出
      merged.inputArtifactRefs = [];
    }

    await this.stateManager.updateTaskDiagnosticJson(taskId, createPITaskDiagnosticJson(merged));
    await this.stateManager.updateTask(taskId, {
      status: 'pending',
      attemptCount: 0,
    });
    return { ok: true, reason: options?.reason ?? 'revision_reopen' };
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Find an existing successor task matching parentTaskId + successorKind + channel.
   * Scans pending tasks and hydrates to check PI metadata.
   * Returns the matching TaskRecord or null.
   */
  private async findExistingSuccessor(
    parentTaskId: string,
    successorKind: RunnerKind,
    channel: string,
  ): Promise<TaskRecord | null> {
    const pendingTasks = await this.stateManager.listTasks({ status: 'pending' });
    const retryWaitTasks = await this.stateManager.listTasks({ status: 'retry_wait' });
    const candidates = [...pendingTasks, ...retryWaitTasks];
    for (const task of candidates) {
      if (task.taskKind !== successorKind) continue;
      const piTask = hydratePITaskRecord(task);
      if (!piTask) continue;
      if (piTask.parentTaskId === parentTaskId && piTask.channel === channel) {
        return task;
      }
    }
    return null;
  }

  /**
   * Find candidate PI tasks by querying pending and retry_wait statuses.
   * Filters to only PeerRunnerKind taskKinds and hydrates to PITaskRecord.
   */
  private async findCandidates(taskKind?: RunnerKind): Promise<TaskRecord[]> {
    if (taskKind && !isRunnerKind(taskKind)) {
      throw new PDRuntimeError('input_invalid', `findCandidates: invalid taskKind filter: ${taskKind}`);
    }

    const allCandidates: TaskRecord[] = [];
    try {
      const pending = await this.stateManager.listTasks({ status: 'pending' });
      const retryWait = await this.stateManager.listTasks({ status: 'retry_wait' });
      allCandidates.push(...pending, ...retryWait);
    } catch (error) {
      if (error instanceof PDRuntimeError) throw error;
      throw new PDRuntimeError('runtime_unavailable', 'findCandidates failed', { cause: error });
    }

    let runnerTasks = allCandidates.filter(t => isRunnerKind(t.taskKind));

    if (taskKind) {
      runnerTasks = runnerTasks.filter(t => t.taskKind === taskKind);
    }

    return runnerTasks;
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
