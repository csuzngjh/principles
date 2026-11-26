/**
 * revision-reopen.ts — revision reopen / 修订目标解析的单一核心实现 (PRI-629 提取)。
 *
 * 此前 reopenTaskForRevision 是 InternalizationOrchestrator 的方法、rollout 的
 * resolveRevisionTarget 是 runner 的私有方法 — PRI-629 的 Owner revise_once 需要
 * 在 Console/CLI 侧复用同一能力,故提取为自由函数,orchestrator/runner 委托至此,
 * 保持单一来源 (P4 One Source of Truth)。
 */

import type { TaskRecord } from '../task-status.js';
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import type { PITaskRecord } from './peer-runner-contracts.js';
import { isPeerRunnerKind } from './peer-runner-contracts.js';
// PRI-1293 Phase 3: reopen 与 commit 共享同一唯一血缘权威 (§5.3 — 只包
// orchestrator wrapper 不合格; 此处是四条生产 reopen 路径的共同核心)。
import { resolveAuthoritativeCorrelationIdWithLegacyBackfill } from './correlation-lineage.js';
import {
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
  hasConsumedRevisionCause,
  type PITaskMetadata,
} from './pitask-metadata.js';

/**
 * PRI-629 P0 (SPEC §12): repair artificer 完成后 reopen 来源 evaluator 的
 * epoch-aware causal identity。
 *   rc0 (首次完成)        → `repair-<taskId>`          — 与历史格式兼容
 *   rcN (Owner revise_once 重开后再完成) → `repair-<taskId>-rc<N>`
 * 语义: same epoch replay (crash/reconciliation 重放同一次完成) → 相同
 * causeId → 真 no-op;Owner 授权的新修订轮 → revisionCount 已 +1 → 新
 * causeId → 真 reopen。
 */
export function buildRepairRevisionCauseId(task: PITaskRecord): string {
  const rc = task.revisionCount ?? 0;
  return rc === 0
    ? `repair-${task.taskId}`
    : `repair-${task.taskId}-rc${rc}`;
}

/**
 * PRI-1293 R5: 级联 wave 的因果标识——单一构造点。
 * 此前格式内联在 orchestrator 级联块, 预览/消费方无法复用同一推导。
 */
export function buildCascadeRevisionCauseId(sourceTaskId: string, sourceRevisionCount: number, cascadeTargetTaskId: string): string {
  return `cascade-${sourceTaskId}-rc${sourceRevisionCount}-${cascadeTargetTaskId}`;
}

/**
 * PRI-1293 R5 (预览漏报重开): 已存在后继的迁移判定——**唯一只读计划入口**。
 * commit 路径 (internalization-orchestrator) 与 dry-run 预览
 * (pd-cli enqueue-successors) 必须经本函数获得同一判定:
 *   - exists_plain:               非终态后继, 或源未经历 revision (rc=0)
 *                                 — confirm 只报告 successor_exists, 零写入;
 *   - cascade_reopen:             终态后继 + 源 rc>0 + 本 wave cause 未消费
 *                                 — confirm 将 reopen 该后继 (清除旧 verdict,
 *                                 重置 status/attemptCount), 预览必须显式
 *                                 报告 would_reopen 而非 successor_exists;
 *   - cascade_already_materialized: 本 wave cause 已消费 (含历史折入后的
 *                                 成员判定) — confirm 幂等 no-op, 零写入。
 * 纯函数不读不写 store; 调用方负责 hydrate 后继并提供字段。
 */
export type ExistingSuccessorTransitionPlan =
  | { readonly plan: 'exists_plain' }
  | { readonly plan: 'cascade_reopen'; readonly cascadeCauseId: string }
  | { readonly plan: 'cascade_already_materialized'; readonly cascadeCauseId: string };

