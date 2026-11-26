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

import { PD_TASK_STATUSES, type TaskRecord, type PDTaskStatus } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { RunnerKind } from './peer-runner-contracts.js';
import type { DependencyGateResult, NextTaskProposal } from './internalization-state-machine.js';
import { deriveSuccessorTaskId } from './internalization-state-machine.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata, hasConsumedRevisionCause } from './pitask-metadata.js';
import { reopenTaskForRevision, buildRepairRevisionCauseId, planExistingSuccessorTransition } from './revision-reopen.js';
// PRI-1293 Phase 3: 唯一 PeerRunnerKind 血缘权威解析器 (core 内部模块,
// 不入 barrel — 跨包消费方经 InternalizationOrchestrator 静态只读包装访问)。
import {
  resolveAuthoritativeCorrelationId,
  resolveAuthoritativeCorrelationIdWithLegacyBackfill,
  correlationLineageGetTask,
  CORRELATION_LINEAGE_MAX_PARENT_EDGES,
  type CorrelationLineageGetTask,
  type CorrelationLineageResolution,
} from './correlation-lineage.js';
import type { PITaskMetadata, SourceCorrectionReceiptV1 } from './pitask-metadata.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
import { isPeerRunnerKind, isDiagnosticianStageKind, isRunnerKind } from './peer-runner-contracts.js';
import {
  validateInternalizationTaskReady,
  createNextTaskProposal,
} from './internalization-state-machine.js';
import { getDiagSuccessors } from './internalization-job-graph.js';
import { candidateIdFromDreamerSeed, candidateIdFromDreamerTaskId } from '../activation/ledger-identity.js';
import { currentEvaluation } from '../store/candidate/admission-document.js';
import { evaluateCandidateAdmissionFromRecord } from '../admission-gate.js';
import { evaluateAndPersistAdmissionFromStore } from '../pain-signal-bridge.js';
import { denyAllSourceMaterialAuthorization, type SourceMaterialAuthorizationPort } from '../source-material-authorization.js';
import {
  decideInternalizationTransition,
  transitionInputFromTask,
} from './internalization-transition-decision.js';
import { PDRuntimeError } from '../error-categories.js';

// ── Result Types ─────────────────────────────────────────────────────────────

export interface NoReadyTasksResult {
  decision: 'no_ready_tasks';
  inspectedCount: number;
  /** Why no task could be leased: specific diagnosis */
  reason: 'no_candidates' | 'filtered_out' | 'all_hydration_failed' | 'all_blocked' | 'all_dependency_failed' | 'all_lease_conflict' | 'all_retry_wait_pending' | 'all_skipped_by_caller' | 'all_admission_refused';
  /**
   * PRI-1267: per-task admission refusals when reason is
   * 'all_admission_refused' — queryable record of WHICH candidate was refused
   * and why, so operators (and the consumer-cycle skip report) can see the
   * governed stop instead of an unexplained empty queue.
   */
  admissionRefusals?: readonly {
    taskId: string;
    candidateId: string;
    decision: string;
    reason: string;
    nextAction: string;
  }[];
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
  | { decision: 'successor_reopened'; sourceTaskId: string; reopenedTaskId: string; successorKind: RunnerKind }
  /** A/B: 同 causeId 重放的 no-op reopen — 已 materialized,不计数为恢复 */
  | { decision: 'revision_reopen_noop'; sourceTaskId: string; reopenedTaskId: string; reason: string }
  /** SPEC-PRI-1047: source-correction 新 Scribe 成功 → 原 NHR Artificer 被定点 CAS 续接 */
  | { decision: 'source_correction_reopened'; sourceTaskId: string; reopenedTaskId: string; reason: string }
  /** SPEC-PRI-1047: 定点续接 no-op（崩溃重放已在途/已续接）— receipt outcome 已回填 */
  | { decision: 'source_correction_reopen_noop'; sourceTaskId: string; reopenedTaskId: string; reason: string }
  /** SPEC-PRI-1047: 定点续接冲突（停点漂移/状态不符）— 可观测，不落入通用级联 */
  | { decision: 'source_correction_reopen_conflict'; sourceTaskId: string; reopenedTaskId: string; reason: string }
  /** SPEC-PRI-1047: 定点续接失败（目标缺失等）— 可观测，receipt outcome 记 task_missing */
  | { decision: 'source_correction_reopen_failed'; sourceTaskId: string; reopenedTaskId: string; reason: string }
  /** P0-3: 决策型任务缺少 durable + legacy verdict — fail-closed, 不 seed 任何后继 */
  | { decision: 'blocked_missing_verdict'; taskId: string; reason: string }
  /** PRI-1293 Phase 3: PeerRunnerKind 血缘校验拒绝 — 结构化 reason, 零后继零写入 */
  | { decision: 'lineage_refused'; sourceTaskId: string; reason: string; detail: string }
  /** PRI-1293 R3: 级联 reopen CAS 并发落败 — 修订波未传播, 可重试, 绝不伪装成幂等态 */
  | { decision: 'concurrent_modification'; sourceTaskId: string; reopenedTaskId: string; detail: string }
  /** PRI-1293 R5: 派生 id 与父派生 fallback id 均被异链占用 — fail-closed, 绝不伪装幂等 */
  | { decision: 'successor_id_conflict'; sourceTaskId: string; reason: string; detail?: string }
  | { decision: 'successor_integrity_conflict'; sourceTaskId: string; reason: string; detail: string; conflictingSuccessorTaskIds: string[] }
  | { decision: 'revision_reopen_failed'; sourceTaskId: string; reopenedTaskId: string; reason: string; detail?: string };

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
  /**
   * PRI-1283 R2: latest-consent gate forwarded to the admission
   * re-verification (evaluateAndPersistAdmissionFromStore). ABSENT =
   * fail-closed for governance-sourced material.
   */
  readonly sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
}

/** PRI-1047 Owner review R6 #3: source-correction 定点续接「读取→守卫→CAS」
 * 的有界重试上限——瞬时并发写者（只改无关信息）重试而非误记终态冲突。 */
const SOURCE_CORRECTION_REOPEN_CAS_ATTEMPTS = 3;

// ── InternalizationOrchestrator ───────────────────────────────────────────────

export class InternalizationOrchestrator {
  private readonly owner: string;
  private readonly runtimeKind: string;
  private readonly dryRun: boolean;
  private readonly stateManager: RuntimeStateManager;

  private readonly sourceMaterialAuthorization: SourceMaterialAuthorizationPort;
  constructor(deps: InternalizationOrchestratorDeps, options: InternalizationOrchestratorOptions) {
    if (!options.owner || !options.runtimeKind) {
      throw new PDRuntimeError('input_invalid', 'InternalizationOrchestrator requires non-empty owner and runtimeKind');
    }
    this.stateManager = deps.stateManager;
    this.sourceMaterialAuthorization = deps.sourceMaterialAuthorization ?? denyAllSourceMaterialAuthorization;
    this.owner = options.owner;
    this.runtimeKind = options.runtimeKind;
    this.dryRun = options.dryRun ?? false;
  }

  // ── PRI-1293 Phase 3: 跨包血缘解析通道 (静态只读) ─────────────────────────
  //
  // resolveAuthoritativeCorrelationId 是 core 内部模块 correlation-lineage.ts
  // 的唯一实现; host-runtime (Evaluator Repair Seeder) 与 pd-cli
  // (rulehost seeder) 需要同一判定结果, 但 resolver 不得成为新的 barrel 公开
  // 符号 (PRI-775 冻结面), 也不得复制第二套父链遍历。既有公开类上的静态只读
  // 薄包装是 SPEC §5.4 授权的共享通道: 零状态、零写入, 仅委托。

  /** PeerRunnerKind 父链 correlationId 权威解析 — 只读, 详见 correlation-lineage.ts。 */
  static resolveAuthoritativeCorrelationId(
    leafTaskRecord: Parameters<typeof resolveAuthoritativeCorrelationId>[0],
    getTask: CorrelationLineageGetTask,
  ): Promise<CorrelationLineageResolution> {
    return resolveAuthoritativeCorrelationId(leafTaskRecord, getTask);
  }

