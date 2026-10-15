/**
 * owner-retry.ts — needs_human_review 的 Owner authority reset（共享实现）。
 *
 * 提取自 pd-cli `runtime internalization retry`（Governance Recovery Actions v1）：
 * CLI 与 Console 恢复入口必须走同一段逻辑（SPEC §5.2 禁止复制 recovery logic；
 * AC-3 Console 行为与 CLI 一致）。
 *
 * Owner retry = 显式人类 authority reset，与 crash retry 严格区分：
 * crash / lease recovery / automatic retry 保留 completionIntent（入口门
 * resume 原 verdict，零 LLM）；Owner retry 必须同时清空 runnerDecision 与
 * completionIntent，允许新一轮 LLM verdict 成为 authority——否则入口门会
 * resume/finalize 旧 verdict，LLM 永不运行，Owner retry 实际失效。
 *
 * 落库形态：status/attemptCount 与清空后的 metadata 在同一次 updateTask
 * （SQLite 单条 UPDATE）中原子生效——两个独立写之间失败会留下
 * "authority 已清但任务仍 needs_human_review" 的 partial Owner action。
 * metadata 不可 hydrate 时 fail closed（metadata_invalid），不得只改 status。
 */
import type { RuntimeStateManager } from '../store/runtime-state-manager.js';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata } from './pitask-metadata.js';
import {
  collectOwnerDecisionFacts,
  deriveOwnerDecisionCapability,
  findPendingOwnerResolutionForCurrentEpoch,
} from './owner-review.js';
import { factStoreFromStateManager } from './owner-resolution-service.js';

export type OwnerRetryOutcome =
  | { status: 'not_found' }
  | { status: 'skipped'; taskKind: string; previousStatus: string }
  | { status: 'metadata_invalid'; taskKind: string }
  | { status: 'requeued'; taskKind: string; previousStatus: string }
  /**
   * PRI-629 Recover guard: decision-capable 人工裁决（或本 epoch 已有
   * resolution）不允许 authority reset — Recover 不是治理出口（SPEC §17/INV-06）。
   * 出口 = 治理焦点的 Owner Decision（open_governance_focus）。
   */
  | { status: 'rejected'; taskKind: string; previousStatus: string; reason: 'owner_decision_required'; nextAction: 'open_governance_focus' }
  /**
   * PRI-983 (SPEC-PD-IAER-001 FR-06/T06): only with `options.expectedDiagnosticJson`
   * — the CAS precondition was lost to a concurrent writer (another resume /
   * metadata mutation landed between this caller's read and write). The task
   * row is untouched; the caller must re-read and re-evaluate. Never returned
   * by the legacy two-argument call shape.
   */
  | { status: 'conflict'; taskKind: string; previousStatus: string };

export interface OwnerRetryOptions {
  /**
   * PRI-983: optional CAS precondition — apply the authority reset ONLY while
   * the task's diagnostic_json is still byte-equal to this value (the caller's
   * read). Absent (the existing two-argument call shape used by
   * `pd runtime internalization retry` and the Console recover endpoint)
   * keeps the exact historical unconditional-write semantics.
   */
  readonly expectedDiagnosticJson?: string | null;
}

/**
 * 对单个 needs_human_review 任务执行 Owner authority reset（→ pending）。
 *
 * 调用方负责 dry-run / 确认门（CLI 默认 dry-run；Console 用确认 Dialog +
 * 显式 POST）。本函数只做 confirm 路径的落库序列：
 *
 *   getTask → status 门（仅 needs_human_review）→ hydratePITaskRecord
 *   （fail closed）→ mergePITaskMetadata 清 runnerDecision/completionIntent
 *   → 单次原子 updateTask({status:'pending', attemptCount:0, diagnosticJson})
 *
 * updateTask 抛错时向上传播（DB 行保持原样，单条 UPDATE 无 partial reset）。
 * 保留 revisionCount / revisionCauseId / rolloutRevisionPayload / repairPayload
 * / lineage —— revision budget 证据不动。
 */
export async function ownerRetryNeedsHumanReviewTask(
  stateManager: RuntimeStateManager,
  taskId: string,
  options?: OwnerRetryOptions,
): Promise<OwnerRetryOutcome> {
  const task = await stateManager.getTask(taskId);
  if (!task) {
    return { status: 'not_found' };
  }

  if (task.status !== 'needs_human_review') {
    return {
      status: 'skipped',
      taskKind: task.taskKind,
      previousStatus: task.status,
    };
  }

  const piTask = hydratePITaskRecord(task);
  if (!piTask) {
    // fail closed: 只改 status 会把(可能损坏的)旧 authority 记录原样留在
    // metadata 里，下一次 run 由它接管 —— 产生 partial retry。
    return { status: 'metadata_invalid', taskKind: task.taskKind };
  }

  // 原子单写: 同一 patch 同时落 status=pending / attemptCount=0 / 清空后的
  // diagnosticJson。updateTask 抛错时 DB 行保持原样(单条 UPDATE)，无 partial reset。
  // ── PRI-629 Recover guard (SPEC §17) ──
  // decision-capable（capability eligible）或本 epoch 已有 resolution（含
  // revise_once 进行中）→ 拒绝。模糊 legacy 事实 → 不阻断（capability 不
  // eligible），保持既有 Recover 行为。core 层强制 — 不只是 UI 隐藏按钮。
  const facts = await collectOwnerDecisionFacts(factStoreFromStateManager(stateManager), taskId);
  if (facts) {
    const capability = deriveOwnerDecisionCapability(facts);
    // P0 评审修复: 只拒 pending resolution（等待 runner 应用，此时 Recover
    // 会与之竞争）。applied resolution 的下游 recovery NHR 必须保持 Recover
    // 出口——resume 门会基于 applied override 确定性重放，否则任务死胡同
    // （Focus 不显示决策、Recover 又被拒）。
    if (capability.eligible || findPendingOwnerResolutionForCurrentEpoch(facts.task)) {
      return {
        status: 'rejected',
        taskKind: task.taskKind,
        previousStatus: task.status,
        reason: 'owner_decision_required',
        nextAction: 'open_governance_focus',
      };
    }
  }

  const merged = mergePITaskMetadata(piTask, {
    runnerDecision: undefined,
    completionIntent: undefined,
  });
  const patch = {
    status: 'pending' as const,
    attemptCount: 0,
    diagnosticJson: createPITaskDiagnosticJson(merged),
  };
  if (options?.expectedDiagnosticJson !== undefined) {
    // PRI-983 CAS variant: single conditional UPDATE — the authority reset
    // lands only while the task row is still byte-identical to the caller's
    // read AND still sits in needs_human_review (SPEC §6.3: 前置状态 + 版本
    // 检查). The status precondition is what arbitrates two concurrent
    // resumes when the reset is content-neutral (an artificer NHR task has no
    // runnerDecision/completionIntent to clear): the first writer moves the
    // status to pending, the second's precondition fails → `conflict`.
    const updated = await stateManager.updateTaskIfDiagnosticJsonUnchanged(
      taskId,
      options.expectedDiagnosticJson,
      patch,
      { expectedStatus: 'needs_human_review' },
    );
    if (!updated) {
      return { status: 'conflict', taskKind: task.taskKind, previousStatus: task.status };
    }
  } else {
    await stateManager.updateTask(taskId, patch);
  }

  return {
    status: 'requeued',
    taskKind: task.taskKind,
    previousStatus: task.status,
  };
}