export function planExistingSuccessorTransition(input: {
  readonly sourceTaskId: string;
  readonly sourceRevisionCount: number;
  readonly successorTaskId: string;
  readonly successorStatus: string;
  readonly successorRevisionCauseId?: string | undefined;
  readonly successorConsumedRevisionCauseIds?: readonly string[] | undefined;
}): ExistingSuccessorTransitionPlan {
  const terminal = input.successorStatus === 'succeeded' || input.successorStatus === 'needs_human_review';
  if (!terminal || input.sourceRevisionCount <= 0) {
    return { plan: 'exists_plain' };
  }
  const cascadeCauseId = buildCascadeRevisionCauseId(input.sourceTaskId, input.sourceRevisionCount, input.successorTaskId);
  if (hasConsumedRevisionCause(
    { revisionCauseId: input.successorRevisionCauseId, consumedRevisionCauseIds: input.successorConsumedRevisionCauseIds },
    cascadeCauseId,
  )) {
    return { plan: 'cascade_already_materialized', cascadeCauseId };
  }
  return { plan: 'cascade_reopen', cascadeCauseId };
}

export interface ReopenRevisionOptions {
  revisionFeedback?: string;
  replaceArtificerDependencyWith?: string;
  reason?: string;
  /**
   * P0-4 revision identity: 同一逻辑修订动作的稳定标识。相同 causeKey 对
   * 已 reopen 目标重放 = 真正 no-op (不递增 revisionCount);不同 causeKey =
   * 新修订轮。生产调用方必须传。
   */
  revisionCauseId?: string;
}

/**
 * Reopen a terminal (succeeded / needs_human_review) task for a revision round:
 * status → pending, attemptCount reset, revisionCount++, optional feedback
 * injected, optional artificer dependency swap.
 *
 * Idempotent (INV-08): target already pending/retry_wait with the same
 * revisionCauseId → true no-op. Restart-safe: all state is durable.
 */