  /** One-time CAS backfill for exact legacy producer shapes, then the same lineage authority. */
  static resolveAuthoritativeCorrelationIdWithLegacyBackfill(
    leafTaskRecord: Parameters<typeof resolveAuthoritativeCorrelationId>[0],
    stateManager: RuntimeStateManager,
  ): Promise<CorrelationLineageResolution> {
    return resolveAuthoritativeCorrelationIdWithLegacyBackfill(leafTaskRecord, stateManager);
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
   *
   * `options.skipCandidate` (PRI-1221 review round 2) is an OPTIONAL caller
   * filter, deliberately NOT a named barrel export: the ./runtime surface is
   * already frozen-wide, and a single consumer (run-once) passes the predicate
   * as a structural literal. It excludes candidates from SELECTION so the
   * first excluded candidate no longer shadows a ready executable candidate
   * behind it, while queue-side gate logic (dependencies, lease) stays owned
   * by wakeOnce itself. When every candidate is excluded AND no queue-side
   * failure occurred the result reports reason 'all_skipped_by_caller'
   * (rc-9: caller capability facts stay observable) — any queue-side failure
   * mode outranks it in the diagnosis, regardless of the skip count.
   */
  async wakeOnce(
    taskKind?: RunnerKind,
    options?: { skipCandidate?: (piTask: PITaskRecord) => boolean },
  ): Promise<WakeOnceResult> {
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
    let callerSkippedCount = 0;
    let admissionRefusedCount = 0;
    const admissionRefusals: {
      taskId: string;
      candidateId: string;
      decision: string;
      reason: string;
      nextAction: string;
    }[] = [];

    for (const rawTask of candidates) {
      const piTask = hydratePITaskRecord(rawTask);

      if (!piTask) {
        // Hydration failed — invalid PI metadata, skip and try next candidate
        hydrationFailures++;
        continue;
      }

      if (options?.skipCandidate?.(piTask)) {
        // Caller-declared non-executable candidate: skip WITHOUT counting it as
        // a queue-side failure — selection moves to the NEXT candidate of the
        // same kind, so an executable task behind it stays reachable. The skip
        // itself is reported via 'all_skipped_by_caller' when nothing else is
        // leasable (rc-9: caller-side capability facts stay observable).
        callerSkippedCount++;
        continue;
      }

      // PRI-1267: claim-time admission gate. Dreamer tasks created before the
      // internalize-side write gate (or by paths that bypassed it) may sit in
      // the queue for a candidate the admission gate has since REFUSED. The
      // lease must not be acquired for them: every candidate write entry
      // (intake / internalize / repair / backfill / review / retry) refuses
      // non-admitted candidates, and the claim path is the last line of defense
      // for already-queued tasks. Refusal is a governed stop, not a queue-side
      // failure — it ranks with caller skips so a real dependency/lease problem
      // still dominates the no_ready_tasks diagnosis.
      if (piTask.taskKind === 'dreamer') {
        const candidateId = candidateIdFromDreamerSeed(rawTask.diagnosticJson)
          ?? candidateIdFromDreamerTaskId(piTask.taskId);
        if (candidateId !== null) {
          const refusal = await this.checkCandidateAdmissionAtClaim(candidateId);
          if (refusal !== null) {
            admissionRefusedCount++;
            admissionRefusals.push({ taskId: piTask.taskId, candidateId, ...refusal });
            continue;
          }
        }
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

    // All candidates exhausted — determine dominant failure mode for diagnosis.
    // Dominant mode: pick the failure type with the highest count; ties broken
    // by specificity priority (retry_wait > hydration > dependency > blocked > lease).
    // Hydration participates when it is the highest count (not just 100%).
    //
    // Caller-skipped candidates rank BELOW every queue-side failure mode and
    // must NOT take part in the count comparison: a caller capability fact
    // ("this consumer cannot execute Code Rule tasks") says nothing about queue
    // health, so a larger callerSkippedCount must never mask a hydration /
    // dependency / blocked / lease problem from the Owner. 'all_skipped_by_caller'
    // wins ONLY when every queue-side count is zero (PRI-1221 review round 3).
    const hasQueueSideFailure =
      retryWaitPendingCount > 0 || hydrationFailures > 0 || dependencyFailures > 0
      || blockedCount > 0 || leaseConflictCount > 0;
    const reason: NoReadyTasksResult['reason'] =
      !hasQueueSideFailure && callerSkippedCount > 0
        ? 'all_skipped_by_caller'
        : !hasQueueSideFailure && admissionRefusedCount > 0
          ? 'all_admission_refused'
          : !hasQueueSideFailure
            ? 'no_candidates'
          : retryWaitPendingCount > 0 && retryWaitPendingCount >= hydrationFailures && retryWaitPendingCount >= dependencyFailures && retryWaitPendingCount >= blockedCount && retryWaitPendingCount >= leaseConflictCount
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
      ...(reason === 'all_admission_refused' ? { admissionRefusals } : {}),
    };
  }

  /**
   * PRI-1267: read the candidate's admission disposition at claim time.
   * Returns null when the candidate is ADMITTED (the lease may proceed);
   * otherwise a structured refusal (decision / reason / nextAction) that is
   * reported on the wakeOnce result — a queryable, governed stop.
   *
   * Mirrors the CLI write gate (`enforceFullAdmissionForWrite`) posture:
   *   - unreadable disposition → refuse (fail closed, rc-3);
   *   - no disposition on record (pre-CR-03 task) → full re-evaluation from
   *     persisted materials, saved idempotently — in dry-run mode a read-only
   *     partial check replaces it (a dry run must not write);
   *   - current non-admitted decision → refuse with its actual reason.
   */
  private async checkCandidateAdmissionAtClaim(
    candidateId: string,
  ): Promise<{ decision: string; reason: string; nextAction: string } | null> {
    const read = await this.stateManager.getAdmissionDocument(candidateId);
    if (!read.ok) {
      return {
        decision: 'needs_evidence',
        reason: `admission_document_unreadable:${read.reason}`,
        nextAction: 'inspect principle_candidates.admission_json for this candidate; repair or re-run the diagnosis before internalization executes',
      };
    }
    const current = currentEvaluation(read.document);
    if (current !== null && current.decision === 'admitted') {
      // PRI-1283 review round 2 (directive D): a historical `admitted` is NOT
      // a permanent grant. Before the verdict is reused, the candidate's
      // diagnosis lineage is re-verified against the LATEST source-material
      // authorization (read-only — the historical evaluation document itself
      // is not rewritten; a revoked source refuses the claim instead of
      // quietly re-entering internalization and downstream model stages).
      const candidate = await this.stateManager.getCandidate(candidateId);
      if (candidate === null) {
        return {
          decision: 'needs_evidence',
          reason: 'candidate_not_found_at_claim',
          nextAction: 'the queued dreamer task references a candidate that no longer exists; remove the task or re-run the diagnosis',
        };
      }
      const reverified = await evaluateAndPersistAdmissionFromStore(this.stateManager, [candidateId], {
        taskId: candidate.taskId,
        persist: false,
        sourceMaterialAuthorization: this.sourceMaterialAuthorization,
      });
      if (!reverified.ok && reverified.reason.startsWith('source_authorization_revoked')) {
        return {
          decision: 'source_authorization_revoked',
          reason: reverified.reason,
          nextAction: reverified.nextAction,
        };
      }
      // Any other outcome keeps the durable admitted verdict — only the
      // authorization re-verification may veto a historical admission here.
      return null;
    }
    if (current !== null) {
      return { decision: current.decision, reason: current.reason, nextAction: current.nextAction };
    }
    const candidate = await this.stateManager.getCandidate(candidateId);
    if (candidate === null) {
      return {
        decision: 'needs_evidence',
        reason: 'candidate_not_found_at_claim',
        nextAction: 'the queued dreamer task references a candidate that no longer exists; remove the task or re-run the diagnosis',
      };
    }
    if (this.dryRun) {
      // Read-only partial check — a dry run must not persist a new evaluation.
      const partial = evaluateCandidateAdmissionFromRecord({
        recommendationKind: candidate.recommendationKind,
        confidence: candidate.confidence,
      });
      return partial.decision === 'admitted'
        ? null
        : { decision: partial.decision, reason: `no_admission_document:${partial.reason}`, nextAction: partial.nextAction };
    }
    const revalidated = await evaluateAndPersistAdmissionFromStore(this.stateManager, [candidateId], { taskId: candidate.taskId, sourceMaterialAuthorization: this.sourceMaterialAuthorization });
    if (!revalidated.ok) {
      return {
        decision: 'needs_evidence',
        reason: `admission_revalidation_failed:${revalidated.reason}`,
        nextAction: revalidated.nextAction,
      };
    }
    const fresh = revalidated.decisions.get(candidateId);
    if (fresh === undefined) {
      return {
        decision: 'needs_evidence',
        reason: 'candidate_not_in_diagnosis_chain',
        nextAction: 're-run the diagnosis; the queued task no longer matches its diagnosis chain',
      };
    }
    return fresh.decision === 'admitted'
      ? null
      : { decision: fresh.decision, reason: `${fresh.reason} (revalidated at claim)`, nextAction: fresh.nextAction };
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

    // ── 单一迁移决策 (P0-D/P0-3, INV-02) ──
    // runner 的 verdict 与状态迁移在此仲裁: needs_revision/rejected 不 seed
    // 正常后继; artificer repair 完成 reopen 来源 evaluator。
    // P0-3: durable runnerDecision 缺失时,用 runs.output_payload 的**显式可解析**
    // verdict 作 legacy 判据; 两者皆无 → BLOCKED_MISSING_VERDICT (fail-closed,
    // 禁止 missing=ADVANCE 复活审计的错误旁路)。
    const legacyVerdict = await this.resolveLegacyRunnerVerdict(taskId, rawTask.taskKind);
    // PRI-758: an `approved` evaluator verdict whose deterministic adversarial
    // replay FAILED must not ADVANCE (no rollout successor while the rule
    // artifact is absent and repair is pending/required). Derived from the
    // same durable runs the legacy verdict reads — fresh/resume-stable.
    const adversarialReplayFailed = rawTask.taskKind === 'evaluator'
      ? await this.resolveAdversarialReplayFailed(taskId)
      : false;
    const transition = decideInternalizationTransition(transitionInputFromTask(piTask, legacyVerdict, { adversarialReplayFailed }));
    if (transition.kind === 'HUMAN_REVIEW_REQUIRED') {
      return { decision: 'source_not_succeeded', taskId, status: piTask.status };
    }
    if (transition.kind === 'NOT_ADVANCEABLE') {
      return { decision: 'source_not_succeeded', taskId, status: piTask.status };
    }
    if (transition.kind === 'BLOCKED_MISSING_VERDICT') {
      return { decision: 'blocked_missing_verdict', taskId, reason: transition.reason };
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
      // PRI-629 P0 (SPEC §12): epoch-aware causal identity — Owner 额外修订轮
      // (revise_once reopen 该 artificer,其 revisionCount+1) 再次完成时,
      // 重开来源 evaluator 必须使用新 causeId 才是真 reopen;同 epoch 重放
      // (crash/reconciliation) 使用相同 causeId → no-op。
      const causeId = buildRepairRevisionCauseId(piTask);
      // A/B: cause 已 materialize 的判定前移 — 目标(任意状态)的 revisionCauseId
      // 与本 repair 的 causeId 相同,说明这轮 reopen 已发生过: 目标可能仍在
      // pending(等待重跑),也可能已经跑完(succeeded 且带新 verdict)。两种
      // 情况重放都不得再次 reopen(后者会丢弃已完成的修订轮 verdict)。
      const srcRaw = await this.stateManager.getTask(piTask.repairPayload.sourceEvaluatorTaskId);
      const srcPi = srcRaw ? hydratePITaskRecord(srcRaw) : null;
      if (srcPi && hasConsumedRevisionCause(srcPi, causeId)) {
        return {
          decision: 'revision_reopen_noop',
          sourceTaskId: taskId,
          reopenedTaskId: piTask.repairPayload.sourceEvaluatorTaskId,
          reason: 'revision_cause_already_materialized',
        };
      }
      // PRI-718 (superseded-repair downgrade guard): a stale completion
      // recovery (e.g. reconciliation replaying an OLDER repair's transition)
      // must not re-point the evaluator's artificer dependency back to a
      // superseded round — that made the evaluator re-evaluate the same old
      // artifact forever (EP002-R2 F3). Replacement is allowed only when the
      // completing repair IS the evaluator's current repair dep, or is a
      // NEWER round of the same source evaluator.
      if (srcPi && srcRaw) {
        for (const depId of srcPi.dependencyTaskIds) {
          if (depId === taskId) continue;
          const dep = await this.stateManager.getTask(depId);
          if (!dep || dep.taskKind !== 'artificer') continue;
          const depPi = hydratePITaskRecord(dep);
          if (
            depPi?.repairPayload
            && depPi.repairPayload.sourceEvaluatorTaskId === piTask.repairPayload.sourceEvaluatorTaskId
            && typeof depPi.repairPayload.repairIteration === 'number'
            && depPi.repairPayload.repairIteration >= piTask.repairPayload.repairIteration
          ) {
            return {
              decision: 'revision_reopen_noop',
              sourceTaskId: taskId,
              reopenedTaskId: piTask.repairPayload.sourceEvaluatorTaskId,
              reason: 'stale_repair_transition_superseded',
            };
          }
          break; // the evaluator's artificer dep is singular (linear chain)
        }
      }
      const reopened = await this.reopenTaskForRevision(piTask.repairPayload.sourceEvaluatorTaskId, {
        replaceArtificerDependencyWith: taskId,
        reason: 'artificer_repair_complete',
        revisionCauseId: causeId,
      });
      if (!reopened.ok) {
        // Repair 已成功但来源 Evaluator reopen 失败不是正常终点；保留真实拒绝类别。
        if (reopened.reason.startsWith('lineage_refused:')) {
          return { decision: 'lineage_refused', sourceTaskId: taskId,
            reason: reopened.reason.slice('lineage_refused:'.length), detail: reopened.detail ?? reopened.reason };
        }
        if (reopened.reason === 'concurrent_modification') {
          return { decision: 'concurrent_modification', sourceTaskId: taskId,
            reopenedTaskId: piTask.repairPayload.sourceEvaluatorTaskId,
            detail: reopened.detail ?? 'repair_evaluator_reopen_cas_conflict:' + piTask.repairPayload.sourceEvaluatorTaskId };
        }
        if (reopened.reason === 'invalid_task_metadata') {
          return { decision: 'invalid_task_metadata', taskId: piTask.repairPayload.sourceEvaluatorTaskId,
            reason: 'repair_evaluator_reopen_invalid_task_metadata' };
        }
        return { decision: 'revision_reopen_failed', sourceTaskId: taskId,
          reopenedTaskId: piTask.repairPayload.sourceEvaluatorTaskId, reason: reopened.reason,
          ...(reopened.detail !== undefined ? { detail: reopened.detail } : {}) };
      }
      // A (crash window): 同 causeId 重放 = 真 no-op — 单独 decision 使
      // reconciliation 不把它计为"恢复" (already materialized)。
      if (reopened.reason === 'idempotent_replay_same_revision') {
        return {
          decision: 'revision_reopen_noop',
          sourceTaskId: taskId,
          reopenedTaskId: piTask.repairPayload.sourceEvaluatorTaskId,
          reason: reopened.reason,
        };
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

    // ── SPEC-PRI-1047 修复 B: source-correction 定点续接分支 ──
    // 本次完成的 scribe 携带 source-correction receipt 且**当前修订轮就是该
    // source-correction 轮**（revisionCauseId === sourceCorrectionCauseId——
    // 重开时两者被同一原子写入）时，本 transition 由 source-correction 独占
    // （无论 outcome 是否已回填）：定点 CAS 重开 receipt 指向的原 Artificer
    // （核对它确因该源材料而停、保留原 taskId/依赖、经 MAX(revision_epoch)
    // 视图消费新工件）。outcome 已记录（reopened/reopened_earlier/
    // already_in_flight）→ 幂等 no-op；conflict/task_missing → 终态可观测，
    // **不落入** findExistingSuccessor / 通用级联——否则周期性 reconciliation
    // 重放会把刚被拒绝重开的 Artificer 经通用级联重开，绕过停点核验
    // （评审 P2 #3）。分支位于 proposeNextTask 之前：receipt 未处理时不依赖
    // job graph 可解（评审 P3 #8）。
    // PRI-1047 Owner review R6 #5: 轮次限定是必须的——receipt 在
    // mergePITaskMetadata 中跨轮存活，而后续一次合法 binding revision 会把
    // revisionCauseId 覆写为 rule-binding:…；若只看 receipt 存在性，那一轮的
    // 成功 transition 会被旧回执捕获成 no-op，正常后继推进（级联重开下游）
    // 永远不再发生。cause 不匹配 = 非 source-correction 轮 → 走通用流程。
    if (rawTask.taskKind === 'scribe' && piTask.sourceCorrectionReceipt !== undefined
      && piTask.sourceCorrectionCauseId !== undefined
      && piTask.revisionCauseId === piTask.sourceCorrectionCauseId) {
      if (piTask.sourceCorrectionReceipt.reopenOutcome !== undefined) {
        return {
          decision: 'source_correction_reopen_noop',
          sourceTaskId: taskId,
          reopenedTaskId: piTask.sourceCorrectionReceipt.artificerTaskId,
          reason: `source_correction_outcome_recorded:${piTask.sourceCorrectionReceipt.reopenOutcome.kind}`,
        };
      }
      return this.reopenArtificerForSourceCorrection(taskId, piTask);
    }

    // ── PRI-1293 Phase 3: PeerRunnerKind 血缘门禁 (ADVANCE 路径唯一写前关口) ──
    // 严格作用域: 仅 PeerRunnerKind 源任务。DiagnosticianStageKind 子任务
    // 继续走 proposeNextTask 的 getDiagSuccessors 分支 (parentTaskId +
    // dependencyTaskIds 语义), 绝不套用 correlationId 门禁。
    // 校验发生在任何后继创建之前: 拒绝 = 零 createTask、零状态写入、零
    // reopen; 结构化 lineage_refused 让 host 层 (consumer cycle / run-once /
    // enqueue-successors / reconciliation) 可观测, 不折叠成 no_successor。
    // 校验同时负责历史无 id 链的根侧恢复 — 成功结果 (含 recoveredFromLegacyRoot)
    // 写入新后继 metadata.correlationId; 后继 taskId 派生保持原样 (proposal.
    // correlationId ?? stripTrailingChannel), 不漂移在途历史链的确定性去重。
    let authoritativeCorrelation: Extract<CorrelationLineageResolution, { ok: true }> | null = null;
    if (isPeerRunnerKind(piTask.taskKind)) {
      const lineage = await resolveAuthoritativeCorrelationIdWithLegacyBackfill(rawTask, this.stateManager);
      if (!lineage.ok) {
        return {
          decision: 'lineage_refused',
          sourceTaskId: taskId,
          reason: lineage.reason,
          detail: lineage.detail,
        };
      }
      authoritativeCorrelation = lineage;
    }

    const proposalResult = await this.proposeNextTask(taskId);
    if (!proposalResult) {
      return { decision: 'no_successor', sourceTaskId: taskId, reason: 'No valid successor in job graph for this task kind and channel' };
    }

    const {proposal} = proposalResult;

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
    // PRI-1293 R5: 派生经共享单一来源 (internalization-state-machine) —
    // dry-run 预览消费同一函数, 两条路径不再有各自的派生实现。
    const successorTaskId = deriveSuccessorTaskId(proposal, taskId);

    // ── 级联 reopen (revision wave) ──
    // 稳定 id 后继已存在且为 succeeded: 仅当源任务经历过 revision
    // (revisionCount > 0, 即上游被 reopen 后重新完成)时, 下游才必须重跑
    // (而非 successor_exists 停摆)。普通幂等重扫 (revisionCount=0) 不级联,
    // 保持既有 successor_exists 语义。pending/retry_wait 的存在后继仍走
    // findExistingSuccessor 的 successor_exists 分支。
    // ── 统一后继识别 (PRI-1293 review round 3) ──
    // 后继身份是 (parentTaskId, successorKind, channel) 父子关系, 不是派生 id:
    //   - 修订重开把恢复的 correlationId 回填进源任务, 派生根漂移 (R2);
    //   - RuleHost 同步链持久化时间戳 id, 确定性派生永不复现 (R3)。
    // 因此直查与父子扫描都不再受 revisionCount 门限制 — 此前 rc=0 仅靠
    // createTask 的 UNIQUE 撞约束兜底, 对时间戳链等于毫无保护: dry-run
    // (全状态索引) 能看到的终态后继, confirm 却再创建一条逻辑相同的链。
    // 现在任何状态的已存在后继 (在途/终态/failed) 都先命中 successor_exists;
    // 仅当命中可重开终态且源经历过 revision (rc>0) 时才进入级联重开。
    // PRI-1293 R5 (跨链派生 id 碰撞): 父子扫描是唯一权威, 直查快路径废除——
    // 旧实现在确定性 id 命中时跳过扫描, 且不校验 occupant 的 parentTaskId:
    // 候选身份经修订回填进**另一条链** (如 RuleHost 时间戳链) 后, 其派生 id
    // 与本队列链相同, 直查命中异链任务, 级联重开错链的后继并替换其依赖。
    // 扫描按 (parentTaskId, kind, channel) 匹配, 异链 occupant 自然不命中;
    // id 占用冲突在创建路径处理 (fallback 父派生 id + UNIQUE 竞态重扫)。
    const scannedSuccessors = await this.findSuccessorByParent(taskId, proposal.taskKind, proposal.channel);
    if (scannedSuccessors.length > 1) {
      const conflictingSuccessorTaskIds = scannedSuccessors.map((candidate) => candidate.taskId);
      return { decision: 'successor_integrity_conflict', sourceTaskId: taskId,
        reason: 'multiple_successors_for_parent',
        detail: 'parentTaskId=' + taskId + ';successorKind=' + proposal.taskKind + ';channel=' + proposal.channel + ';taskIds=[' + conflictingSuccessorTaskIds.join(',') + ']',
        conflictingSuccessorTaskIds };
    }
    const existingSuccessorCandidate = scannedSuccessors[0] ?? null;
    // PRI-1293 R5: 级联判定经共享只读 planner (revision-reopen.ts) — commit
    // 与 dry-run 预览消费同一判定, 预览不再把"将重开"误报为 successor_exists。
    const scannedSuccPi = existingSuccessorCandidate !== null ? hydratePITaskRecord(existingSuccessorCandidate) : null;
    const successorTransitionPlan = existingSuccessorCandidate !== null
      ? planExistingSuccessorTransition({
        sourceTaskId: taskId,
        sourceRevisionCount: piTask.revisionCount ?? 0,
        successorTaskId: existingSuccessorCandidate.taskId,
        successorStatus: existingSuccessorCandidate.status,
        successorRevisionCauseId: scannedSuccPi?.revisionCauseId,
        successorConsumedRevisionCauseIds: scannedSuccPi?.consumedRevisionCauseIds,
      })
      : { plan: 'exists_plain' as const };
    if (existingSuccessorCandidate !== null && successorTransitionPlan.plan !== 'exists_plain') {
      const cascadeTargetTaskId = existingSuccessorCandidate.taskId;
      const { cascadeCauseId } = successorTransitionPlan;
      // B: 对称的 cause 前置 — 该 wave 的 cascade reopen 已 materialize
      // (successor 可能 pending 或已重跑完成),重放不得再 reopen。
      if (successorTransitionPlan.plan === 'cascade_already_materialized') {
        return {
          decision: 'revision_reopen_noop',
          sourceTaskId: taskId,
          reopenedTaskId: cascadeTargetTaskId,
          reason: 'revision_cause_already_materialized',
        };
      }
      // PRI-668: 修订波级联必须刷新 successor 的 artificer 依赖。
      // repair 完成路径 (:477) 把 evaluator 的依赖换成 artificer-repair 任务;
      // 其后 rollout needs_revision reopen 父 artificer 重跑出**新**产物,但若
      // 级联 reopen 不换依赖,evaluator buildContext 永远读陈旧 repair 任务的
      // artifact,修订预算被旧输入烧光 (修订永不收敛根因)。判定: successor 是
      // evaluator 且其 artificer 依赖 (按 taskKind 两跳判定,与 revision-reopen
      // 的 replaceArtificerDependencyWith 过滤同源——不用 id 前缀约定) 不是
      // 刚完成的 taskId 时,镜像 REOPEN_SOURCE_EVALUATOR 的换依赖语义。
      let cascadeReplaceArtificerDependencyWith: string | undefined;
      if (scannedSuccPi && proposal.taskKind === 'evaluator') {
        for (const depId of scannedSuccPi.dependencyTaskIds) {
          if (depId === taskId) continue;
          const dep = await this.stateManager.getTask(depId);
          if (dep?.taskKind === 'artificer') {
            cascadeReplaceArtificerDependencyWith = taskId;
            break;
          }
        }
      }
      const reopened = await this.reopenTaskForRevision(cascadeTargetTaskId, {
        reason: 'upstream_revision_cascade',
        // B (外部复核): causal idempotency — 同一 upstream revision wave 的
        // reconciliation/commit 重放不得再次 reopen 或递增 revisionCount。
        revisionCauseId: cascadeCauseId,
        ...(cascadeReplaceArtificerDependencyWith !== undefined
          ? { replaceArtificerDependencyWith: cascadeReplaceArtificerDependencyWith }
          : {}),
      });
      if (reopened.ok) {
        if (reopened.reason === 'idempotent_replay_same_revision') {
          return {
            decision: 'revision_reopen_noop',
            sourceTaskId: taskId,
            reopenedTaskId: cascadeTargetTaskId,
            reason: reopened.reason,
          };
        }
        return {
          decision: 'successor_reopened',
          sourceTaskId: taskId,
          reopenedTaskId: cascadeTargetTaskId,
          successorKind: proposal.taskKind,
        };
      }
      // 级联重开被拒绝不折叠为 successor_exists — 修订波未能向下游传播,
      // 链停在旧 epoch; 结构化透出真实拒绝原因 (rc-9), 让 consumer cycle /
      // run-once / enqueue-successors 可观测, 而非呈现为正常幂等态。
      if (reopened.reason.startsWith('lineage_refused:')) {
        return {
          decision: 'lineage_refused',
          sourceTaskId: taskId,
          reason: reopened.reason.slice('lineage_refused:'.length),
          detail: `cascade_reopen_refused:${cascadeTargetTaskId}${reopened.detail !== undefined ? `:${reopened.detail}` : ''}`,
        };
      }
      if (reopened.reason === 'invalid_task_metadata') {
        return {
          decision: 'invalid_task_metadata',
          taskId: cascadeTargetTaskId,
          reason: `cascade_reopen_invalid_task_metadata: successor of ${taskId}`,
        };
      }
      // PRI-1293 review round 3: CAS 并发落败是独立的结构化结果 — 级联未能
      // 传播修订波, 链停在旧 epoch, 绝不折叠为 successor_exists (那会把未
      // 完成的级联伪装成正常幂等态)。reopen 内部已在 CAS 落败后重读: 同一
      // revisionCauseId 已 materialize 的重放在上面按 idempotent no-op 返回,
      // 到达这里 = 真实的并发冲突, 可安全重试 (reopen 幂等)。
      if (reopened.reason === 'concurrent_modification') {
        return {
          decision: 'concurrent_modification',
          sourceTaskId: taskId,
          reopenedTaskId: cascadeTargetTaskId,
          detail: reopened.detail ?? `cascade_cas_conflict:${cascadeTargetTaskId}`,
        };
      }
      return {
        decision: 'successor_exists',
        sourceTaskId: taskId,
        successorTaskId: cascadeTargetTaskId,
        successorKind: proposal.taskKind,
      };
    }
    if (existingSuccessorCandidate) {
      // 统一识别的剩余命中: rc=0 的终态后继 (幂等重扫不级联 — 保留原任务
      // id, 零创建零重复执行), 以及 leased/retry_wait/pending/failed 在途
      // 或待重试后继 — 与任务状态机语义一致, 不重复处理。
      return {
        decision: 'successor_exists',
        sourceTaskId: taskId,
        successorTaskId: existingSuccessorCandidate.taskId,
        successorKind: proposal.taskKind,
      };
    }

    // PRI-1293 review fix: 创建前校验"再加一条边是否越限"。resolver 只校验
    // 源任务自身链 (读取侧 — 深度 10 的在途任务保持可读), 但深度 10 的源
    // 若创建后继, 新任务即刻成为第 11 条边, 之后它自身的每次 commit/reopen
    // 都被同一 resolver 拒绝 — 产出"已创建但永远无法推进"的任务。因此在
    // 持久化前 fail-closed: 源深度 9 → 后继 10 放行; 源深度 10 → 结构化拒绝,
    // 零 createTask 零写入。注意此检查只在创建路径 — 上方在途/终态后继的
    // successor_exists 与级联 reopen 不受影响 (reopen 有自身的血缘校验)。
    if (authoritativeCorrelation !== null
      && authoritativeCorrelation.parentEdgeCount + 1 > CORRELATION_LINEAGE_MAX_PARENT_EDGES) {
      return {
        decision: 'lineage_refused',
        sourceTaskId: taskId,
        reason: 'parent_chain_cycle_or_depth_exceeded',
        detail: `successor_would_exceed_depth_limit:${authoritativeCorrelation.parentEdgeCount + 1}_edges_max_${CORRELATION_LINEAGE_MAX_PARENT_EDGES}`,
      };
    }

    const successorMetadata: PITaskMetadata = {
      dependencyTaskIds: proposal.dependencyTaskIds,
      channel: proposal.channel,
      pipelineMode: proposal.pipelineMode,
      timeoutMs: 300_000,
      inputArtifactRefs: proposal.inputArtifactRefs,
      outputArtifactRefs: [],
      parentTaskId: proposal.parentTaskId,
      // PRI-1293 Phase 3: 写入的是经过权威校验/恢复的 correlationId —
      // 历史无 id 链在此补入根侧恢复值 (§3.6.3 历史恢复), 正常链上与
      // proposal.correlationId 相同 (校验保证链内一致 + 根佐证)。
      correlationId: authoritativeCorrelation?.correlationId ?? proposal.correlationId,
    };

     
    // PRI-1293 R5: 创建是 bounded 收敛循环 (至多 2 次)。
    //   attempt 0 用主派生 id; UNIQUE 落败先重扫——并发创建者若已物化真实
    //   后继 (同 parent/kind/channel) 按 successor_exists 收敛, 绝不重复创建;
    //   重扫为空 = occupant 属异链 (扫描为空已证明它非本父子后继), attempt 1
    //   改用父派生 fallback id。fallback id 对同一 (parent, kind, channel)
    //   确定性收敛: 两个并发创建者碰壁后落到**同一** fallback id, 胜负由
    //   UNIQUE 裁决, 败者重扫收敛——不会双链并行。fallback 仍 UNIQUE 落败
    //   且重扫为空 = 持续占用冲突, fail-closed 结构化 successor_id_conflict
    //   (绝不折叠为 successor_exists 伪装幂等)。
    let successorRecord: TaskRecord | null = null;
    for (let createAttempt = 0; createAttempt < 2 && successorRecord === null; createAttempt++) {
      const idForCreate = createAttempt === 0
        ? successorTaskId
        : successorTaskId + '-p-' + taskId;
      try {
        successorRecord = await this.stateManager.createTask({
          taskId: idForCreate,
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
        if (!(errMsg.includes('UNIQUE constraint') || errMsg.includes('PRIMARY KEY') || errMsg.includes('already exists'))) {
          throw createErr;
        }
        // UNIQUE 落败: 重扫真实后继。并发创建者物化的新行一律 pending,
        // successor_exists 收敛语义正确; 既有终态后继早在首个扫描即命中,
        // 不会到达此处。
        const rescanned = await this.findSuccessorByParent(taskId, proposal.taskKind, proposal.channel);
        if (rescanned.length > 1) {
          const conflictingSuccessorTaskIds = rescanned.map((candidate) => candidate.taskId);
          return { decision: 'successor_integrity_conflict', sourceTaskId: taskId,
            reason: 'multiple_successors_for_parent_after_unique_conflict',
            detail: 'parentTaskId=' + taskId + ';successorKind=' + proposal.taskKind + ';channel=' + proposal.channel + ';taskIds=[' + conflictingSuccessorTaskIds.join(',') + ']',
            conflictingSuccessorTaskIds };
        }
        if (rescanned.length === 1) {
          return { decision: 'successor_exists', sourceTaskId: taskId,
            successorTaskId: rescanned[0]!.taskId, successorKind: proposal.taskKind };
        }
        // occupant 不可解析 = 损坏行 — 它可能是本链被腐蚀的后继也可能是异链
        // 残骸, 无法证明任一归属。fallback 创建会复制一条逻辑后继而腐蚀行
        // 原地留存 (完整性恶化), fail-closed 要求先修复腐蚀 (rc-9 诚实)。
        const occupantRaw = await this.stateManager.getTask(idForCreate);
        if (occupantRaw !== null && hydratePITaskRecord(occupantRaw) === null) {
          return {
            decision: 'successor_id_conflict',
            sourceTaskId: taskId,
            reason: 'occupant_metadata_unparseable',
            detail: 'task ' + idForCreate + ' occupies the derived id with unparseable diagnosticJson — repair corruption before creating (no fallback duplication of a corrupt row)',
          };
        }
        if (createAttempt === 1) {
          return {
            decision: 'successor_id_conflict',
            sourceTaskId: taskId,
            reason: 'derived_and_fallback_ids_occupied_by_foreign_chain',
            detail: 'primary=' + successorTaskId + ' fallback=' + successorTaskId + '-p-' + taskId + ' both occupied; scan found no successor for parent ' + taskId,
          };
        }
      }
    }
    if (successorRecord === null) {
      // 循环不变式保证不可达 (attempt 1 落败已返回), 防御性 fail-closed。
      return {
        decision: 'successor_id_conflict',
        sourceTaskId: taskId,
        reason: 'create_loop_exhausted_without_row',
      };
    }

    return {
      decision: 'successor_created',
      sourceTaskId: taskId,
      successorTaskId: successorRecord.taskId,
      successorKind: proposal.taskKind,
    };
  }

  /**
   * P0-3 legacy 判据: 从该任务最近 succeeded run 的 output_payload **显式解析**
   * verdict (evaluation.decision / review.decision / rolloutDecision)。
   * 这是修复前唯一持久 verdict 载体 — 对历史数据是真实证据而非猜测;
   * 新数据由 runner 的 durable runnerDecision 承载。解析失败/缺失 → undefined。
   * rc-1/rc-2: output_payload 按不可信 JSON 处理,逐字段类型守卫。
   */
  /**
   * PRI-758: true when the evaluator's latest succeeded run carries a
   * deterministic adversarial replay that RAN and FAILED (passed===false).
   * This is the durable signal that the approved rule artifact was never
   * assembled and the chain must not ADVANCE while repair is required.
   */
  private async resolveAdversarialReplayFailed(taskId: string): Promise<boolean> {
    let runs: { outputPayload?: string }[];
    try {
      runs = await this.stateManager.getRunsByTask(taskId);
    } catch {
      return false;
    }
    for (const run of [...runs].reverse()) {
      const raw = run.outputPayload;
      if (typeof raw !== 'string' || raw.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const obj = parsed as Record<string, unknown>;
      if (Object.hasOwn(obj, 'adversarialResult') && typeof obj.adversarialResult === 'object' && obj.adversarialResult !== null) {
        const ar = obj.adversarialResult as Record<string, unknown>;
        return ar.passed === false;
      }
    }
    return false;
  }

  private async resolveLegacyRunnerVerdict(taskId: string, taskKind: string): Promise<string | undefined> {
    if (taskKind !== 'evaluator' && taskKind !== 'rollout_reviewer') return undefined;
    let runs: { outputPayload?: string }[];
    try {
      runs = await this.stateManager.getRunsByTask(taskId);
    } catch {
      return undefined;
    }
    for (const run of [...runs].reverse()) {
      // RunRecord.outputPayload 已是类型化 string|undefined (store 层映射);
      // JSON.parse 结果仍按 rc-1 逐字段守卫 (下方 evaluation/review 检查)
      const raw = run.outputPayload;
      if (typeof raw !== 'string' || raw.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const obj = parsed as Record<string, unknown>;
      const verdictHolders: unknown[] = [obj.evaluation, obj.review];
      for (const holder of verdictHolders) {
        if (typeof holder === 'object' && holder !== null) {
          const d = (holder as Record<string, unknown>).decision;
          if (typeof d === 'string' && d.length > 0) return d;
        }
      }
      if (typeof obj.rolloutDecision === 'string' && obj.rolloutDecision.length > 0) {
        return obj.rolloutDecision;
      }
    }
    return undefined;
  }

  // ── A: succeeded-transition reconciliation (crash window 修复) ─────────────

  /**
   * Bounded reconciliation for the crash window between markTaskSucceeded
   * (durable, inside the runner) and commitNextTaskProposal (in-process,
   * called by the consumer AFTER run() returns). If the process dies between
   * them, the task stays succeeded forever and its outgoing transition
   * (successor seed / repair-source reopen / cascade reopen) is lost —
   * wakeOnce only scans pending/retry_wait.
   *
   * Strategy (bounded, not a blind sweep):
   *   - scan only the N most recently updated succeeded tasks (default 10);
   *   - only peer-runner kinds whose commit semantics are outgoing
   *     transitions (rollout_reviewer included: its commit is a harmless
   *     no-op verified by the verdict gate);
   *   - arbitration ALWAYS goes through commitNextTaskProposal — the single
   *     state-machine authority — whose paths are idempotent:
   *       successor_exists / blocked_by_revision / blocked_by_rejection /
   *       revision_reopened (same revisionCauseId → no-op) /
   *       blocked_missing_verdict (fail-closed, surfaced not retried
   *       aggressively — logged once per sweep).
   *   - verdict semantics remain authoritative: needs_revision/rejected
   *     never seed successors through this path.
   *
   * Restart-safe: calling this every consumer cycle is safe; duplicates
   * collapse into the idempotent commit results above.
   */
  async reconcileSucceededTransitions(options?: {
    /** 每周期处理条数上限 (bounded budget, 1..50) */
    limit?: number;
    /** caller 持久化的扫描游标 (restart-durable);缺省从头开始 */
    cursor?: { updatedAt: string; taskId: string };
    logger?: { info?: (msg: string) => void };
  }): Promise<{
    scanned: number;
    recovered: number;
    alreadyMaterialized: number;
    blocked: number;
    outcomes: { taskId: string; decision: string; reason?: string; detail?: string; conflictingSuccessorTaskIds?: string[] }[];
    /** 本周期后的游标 — caller 必须持久化 (A3 restart 语义) */
    nextCursor: { lastUpdatedAt: string; lastTaskId: string };
    /** true = 已扫到尾部,caller 应将游标重置回开头 (wrap-around) */
    wrappedAround: boolean;
  }> {
    const limit = Math.max(1, Math.min(options?.limit ?? 10, 50));
    // A (最终复核): BOUNDED + FAIR + RESTART-DURABLE。
    // - ASC 全序扫描 (updated_at ASC, task_id ASC — SQL 层 ORDER BY, 不是
    //   "LIMIT 后 JS 排序"): 最老的 orphan 优先,天然反 starvation;
    // - 每周期只处理 limit 条 (bounded);
    // - 游标为独占元组 (updatedAt, taskId),重启后从持久位置继续;
    // - 扫到尾部 (返回行数 < limit) → wrappedAround,caller 重置游标回开头,
    //   下一轮重新覆盖新增的 succeeded 任务 (eventual completeness);
    // - 仲裁唯一入口仍是 commitNextTaskProposal;needs_revision/rejected/
    //   missing verdict 在其中继续 fail-closed。
    const fetchLimit = limit; // 仅取本预算行;peer-kind 过滤后不足也不补页
    // (非 peer 行也会推进游标 — 它们无需 reconciliation,跳过即前进)
    const page = await this.stateManager.listTasks({
      status: 'succeeded',
      orderBy: 'updated_at_asc',
      afterCursor: options?.cursor,
      limit: fetchLimit,
    });

    const outcomes: { taskId: string; decision: string; reason?: string; detail?: string; conflictingSuccessorTaskIds?: string[] }[] = [];
    let recovered = 0;
    let alreadyMaterialized = 0;
    let blocked = 0;
    let last: { lastUpdatedAt: string; lastTaskId: string } | undefined;
    for (const task of page) {
      last = { lastUpdatedAt: task.updatedAt, lastTaskId: task.taskId };
      if (!isPeerRunnerKind(task.taskKind)) continue;
      try {
        const result = await this.commitNextTaskProposal(task.taskId);
        const outcome: { taskId: string; decision: string; reason?: string; detail?: string; conflictingSuccessorTaskIds?: string[] } = {
          taskId: task.taskId, decision: result.decision,
        };
        if ('reason' in result) outcome.reason = result.reason;
        if ('detail' in result && result.detail !== undefined) outcome.detail = result.detail;
        if ('conflictingSuccessorTaskIds' in result) outcome.conflictingSuccessorTaskIds = [...result.conflictingSuccessorTaskIds];
        outcomes.push(outcome);
        if (result.decision === 'successor_created' || result.decision === 'revision_reopened' || result.decision === 'successor_reopened'
          || result.decision === 'source_correction_reopened') {
          recovered += 1;
          options?.logger?.info?.(`[PD:Reconcile] recovered missing transition for ${task.taskId} (${result.decision})`);
        } else if (result.decision === 'successor_exists' || result.decision === 'revision_reopen_noop'
          || result.decision === 'source_correction_reopen_noop') {
          alreadyMaterialized += 1;
        } else {
          // blocked_by_revision / blocked_by_rejection / blocked_missing_verdict /
          // no_successor — legitimate terminal/no-op verdicts, counted not acted on
          blocked += 1;
        }
      } catch (err) {
        // per-task failure must not abort the sweep; P1: caller 必须让
        // reconcile_error 显式可观测 (不能只在 recovered>0 时打日志)
        outcomes.push({ taskId: task.taskId, decision: `reconcile_error:${err instanceof Error ? err.message : String(err)}` });
        blocked += 1;
      }
    }

    if (page.length === 0) {
      // 尾部已到 (或起点即空): caller 重置游标
      const cur = options?.cursor;
      return {
        scanned: 0, recovered, alreadyMaterialized, blocked, outcomes,
        nextCursor: { lastUpdatedAt: cur?.updatedAt ?? '', lastTaskId: cur?.taskId ?? '' },
        wrappedAround: true,
      };
    }
    const cur = options?.cursor;
    const tail = last ?? { lastUpdatedAt: cur?.updatedAt ?? '', lastTaskId: cur?.taskId ?? '' };
    return {
      scanned: outcomes.length + page.filter((t) => !isPeerRunnerKind(t.taskKind)).length,
      recovered, alreadyMaterialized, blocked, outcomes,
      nextCursor: tail,
      wrappedAround: page.length < fetchLimit,
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
      /**
       * P0-4 revision identity: 同一逻辑修订动作的稳定标识。相同 causeKey 对
       * 已 reopen 目标重放 = 真正 no-op (不递增 revisionCount,不重写反馈);
       * 不同 causeKey = 新修订轮 (正常递增)。未提供时退化为旧行为 (每次 +1,
       * 仅建议内部测试使用;生产调用方必须传)。
       */
      revisionCauseId?: string;
    },
  ): Promise<{ ok: boolean; reason: string; detail?: string }> {
    // PRI-629: 提取至 revision-reopen.ts 的单一核心实现 (Console/CLI 复用),
    // orchestrator 方法保留为兼容委托。
    return reopenTaskForRevision(this.stateManager, taskId, options);
  }

  // ── SPEC-PRI-1047 修复 B: source-correction 定点续接 ──────────────────────

  /**
   * source-correction 新 Scribe 成功后的下游定点 CAS 续接（commitNextTaskProposal
   * 独占分支调用）。与通用级联的差异：
   *   - 只处理 receipt 指定的原 Artificer（不泛化重开所有 NHR）；
   *   - 核对它确因该源材料而停（reasonCode === receipt.expectedStopReasonCode）；
   *   - CAS（updateTaskIfDiagnosticJsonUnchanged + expectedStatus）而非无条件写；
   *   - 保留原 taskId 与依赖关系——Artificer 依赖仍是原 scribe 任务，经
   *     pi-artifact-store 的 MAX(revision_epoch) 当前视图自然消费新工件；
   *   - 结果回填 receipt.reopenOutcome（崩溃重放经 artificer revisionCauseId
   *     幂等识别）。Scribe 失败/NHR 时本方法不可达（commitNextTaskProposal
   *     早退）——下游零重开。
   */
  private async reopenArtificerForSourceCorrection(
    scribeTaskId: string,
    scribePi: PITaskRecord,
  ): Promise<CommitNextTaskResult> {
    const receipt: SourceCorrectionReceiptV1 | undefined = scribePi.sourceCorrectionReceipt;
    // 调用点已保证存在；防御性回退（rc-3 fail loud 而非静默）。
    if (receipt === undefined) {
      return { decision: 'invalid_task_metadata', taskId: scribeTaskId, reason: 'source_correction_receipt_missing' };
    }
    const causeId = scribePi.sourceCorrectionCauseId
      ?? `rule-source-correction:${receipt.candidateId}:${receipt.bindingRevision}`;
    const { artificerTaskId } = receipt;

    // PRI-1047 Owner review R6 #3: CAS 丢失 ≠ 终态冲突。并发写者可能只改了
    // 无关信息（diagnosticJson 任意字段、账本/遥测无关写）；守卫（cause/
    // 在途/状态/停点）在丢失后的最新行上全部成立时，重试整个「读取→守卫→
    // CAS」序列。只有守卫真的漂移（被下方守卫分类为具体 conflict/in-flight/
    // earlier）或重试用尽仍持续丢失（持续竞争，罕见）才记录终态 outcome——
    // 否则一次普通并发更新就会把恢复永久记为 conflict，重放一律跳过，
    // 原 Artificer 永远暂停。每次迭代从头重读当前行（rc-7），不携带旧
    // 迭代的错误与结果。
    for (let attempt = 0; attempt < SOURCE_CORRECTION_REOPEN_CAS_ATTEMPTS; attempt += 1) {
      const artificerTask = await this.stateManager.getTask(artificerTaskId);
      if (!artificerTask) {
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'task_missing', recordedAt: new Date().toISOString() });
        return { decision: 'source_correction_reopen_failed', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: 'artificer_task_missing' };
      }
      const artificerPi = hydratePITaskRecord(artificerTask);
      if (!artificerPi) {
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'conflict', recordedAt: new Date().toISOString(), detail: 'artificer_metadata_invalid' });
        return { decision: 'source_correction_reopen_conflict', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: 'artificer_metadata_invalid' };
      }
      // 崩溃重放：Artificer 已带本 cause（上次续接已 materialize）→ 幂等 no-op。
      if (hasConsumedRevisionCause(artificerPi, causeId)) {
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'reopened_earlier', recordedAt: new Date().toISOString() });
        return { decision: 'source_correction_reopen_noop', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: 'source_correction_cause_already_materialized' };
      }
      // 他因在途（如 Owner 已用 retry 恢复）→ 不抢写；在途任务经 MAX(revision_epoch)
      // 视图消费新工件，链路自然续接。
      if (artificerTask.status === 'pending' || artificerTask.status === 'retry_wait') {
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'already_in_flight', recordedAt: new Date().toISOString() });
        return { decision: 'source_correction_reopen_noop', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: `artificer_in_flight_${artificerTask.status}` };
      }
      if (artificerTask.status !== 'needs_human_review') {
        const detail = `artificer_status_${artificerTask.status}`;
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'conflict', recordedAt: new Date().toISOString(), detail });
        return { decision: 'source_correction_reopen_conflict', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: detail };
      }
      const stopReasonCode = artificerPi.humanReviewContext?.reasonCode ?? '';
      if (stopReasonCode !== receipt.expectedStopReasonCode) {
        const detail = `stop_reason_drifted:${stopReasonCode || 'none'}!=${receipt.expectedStopReasonCode}`;
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'conflict', recordedAt: new Date().toISOString(), detail });
        return { decision: 'source_correction_reopen_conflict', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: detail };
      }
      // PRI-1293 Phase 3: 定点续接是生产 reopen 路径 — 与 commit/reopen 核心
      // 共享同一血缘权威。守卫通过后、CAS 写之前校验; 拒绝 = conflict 终态
      // 可观测 (receipt outcome 落库), 零写入。
      const artificerLineage = await resolveAuthoritativeCorrelationIdWithLegacyBackfill(
        artificerTask,
        this.stateManager,
      );
      if (!artificerLineage.ok) {
        await this.recordSourceCorrectionOutcome(scribeTaskId, {
          kind: 'conflict',
          recordedAt: new Date().toISOString(),
          detail: `lineage_refused:${artificerLineage.reason}`,
        });
        return {
          decision: 'source_correction_reopen_conflict',
          sourceTaskId: scribeTaskId,
          reopenedTaskId: artificerTaskId,
          reason: `lineage_refused:${artificerLineage.reason}`,
        };
      }
      const merged = mergePITaskMetadata(artificerPi, {
        runnerDecision: undefined,
        completionIntent: undefined,
        revisionCount: (artificerPi.revisionCount ?? 0) + 1,
        revisionCauseId: causeId,
        // §5.3.7: 可恢复历史链在续接写中补入已验证的 correlationId。
        ...(artificerLineage.correlationId !== (artificerPi.correlationId?.trim() ?? '')
          ? { correlationId: artificerLineage.correlationId }
          : {}),
      });
      const updated = await this.stateManager.updateTaskIfDiagnosticJsonUnchanged(
        artificerTaskId,
        artificerTask.diagnosticJson ?? null,
        {
          diagnosticJson: createPITaskDiagnosticJson(merged),
          status: 'pending',
          attemptCount: 0,
          ...(artificerTask.leaseOwner || artificerTask.leaseExpiresAt ? { leaseOwner: null, leaseExpiresAt: null } : {}),
        },
        {
          expectedStatus: 'needs_human_review',
          expectedAttemptCount: artificerTask.attemptCount,
          expectedMaxAttempts: artificerTask.maxAttempts,
          expectedLeaseOwner: artificerTask.leaseOwner ?? null,
          expectedLeaseExpiresAt: artificerTask.leaseExpiresAt ?? null,
        },
      );
      if (updated) {
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'reopened', recordedAt: new Date().toISOString() });
        return { decision: 'source_correction_reopened', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: 'original_artificer_reopened_on_new_scribe_epoch' };
      }
      // CAS 丢失：并发写者竞得。若其恰好 materialize 了同一 cause → 幂等
      // no-op；否则回到循环头对最新行重跑全部守卫——瞬时竞争自然重试，
      // 真实漂移被守卫重新分类，不再误记终态 conflict。
      const current = await this.stateManager.getTask(artificerTaskId);
      const currentPi = current ? hydratePITaskRecord(current) : null;
      if (currentPi && hasConsumedRevisionCause(currentPi, causeId)) {
        await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'reopened_earlier', recordedAt: new Date().toISOString() });
        return { decision: 'source_correction_reopen_noop', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: 'concurrent_writer_materialized_same_cause' };
      }
    }
    // 重试用尽而守卫始终成立 = 持续并发写者（罕见）。终态可观测；下次
    // reconciliation 重放经 cause 已 materialize 判定幂等，不会二次消费。
    const detail = `cas_retry_exhausted:${SOURCE_CORRECTION_REOPEN_CAS_ATTEMPTS}`;
    await this.recordSourceCorrectionOutcome(scribeTaskId, { kind: 'conflict', recordedAt: new Date().toISOString(), detail });
    return { decision: 'source_correction_reopen_conflict', sourceTaskId: scribeTaskId, reopenedTaskId: artificerTaskId, reason: detail };
  }

  /**
   * 回填 receipt.reopenOutcome（scribe 任务元数据，CAS）。回填失败不回滚
   * 已发生的 Artificer 续接——重放经 artificer revisionCauseId === cause 幂等
   * 识别为 reopened_earlier（rc-7：重放读取当前状态而非本调用旧快照）。
   */
  private async recordSourceCorrectionOutcome(
    scribeTaskId: string,
    outcome: NonNullable<SourceCorrectionReceiptV1['reopenOutcome']>,
  ): Promise<void> {
    // 单次重试的 CAS 回填：每次都重读当前行（rc-7），CAS 失败（并发写者）
    // 再试一次；仍失败则返回 false——调用方返回值/后续 reconciliation 重放
    // 经 artificer revisionCauseId === cause 幂等兜底，且回填缺失可由
    // outcome_recorded 判定路径观测（rc-9：不静默吞掉）。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await this.stateManager.getTask(scribeTaskId);
      const currentPi = current ? hydratePITaskRecord(current) : null;
      if (!current || !currentPi || currentPi.sourceCorrectionReceipt === undefined) return;
      if (currentPi.sourceCorrectionReceipt.reopenOutcome !== undefined) return; // 已回填（并发重放）
      const merged = mergePITaskMetadata(currentPi, {
        sourceCorrectionReceipt: { ...currentPi.sourceCorrectionReceipt, reopenOutcome: outcome },
      });
      const updated = await this.stateManager.updateTaskIfDiagnosticJsonUnchanged(
        scribeTaskId,
        current.diagnosticJson ?? null,
        { diagnosticJson: createPITaskDiagnosticJson(merged) },
      );
      if (updated) return;
    }
  }

  /**
   * Find the logical successor by (parentTaskId, successorKind, channel) across
   * ALL task statuses — the lineage-truth counterpart of the derived-id lookup.
   *
   * Successor identity is the parentage relation, not the derived id:
   *   - revision reopen backfills the recovered correlationId into the source,
   *     shifting the derivation root away from the persisted id (PRI-1293 R2);
   *   - the RuleHost synchronous chain persists timestamp-suffixed ids that the
   *     deterministic derivation never reproduces (PRI-1293 R3).
   * ANY persisted row — in-flight (pending/leased/retry_wait), terminal
   * (succeeded/needs_human_review) or failed — proves the logical successor
   * already exists. This mirrors the semantics the deterministic-id UNIQUE
   * constraint catch used to provide as a last resort, extended to chains
   * whose ids are not derivable. Deterministic: ties break by taskId.
   */
  private async findSuccessorByParent(
    parentTaskId: string,
    successorKind: RunnerKind,
    channel: string,
  ): Promise<TaskRecord[]> {
    // PRI-1293 R5 (F4 部分缓解): taskKind 过滤下推至 SQL WHERE task_kind = ?
    // (sqlite-task-store 既有能力), 扫描行数从全表收敛到单一 kind。
    // parentTaskId 的 json_extract 下推与批量复合索引属 PRI-1299 范围
    // (统一 Successor Lookup) — 本处是有界缓解而非完整修复。
    const allTasks = await this.stateManager.listTasks({ statuses: [...PD_TASK_STATUSES], taskKind: successorKind });
    const matches: TaskRecord[] = [];
    for (const task of allTasks) {
      if (task.taskKind !== successorKind) continue;
      const piTask = hydratePITaskRecord(task);
      if (!piTask) continue;
      if (piTask.parentTaskId === parentTaskId && piTask.channel === channel) {
        matches.push(task);
      }
    }
    matches.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
    return matches;
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
      // PRI-798: oldest-first (updated_at ASC) is the lease-order contract.
      // Without an explicit orderBy the SQL layer returns insertion order —
      // an undeclared contract that mis-leases across pains when an older
      // chain's tasks sit in the queue next to a newer one. Mirrors the
      // anti-starvation ordering of reconcileSucceededTransitions.
      const pending = await this.stateManager.listTasks({ status: 'pending', orderBy: 'updated_at_asc' });
      const retryWait = await this.stateManager.listTasks({ status: 'retry_wait', orderBy: 'updated_at_asc' });
      allCandidates.push(...pending, ...retryWait);
      // P1-1 (PRI-798): merge the two separately-ordered buckets into a single
      // globally oldest-first sequence.  Each bucket is ASC-sorted within
      // itself, but concatenating them leaves cross-bucket ordering undefined.
      // Sort here so that a retry_wait task updated at T1 is always considered
      // before a pending task updated at T2 > T1.  taskId breaks ties for
      // deterministic test behaviour.
      allCandidates.sort((a, b) =>
        a.updatedAt < b.updatedAt ? -1
        : a.updatedAt > b.updatedAt ? 1
        : a.taskId < b.taskId ? -1
        : a.taskId > b.taskId ? 1
        : 0
      );
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
