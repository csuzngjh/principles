/**
 * pd runtime internalization retry — needs_human_review 的 Owner 出边
 * (MVP_CORE_LOOP_CONTRACT INV-03: inspect / retry / revise / reject-archive)。
 *
 * 修复前 needs_human_review 是 display-only 单向终态 (审计 ISSUE-006)。
 * 本命令把 needs_human_review 任务重新入队 (→ pending, attemptCount 重置,
 * runnerDecision 清空),由 auto-consumer / run-once 重新驱动。
 *
 * CLI gate: 默认 dry-run;--confirm 才落地 (cli-4);JSON 模式严格单对象 (cli-1);
 * 失败路径不产生任何状态变更 (cli-5)。
 */

import * as path from 'path';
import { RuntimeStateManager } from '@principles/core/runtime-v2';
import { hydratePITaskRecord, createPITaskDiagnosticJson, mergePITaskMetadata } from '@principles/core/runtime-v2';
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

    // 清空 runnerDecision(新轮次 verdict 未定),保留 revision 轮次与 lineage
    const piTask = hydratePITaskRecord(task);
    if (piTask) {
      const merged = mergePITaskMetadata(piTask, { runnerDecision: undefined });
      await stateManager.updateTaskDiagnosticJson(opts.taskId, createPITaskDiagnosticJson(merged));
    }
    await stateManager.updateTask(opts.taskId, { status: 'pending', attemptCount: 0 });

    const out: InternalizationRetryOutput = {
      status: 'requeued',
      taskId: opts.taskId,
      taskKind: task.taskKind,
      previousStatus: task.status,
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

