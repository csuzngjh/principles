/**
 * pd evolution tasks list command implementation.
 *
 * Usage: pd evolution tasks list [--status pending|in_progress|completed|all]
 *                                 [--limit <number>] [--date-from <date>] [--date-to <date>]
 */

import { listEvolutionTasks } from '@principles/core/evolution-store';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface EvolutionTasksListOptions {
  status?: string;
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
}

export async function handleEvolutionTasksList(opts: EvolutionTasksListOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();

  try {
    const tasks = listEvolutionTasks(workspaceDir, {
      status: opts.status === 'all' ? undefined : opts.status,
      limit: opts.limit,
      dateFrom: opts.dateFrom,
      dateTo: opts.dateTo,
    });
    if (tasks.length === 0) {
      console.log('No evolution tasks found.');
      return;
    }
    for (const task of tasks) {
      const enqueuedAt = task.enqueuedAt ?? 'null';
      console.log(
        `[${task.status}] ${task.taskId} (${task.taskKind}) score=${task.score} source=${task.source} enqueued=${enqueuedAt}`
      );
    }
    console.log(`${tasks.length} task(s)`);
    return;
  } catch {
    console.log('No evolution tasks found.');
    return;
  }
}
