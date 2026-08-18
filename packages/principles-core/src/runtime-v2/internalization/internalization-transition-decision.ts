/**
 * InternalizationTransitionDecision — 单一迁移决策 (P0-D, MVP_CORE_LOOP_CONTRACT INV-02/INV-07)。
 *
 * 审计背景 (ISSUE-005): 修复前 auto-consumer 对 runResult.status === 'succeeded'
 * 一律 commitNextTaskProposal → evaluator needs_revision 也会 seed rollout_reviewer
 * (错误并行分支); 即使打开 PRI-509 repair flag, repair_seeded 仍 fall through 到
 * succeeded → 双播种。
 *
 * 语义: runner 输出内容(evaluation/review 的 verdict)与状态迁移必须经同一个
 * 纯决策函数仲裁。非终态必须满足 INV-07: 有自动 successor 或有 Owner action。
 */

import type { PITaskRecord } from './peer-runner-contracts.js';

export type InternalizationTransitionDecisionKind =
  /** 正常推进: seed job-graph 后继 (或对 rollout_reviewer: 触发 activation dispatch) */
  | 'ADVANCE'
  /** needs_revision: 不 seed 正常后继; revision 机制已/将由 runner 侧执行 (repair seed / reopen 路由) */
  | 'REVISION_REQUIRED'
  /** artificer repair 任务完成: reopen 来源 evaluator 重跑修订轮 */
  | 'REOPEN_SOURCE_EVALUATOR'
  /** rejected: 终态拒绝, 不 seed 后继, 不入 approval */
  | 'TERMINAL_REJECT'
  /** needs_human_review: Owner 注意队列 (INV-03), 不 seed 后继 */
  | 'HUMAN_REVIEW_REQUIRED'
  /** 状态不可推进 (非 succeeded 等), 由既有 retry/fail 机制处理 */
  | 'NOT_ADVANCEABLE';

export interface TransitionDecisionInput {
  taskKind: string;
  taskStatus: string;
  runnerDecision?: string;
  /** artificer 任务携带 repairPayload (PRI-509 repair 任务) */
  isRepairTask: boolean;
  revisionCount: number;
}

export interface TransitionDecision {
  kind: InternalizationTransitionDecisionKind;
  reason: string;
}

/**
 * 纯决策: 依据任务状态 + runner 判定,决定该任务完成后链上应发生什么。
 * 调用方 (orchestrator.commitNextTaskProposal) 是唯一后继播种漏斗。
 */
export function decideInternalizationTransition(input: TransitionDecisionInput): TransitionDecision {
  const { taskKind, taskStatus, runnerDecision, isRepairTask, revisionCount } = input;

  // 1. 状态门: 只有 succeeded 的任务参与推进仲裁
  if (taskStatus === 'needs_human_review') {
    return { kind: 'HUMAN_REVIEW_REQUIRED', reason: 'task_awaiting_owner_attention' };
  }
  if (taskStatus !== 'succeeded') {
    return { kind: 'NOT_ADVANCEABLE', reason: `task_status_${taskStatus}` };
  }

  // 2. Repair 任务 (artificer + repairPayload) 完成 → reopen 来源 evaluator,
  //    不走正常后继 seeding (evaluator 任务已存在于同 lineage, 稳定 id 会冲突)。
  if (isRepairTask && taskKind === 'artificer') {
    return { kind: 'REOPEN_SOURCE_EVALUATOR', reason: `repair_round_complete_revision_${revisionCount}` };
  }

  // 3. 决策型 runner: evaluator / rollout_reviewer 的 verdict 决定出边
  if (taskKind === 'evaluator') {
    if (runnerDecision === 'approved') {
      return { kind: 'ADVANCE', reason: 'evaluator_approved' };
    }
    if (runnerDecision === 'needs_revision') {
      return { kind: 'REVISION_REQUIRED', reason: 'evaluator_needs_revision_repair_loop' };
    }
    if (runnerDecision === 'rejected') {
      return { kind: 'TERMINAL_REJECT', reason: 'evaluator_rejected' };
    }
    // 无 runnerDecision 记录(历史数据/旧 runner): 保持 legacy 推进语义,
    // 由 reopen 级联与 idempotency 兜底。
    return { kind: 'ADVANCE', reason: 'evaluator_no_decision_recorded_legacy' };
  }

  if (taskKind === 'rollout_reviewer') {
    if (runnerDecision === 'approve_rollout') {
      // job-graph 终节点: ADVANCE 语义 = 触发 activation dispatch (runner 侧 hook)
      return { kind: 'ADVANCE', reason: 'rollout_approved_dispatch_activation' };
    }
    if (runnerDecision === 'needs_revision') {
      return { kind: 'REVISION_REQUIRED', reason: 'rollout_needs_revision_routed_upstream' };
    }
    if (runnerDecision === 'reject') {
      return { kind: 'TERMINAL_REJECT', reason: 'rollout_rejected_no_activation' };
    }
    return { kind: 'ADVANCE', reason: 'rollout_no_decision_recorded_legacy' };
  }

  // 4. 非决策型 runner (dreamer/philosopher/scribe/artificer 常规): 正常推进
  return { kind: 'ADVANCE', reason: `task_succeeded_${taskKind}` };
}

/** 从 PITaskRecord 提取决策输入的便利投影 */
export function transitionInputFromTask(piTask: PITaskRecord): TransitionDecisionInput {
  return {
    taskKind: piTask.taskKind,
    taskStatus: piTask.status,
    runnerDecision: piTask.runnerDecision,
    isRepairTask: piTask.repairPayload !== undefined,
    revisionCount: piTask.revisionCount ?? 0,
  };
}