export async function reopenTaskForRevision(
  stateManager: RuntimeStateManager,
  taskId: string,
  options?: ReopenRevisionOptions,
): Promise<{ ok: boolean; reason: string; detail?: string }> {
  const rawTask = await stateManager.getTask(taskId);
  if (!rawTask) {
    return { ok: false, reason: 'task_not_found' };
  }
  const piTask = hydratePITaskRecord(rawTask);
  if (!piTask) {
    return { ok: false, reason: 'invalid_task_metadata' };
  }
  // P1 评审修复 (crash-window idempotency): 同一 causeKey 的重放对 **任何**
  // 状态都是真 no-op——不再局限于 pending/retry_wait。此前 metadata+status
  // 是两次写,两写之间 crash 会留下 "terminal 状态 + 已写 causeId" 的残留,
  // 重放会再递增 revisionCount (破坏一次点击 = 一个 revision epoch)。
  // 单行原子写 + 全状态同因 no-op 双保险。
  // PRI-1293 R5: 幂等判定读消费历史而非单槽——单槽会被独立因果流
  // (cascade/repair/owner) 覆盖, 覆盖后旧 cause 的保护失效。
  if (options?.revisionCauseId && hasConsumedRevisionCause(piTask, options.revisionCauseId)) {
    return { ok: true, reason: 'idempotent_replay_same_revision' };
  }
  if (rawTask.status === 'pending' || rawTask.status === 'retry_wait') {
    // 不同 causeKey / 无 causeKey — 更新依赖/反馈后继续 (保证 revision 输入最新)
  } else if (rawTask.status !== 'succeeded' && rawTask.status !== 'needs_human_review') {
    return { ok: false, reason: `task_in_flight_${rawTask.status}` };
  }

  // ── PRI-1293 Phase 3: 血缘门禁 (所有生产 reopen 路径的同一关口) ──
  // 覆盖: Owner revise_once (owner-resolution 直接调本函数)、rollout
  // needs_revision (governance 经 orchestrator 委托)、repair 完成后 reopen
  // 来源 evaluator (orchestrator REOPEN_SOURCE_EVALUATOR)、revision cascade。
  // causeId 幂等重放短路已在其上 — 同因重放不重复校验也不写状态。
  // 校验先于任何写入: 拒绝 = 零 mutation + 结构化 reason (rc-9)。
  // DiagnosticianStageKind 目标不在本函数的生产目标集合内; 防御性跳过
  // (血缘门禁严格限于 PeerRunnerKind, §4.2 作用域隔离)。
  let authoritativeCorrelationId: string | undefined;
  if (isPeerRunnerKind(piTask.taskKind)) {
    const lineage = await resolveAuthoritativeCorrelationIdWithLegacyBackfill(rawTask, stateManager);
    if (!lineage.ok) {
      return { ok: false, reason: `lineage_refused:${lineage.reason}`, detail: lineage.detail };
    }
    // 可恢复历史任务: 校验通过后把根侧恢复的 id 安全补入本次 reopen 写
    // (§5.3.7) — 走 mergePITaskMetadata 的既有 28 字段机制, 不新增真值源。
    authoritativeCorrelationId
      = lineage.correlationId !== (piTask.correlationId?.trim() ?? '') ? lineage.correlationId : undefined;
  }

  const merged: PITaskMetadata = mergePITaskMetadata(piTask, {
    runnerDecision: undefined, // 新一轮 verdict 未定,清空旧判定 (INV-02 单一决策依据)
    // P0 verdict drift: revision reopen = 新 execution epoch — 旧 completion
    // intent 失去 authority,必须随旧 verdict 一并清空;否则重跑时入口门
    // 会 resume 旧 intent,新 epoch 的重新评估被永远跳过。
    completionIntent: undefined,
    revisionCount: (piTask.revisionCount ?? 0) + 1,
    revisionFeedback: options?.revisionFeedback ?? piTask.revisionFeedback,
    revisionCauseId: options?.revisionCauseId,
    // PRI-1293 R5: 消费历史折入由 mergePITaskMetadata 的写不变量自动执行
    // (覆盖 revisionCauseId 槽时旧槽值+新值一并并入, 全写路径统一)。
    ...(authoritativeCorrelationId !== undefined ? { correlationId: authoritativeCorrelationId } : {}),
  });

  if (options?.replaceArtificerDependencyWith) {
    // 替换 artificer 依赖为指定任务(修订轮读取其 repairPayload/artifacts)。
    // 链是线性的: evaluator 的 artificer dep 只有一个。
    const nonArtificerDeps: string[] = [];
    for (const depId of piTask.dependencyTaskIds) {
      if (depId === options.replaceArtificerDependencyWith) continue;
      const dep = await stateManager.getTask(depId);
      if (dep && dep.taskKind === 'artificer') continue;
      nonArtificerDeps.push(depId);
    }
    merged.dependencyTaskIds = [...nonArtificerDeps, options.replaceArtificerDependencyWith];
    // 修订轮 evaluator 的输入 artifact 来自新 artificer 任务的产出
    merged.inputArtifactRefs = [];
  }

  // P1 评审修复: 单次 task-row mutation——metadata + status + attemptCount
  // 一个 UPDATE 落库,消除 "metadata 已写但 status 未翻" 的 crash 窗口。
  // PRI-1293 review fix (并发安全): 上面的血缘门禁是异步多跳读取,期间另一
  // consumer 可能已把任务 lease 走 — 无条件 updateTask 会把 status 覆盖回
  // pending、attemptCount 清零,却不动 lease_owner/lease_expires_at,造成
  // lease 与状态不一致及重复执行。因此写入必须 CAS: 断言读取时的
  // diagnosticJson/status/attemptCount/maxAttempts/leaseOwner/leaseExpiresAt/
  // leaseGeneration 全部未变; 任一被并发触碰 → 放弃写入, 返回明确并发冲突,
  // 由下一轮 reconciliation/调用方重试 (reopen 本身幂等, 重试安全)。
  const casResult = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
    taskId,
    rawTask.diagnosticJson ?? null,
    {
      diagnosticJson: createPITaskDiagnosticJson(merged),
      status: 'pending',
      attemptCount: 0,
    },
    {
      expectedStatus: rawTask.status,
      expectedAttemptCount: rawTask.attemptCount,
      expectedMaxAttempts: rawTask.maxAttempts,
      expectedLeaseOwner: rawTask.leaseOwner ?? null,
      expectedLeaseExpiresAt: rawTask.leaseExpiresAt ?? null,
      expectedLeaseGeneration: rawTask.leaseGeneration ?? 0,
    },
  );
  if (casResult === null) {
    // PRI-1293 review round 3: CAS 落败后重读 — 若并发执行者完成的正是**同一
    // revisionCauseId** 的 reopen, 本轮修订已 materialize, 按幂等重放处理
    // (诚实事实, 非伪装); 否则返回明确的并发冲突, 由下一轮重试。
    if (options?.revisionCauseId !== undefined) {
      const reread = await stateManager.getTask(taskId);
      const rereadPi = reread ? hydratePITaskRecord(reread) : null;
      if (rereadPi && hasConsumedRevisionCause(rereadPi, options.revisionCauseId)) {
        return { ok: true, reason: 'idempotent_replay_same_revision' };
      }
    }
    return {
      ok: false,
      reason: 'concurrent_modification',
      detail: `cas_precondition_failed:${taskId} — task state changed during lineage validation (likely leased concurrently); reopen NOT applied, retry next wave`,
    };
  }
  return { ok: true, reason: options?.reason ?? 'revision_reopen' };
}

