/**
 * pd runtime internalization retry — needs_human_review 的 Owner 出边
 * (MVP_CORE_LOOP_CONTRACT INV-03: inspect / retry / revise / reject-archive)。
 *
 * 修复前 needs_human_review 是 display-only 单向终态 (审计 ISSUE-006)。
 * 本命令把 needs_human_review 任务重新入队 (→ pending, attemptCount 重置),
 * 由 auto-consumer / run-once 重新驱动。
 *
 * Owner retry = 显式人类 authority reset,与 crash retry 严格区分:
 * crash / lease recovery / automatic retry 保留 completionIntent(入口门
 * resume 原 verdict,零 LLM);Owner retry 必须同时清空 runnerDecision 与
 * completionIntent,允许新一轮 LLM verdict 成为 authority——否则入口门会
 * resume/finalize 旧 verdict,LLM 永不运行,Owner retry 实际失效。
 *
 * 落库形态: status/attemptCount 与清空后的 metadata 在同一次 updateTask
 * (SQLite 单条 UPDATE) 中原子生效——两个独立写之间失败会留下
 * "authority 已清但任务仍 needs_human_review" 的 partial Owner action。
 * metadata 不可 hydrate 时 fail closed (metadata_invalid),不得只改 status。
 *
 * CLI gate: 默认 dry-run;--confirm 才落地 (cli-4);JSON 模式严格单对象 (cli-1);
 * 失败路径不产生任何状态变更 (cli-5)。
 */

import * as path from 'path';
import { RuntimeStateManager, ownerRetryNeedsHumanReviewTask } from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

export interface InternalizationRetryOptions {
  workspace?: string;
  taskId?: string;
  confirm?: boolean;
  json?: boolean;
}

export interface InternalizationRetryOutput {
  status: 'requeued' | 'dry_run' | 'skipped' | 'failed';
  taskId: string;
  taskKind?: string;
  previousStatus?: string;
  reason?: string;
  nextAction?: string;
}

function emit(out: InternalizationRetryOutput, json?: boolean): void {
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`Retry: ${out.status}${out.previousStatus ? ` (was ${out.previousStatus})` : ''}`);
  if (out.reason) console.log(`  reason: ${out.reason}`);
  if (out.nextAction) console.log(`  nextAction: ${out.nextAction}`);
}

export async function handleRuntimeInternalizationRetry(opts: InternalizationRetryOptions): Promise<void> {
  if (!opts.taskId) {
    const out: InternalizationRetryOutput = {
      status: 'failed',
      taskId: '',
      reason: 'task_id_required',
      nextAction: 'Pass --task <taskId> (find ids via: pd runtime internalization queue --json or pd errors list)',
    };
    emit(out, opts.json);
    process.exitCode = 1;
    return;
  }

  const workspaceDir = opts.workspace ? path.resolve(opts.workspace) : resolveWorkspaceDir();
  const stateManager = new RuntimeStateManager({ workspaceDir });
  try {
    await stateManager.initialize();
    const task = await stateManager.getTask(opts.taskId);
    if (!task) {
      const out: InternalizationRetryOutput = {
        status: 'failed',
        taskId: opts.taskId,
        reason: 'task_not_found',
        nextAction: 'Verify the task id and workspace',
      };
      emit(out, opts.json);
      process.exitCode = 1;
      return;
    }

    if (task.status !== 'needs_human_review') {
      const out: InternalizationRetryOutput = {
        status: 'skipped',
        taskId: opts.taskId,
        taskKind: task.taskKind,
        previousStatus: task.status,
        reason: 'only_needs_human_review_tasks_are_retryable',
        nextAction: 'This task is not in the owner attention queue; use run-once / enqueue-successors instead',
      };
      emit(out, opts.json);
      return;
    }

    if (!opts.confirm) {
      const out: InternalizationRetryOutput = {
        status: 'dry_run',
        taskId: opts.taskId,
        taskKind: task.taskKind,
        previousStatus: task.status,
        reason: 'dry_run_no_mutation',
        nextAction: 'Re-run with --confirm to requeue this task',
      };
      emit(out, opts.json);
      return;
    }

    // Owner retry = authority reset: runnerDecision 与 completionIntent 同时
    // 清空 (保留 revisionCount / revisionCauseId / rolloutRevisionPayload /
    // repairPayload / lineage — revision budget 证据不动)。
    // 落库序列提取在 core ownerRetryNeedsHumanReviewTask (Governance Recovery
    // Actions v1): Console 恢复端点与 CLI 走同一段逻辑,禁止复制。
    const outcome = await ownerRetryNeedsHumanReviewTask(stateManager, opts.taskId);

    if (outcome.status === 'not_found') {
      const out: InternalizationRetryOutput = {
        status: 'failed',
        taskId: opts.taskId,
        reason: 'task_not_found',
        nextAction: 'Verify the task id and workspace',
      };
      emit(out, opts.json);
      process.exitCode = 1;
      return;
    }
    if (outcome.status === 'skipped') {
      const out: InternalizationRetryOutput = {
        status: 'skipped',
        taskId: opts.taskId,
        taskKind: outcome.taskKind,
        previousStatus: outcome.previousStatus,
        reason: 'only_needs_human_review_tasks_are_retryable',
        nextAction: 'This task is not in the owner attention queue; use run-once / enqueue-successors instead',
      };
      emit(out, opts.json);
      return;
    }
    if (outcome.status === 'rejected') {
      // PRI-629 Recover guard: decision-capable 人工裁决不走 authority reset —
      // 治理出口在 Console 治理焦点 (或 owner-decisions API)。
      const out: InternalizationRetryOutput = {
        status: 'skipped',
        taskId: opts.taskId,
        taskKind: outcome.taskKind,
        previousStatus: outcome.previousStatus,
        reason: outcome.reason,
        nextAction: 'This task awaits an Owner decision (accept / revise once / reject). Resolve it in the Console governance focus, or via the owner-decisions API. Recover is not a governance exit.',
      };
      emit(out, opts.json);
      return;
    }
    if (outcome.status === 'metadata_invalid') {
      // fail closed: 只改 status 会把(可能损坏的)旧 authority 记录原样留在
      // metadata 里,下一次 run 由它接管 —— 产生 partial retry。
      const out: InternalizationRetryOutput = {
        status: 'failed',
        taskId: opts.taskId,
        taskKind: outcome.taskKind,
        previousStatus: 'needs_human_review',
        reason: 'metadata_invalid',
        nextAction: 'Task metadata failed PI hydration; a retry now would risk a partial authority reset. Inspect: pd runtime internalization integrity --json',
      };
      emit(out, opts.json);
      process.exitCode = 1;
      return;
    }

    const out: InternalizationRetryOutput = {
      status: 'requeued',
      taskId: opts.taskId,
      taskKind: outcome.taskKind,
      previousStatus: outcome.previousStatus,
      nextAction: 'Task requeued; it will be picked up by the auto-consumer cycle, or advance manually: pd runtime internalization run-once',
    };
    emit(out, opts.json);
  } catch (err) {
    const out: InternalizationRetryOutput = {
      status: 'failed',
      taskId: opts.taskId,
      reason: err instanceof Error ? err.message : String(err),
      nextAction: 'Check workspace DB integrity (pd runtime internalization integrity)',
    };
    emit(out, opts.json);
    process.exitCode = 1;
  } finally {
    await stateManager.close();
  }
}

