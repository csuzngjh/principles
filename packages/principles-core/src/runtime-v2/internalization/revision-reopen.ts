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
import {
  hydratePITaskRecord,
  createPITaskDiagnosticJson,
  mergePITaskMetadata,
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
): Promise<{ ok: boolean; reason: string }> {
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
  if (options?.revisionCauseId && piTask.revisionCauseId === options.revisionCauseId) {
    return { ok: true, reason: 'idempotent_replay_same_revision' };
  }
  if (rawTask.status === 'pending' || rawTask.status === 'retry_wait') {
    // 不同 causeKey / 无 causeKey — 更新依赖/反馈后继续 (保证 revision 输入最新)
  } else if (rawTask.status !== 'succeeded' && rawTask.status !== 'needs_human_review') {
    return { ok: false, reason: `task_in_flight_${rawTask.status}` };
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
  await stateManager.updateTask(taskId, {
    diagnosticJson: createPITaskDiagnosticJson(merged),
    status: 'pending',
    attemptCount: 0,
  });
  return { ok: true, reason: options?.reason ?? 'revision_reopen' };
}

export interface RolloutRevisionTarget {
  taskId: string;
  kind: 'scribe' | 'artificer';
}

/**
 * 解析 rollout needs_revision 的修订目标 (只读遍历 dep 链):
 *   rollout → evaluator → artificer → scribe
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
  if (!artificerTaskId) return null;

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