export interface RolloutRevisionTarget {
  taskId: string;
  kind: 'scribe' | 'artificer';
}

/**
 * 解析 rollout needs_revision 的修订目标 (只读遍历 dep 链):
 *   rollout → evaluator → artificer → scribe (code 链);
 *   rollout → scribe (PRI-720 principle 语义链: scribe 是直接依赖)。
 * code_tool_hook → artificer (规则实现); 其他 channel → scribe (走到底)。
 * 与 RolloutReviewerRunner 的路由规则保持同一实现 (单一来源)。
 */
export async function resolveRolloutRevisionTarget(
  getTask: (taskId: string) => Promise<TaskRecord | null>,
  taskId: string,
  channel: string,
): Promise<RolloutRevisionTarget | null> {
  const rawTask = await getTask(taskId);
  if (!rawTask) return null;
  const piTask = hydratePITaskRecord(rawTask);

  // 第一跳: rollout deps → evaluator; evaluator deps → artificer
  let artificerTaskId: string | null = null;
  let artificerDeps: string[] = [];
  const firstHop = piTask?.dependencyTaskIds ?? [];
  for (const depId of firstHop) {
    const dep = await getTask(depId);
    if (!dep) continue;
    if (dep.taskKind === 'artificer') {
      const depPi = hydratePITaskRecord(dep);
      artificerTaskId = dep.taskId;
      artificerDeps = depPi?.dependencyTaskIds ?? [];
      break;
    }
    if (dep.taskKind === 'evaluator') {
      const evalPi = hydratePITaskRecord(dep);
      for (const evalDepId of evalPi?.dependencyTaskIds ?? []) {
        const evalDep = await getTask(evalDepId);
        if (!evalDep || evalDep.taskKind !== 'artificer') continue;
        const evalDepPi = hydratePITaskRecord(evalDep);
        artificerTaskId = evalDep.taskId;
        artificerDeps = evalDepPi?.dependencyTaskIds ?? [];
        break;
      }
      if (artificerTaskId) break;
    }
  }
  if (!artificerTaskId) {
    // PRI-720 (C4): principle semantic chain — the scribe is a DIRECT dep of
    // the rollout (the graph never created an artificer/evaluator). Route the
    // revision straight back to the authoring scribe (Owner revise_once
    // included) instead of dead-ending in needs_human_review.
    for (const depId of firstHop) {
      const dep = await getTask(depId);
      if (!dep || dep.taskKind !== 'scribe') continue;
      return { taskId: dep.taskId, kind: 'scribe' };
    }
    return null;
  }

  if (channel === 'code_tool_hook') {
    return { taskId: artificerTaskId, kind: 'artificer' };
  }
  for (const depId of artificerDeps) {
    const dep = await getTask(depId);
    if (!dep || dep.taskKind !== 'scribe') continue;
    return { taskId: dep.taskId, kind: 'scribe' };
  }
  return null;
}
