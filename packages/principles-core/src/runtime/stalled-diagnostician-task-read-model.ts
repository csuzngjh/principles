/**
 * StalledDiagnosticianTaskReadModel — read model to detect stalled diagnostician tasks.
 *
 * A stalled task has taskKind = 'diagnostician', status = 'pending', attemptCount = 0,
 * no runs, and age > thresholdSeconds.
 *
 * PRI-377 — Surface stalled diagnostician tasks with explicit next actions.
 */
import type { RuntimeStateManager } from './store/runtime-state-manager.js';

export interface StalledDiagnosticianTaskInfo {
  readonly taskId: string;
  readonly inputRef: string | null;
  readonly age: number; // in seconds
  readonly reason: string;
  readonly nextAction: string;
}

export interface StalledDiagnosticianTaskReadModelOptions {
  stateManager: RuntimeStateManager;
}

export class StalledDiagnosticianTaskReadModel {
  private readonly stateManager: RuntimeStateManager;

  constructor(opts: StalledDiagnosticianTaskReadModelOptions) {
    this.stateManager = opts.stateManager;
  }

  async checkStalledTask(taskId: string, thresholdSeconds = 300): Promise<StalledDiagnosticianTaskInfo | null> {
    const task = await this.stateManager.getTask(taskId);
    if (!task) {
      return null;
    }

    if (
      task.taskKind === 'diagnostician' &&
      task.status === 'pending' &&
      task.attemptCount === 0
    ) {
      const runs = await this.stateManager.getRunsByTask(taskId);
      if (runs.length === 0) {
        const createdAtTime = new Date(task.createdAt).getTime();
        const ageSeconds = Math.floor((Date.now() - createdAtTime) / 1000);
        if (ageSeconds > thresholdSeconds) {
          const { workspaceDir } = this.stateManager;
          const nextAction = `pd diagnose run --task-id ${taskId} --workspace "${workspaceDir}" --runtime pi-ai --json`;
          return {
            taskId,
            inputRef: task.inputRef ?? null,
            age: ageSeconds,
            reason: `Task is pending with 0 attempts and no execution runs after ${thresholdSeconds}s (submitted-without-run).`,
            nextAction,
          };
        }
      }
    }

    return null;
  }

  async listStalledTasks(thresholdSeconds = 300): Promise<StalledDiagnosticianTaskInfo[]> {
    const tasks = await this.stateManager.listTasks({ taskKind: 'diagnostician', status: 'pending' });
    const stalled: StalledDiagnosticianTaskInfo[] = [];
    for (const task of tasks) {
      if (task.attemptCount === 0) {
        const runs = await this.stateManager.getRunsByTask(task.taskId);
        if (runs.length === 0) {
          const createdAtTime = new Date(task.createdAt).getTime();
          const ageSeconds = Math.floor((Date.now() - createdAtTime) / 1000);
          if (ageSeconds > thresholdSeconds) {
            const { workspaceDir } = this.stateManager;
            const nextAction = `pd diagnose run --task-id ${task.taskId} --workspace "${workspaceDir}" --runtime pi-ai --json`;
            stalled.push({
              taskId: task.taskId,
              inputRef: task.inputRef ?? null,
              age: ageSeconds,
              reason: `Task is pending with 0 attempts and no execution runs after ${thresholdSeconds}s (submitted-without-run).`,
              nextAction,
            });
          }
        }
      }
    }
    return stalled;
  }
}
