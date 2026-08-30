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
 *
 * P0-3 (外部复核): 决策型 runner 的 verdict **fail-closed** —
 *   - durable runnerDecision (任务元数据) 是第一判据;
 *   - 缺失时,只有 runs.output_payload 里**显式可解析**的历史 verdict 才可作为
 *     legacy 判据 (评估器/评审器的真实产物,不是猜测);
 *   - 两者皆无 → NOT_ADVANCEABLE (blocked, 需人工/reconciliation),
 *     禁止 "missing decision = legacy ADVANCE" —— 那会复活审计要消灭的
 *     needs_revision 错误旁路。
 */

import type { PITaskRecord } from './peer-runner-contracts.js';
import { resolveEffectiveRunnerDecision } from './owner-review.js';

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
  | 'NOT_ADVANCEABLE'
  /** P0-3: 决策型任务缺少 durable verdict 且 legacy 解析失败 — fail-closed 阻断 */
  | 'BLOCKED_MISSING_VERDICT';

export interface TransitionDecisionInput {
  taskKind: string;
  taskStatus: string;
  runnerDecision?: string;
  /**
   * P0-3 legacy 判据: 从该任务最近 succeeded run 的 output_payload 显式解析出的
   * verdict (evaluation.decision / review.decision)。调用方负责解析与校验;
   * undefined = 无可解析历史 verdict。
   */
  legacyRunnerDecision?: string;
  /** artificer 任务携带 repairPayload (PRI-509 repair 任务) */
  isRepairTask: boolean;
  revisionCount: number;
}

export interface TransitionDecision {
  kind: InternalizationTransitionDecisionKind;
  reason: string;
}

const EVALUATOR_VERDICTS = new Set(['approved', 'needs_revision', 'rejected']);
const ROLLOUT_VERDICTS = new Set(['approve_rollout', 'needs_revision', 'reject']);

/**
 * 纯决策: 依据任务状态 + runner 判定,决定该任务完成后链上应发生什么。
 * 调用方 (orchestrator.commitNextTaskProposal) 是唯一后继播种漏斗。
 */
export function decideInternalizationTransition(input: TransitionDecisionInput): TransitionDecision {
  const { taskKind, taskStatus, runnerDecision, legacyRunnerDecision, isRepairTask, revisionCount } = input;

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

  // 3. 决策型 runner: durable verdict 第一,显式 legacy verdict 第二,皆无 → 阻断 (P0-3)
  if (taskKind === 'evaluator') {
    const verdict = runnerDecision
      ?? (legacyRunnerDecision !== undefined && EVALUATOR_VERDICTS.has(legacyRunnerDecision) ? legacyRunnerDecision : undefined);
    if (verdict === undefined) {
      return { kind: 'BLOCKED_MISSING_VERDICT', reason: 'evaluator_verdict_missing_durable_and_legacy' };
    }
    if (verdict === 'approved') {
      return { kind: 'ADVANCE', reason: 'evaluator_approved' };
    }
    if (verdict === 'needs_revision') {
      return { kind: 'REVISION_REQUIRED', reason: 'evaluator_needs_revision_repair_loop' };
    }
    return { kind: 'TERMINAL_REJECT', reason: 'evaluator_rejected' };
  }

  if (taskKind === 'rollout_reviewer') {
    const verdict = runnerDecision
      ?? (legacyRunnerDecision !== undefined && ROLLOUT_VERDICTS.has(legacyRunnerDecision) ? legacyRunnerDecision : undefined);
    if (verdict === undefined) {
      return { kind: 'BLOCKED_MISSING_VERDICT', reason: 'rollout_verdict_missing_durable_and_legacy' };
    }
    if (verdict === 'approve_rollout') {
      // job-graph 终节点: ADVANCE 语义 = activation dispatch (runner 侧已内联执行)
      return { kind: 'ADVANCE', reason: 'rollout_approved_dispatch_activation' };
    }
    if (verdict === 'needs_revision') {
      return { kind: 'REVISION_REQUIRED', reason: 'rollout_needs_revision_routed_upstream' };
    }
    return { kind: 'TERMINAL_REJECT', reason: 'rollout_rejected_no_activation' };
  }

  // 4. 非决策型 runner (dreamer/philosopher/scribe/artificer 常规): 正常推进
  return { kind: 'ADVANCE', reason: `task_succeeded_${taskKind}` };
}

/**
 * 从 PITaskRecord 提取决策输入的便利投影 (legacy 判据由调用方解析后传入)。
 *
 * PRI-629: runnerDecision 一律取 effective decision (resolveEffectiveRunnerDecision
 * 的唯一解析点) — Owner applied override (accept_current/reject_current) 后,
 * 仲裁看到的是 effectiveDecision;机器原始 runnerDecision 永不改写 (INV-03)。
 */
export function transitionInputFromTask(
  piTask: PITaskRecord,
  legacyRunnerDecision?: string,
): TransitionDecisionInput {
  return {
    taskKind: piTask.taskKind,
    taskStatus: piTask.status,
    runnerDecision: resolveEffectiveRunnerDecision(piTask),
    legacyRunnerDecision,
    isRepairTask: piTask.repairPayload !== undefined,
    revisionCount: piTask.revisionCount ?? 0,
  };
}
