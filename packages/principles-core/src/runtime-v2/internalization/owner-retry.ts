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

export type OwnerRetryOutcome =
  | { status: 'not_found' }
  | { status: 'skipped'; taskKind: string; previousStatus: string }
  | { status: 'metadata_invalid'; taskKind: string }
  | { status: 'requeued'; taskKind: string; previousStatus: string };

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
  const merged = mergePITaskMetadata(piTask, {
    runnerDecision: undefined,
    completionIntent: undefined,
  });
  await stateManager.updateTask(taskId, {
    status: 'pending',
    attemptCount: 0,
    diagnosticJson: createPITaskDiagnosticJson(merged),
  });

  return {
    status: 'requeued',
    taskKind: task.taskKind,
    previousStatus: task.status,
  };
}
