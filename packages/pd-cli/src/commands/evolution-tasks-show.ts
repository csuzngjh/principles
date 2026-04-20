/**
 * pd evolution tasks show command implementation.
 *
 * Usage: pd evolution tasks show <id>
 *
 * Displays full details for a single evolution task.
 * Accepts both numeric id and string taskId.
 */

import { getEvolutionTask } from '@principles/core/evolution-store';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface EvolutionTasksShowOptions {
  id: string;
}

export async function handleEvolutionTasksShow(opts: EvolutionTasksShowOptions): Promise<void> {
  const workspaceDir = resolveWorkspaceDir();

  let task;
  try {
    task = getEvolutionTask(workspaceDir, opts.id);
  } catch {
    // Graceful fallback: DB may not exist yet
    console.log('No evolution tasks found.');
    return;
  }

  if (!task) {
    console.error(`Task not found: ${opts.id}`);
    process.exit(1);
  }

  const fields = [
    ['id', String(task.id)],
    ['taskId', task.taskId],
    ['traceId', task.traceId],
    ['source', task.source],
    ['reason', task.reason ?? 'null'],
    ['score', String(task.score)],
    ['status', task.status],
    ['enqueuedAt', task.enqueuedAt ?? 'null'],
    ['startedAt', task.startedAt ?? 'null'],
    ['completedAt', task.completedAt ?? 'null'],
    ['resolution', task.resolution ?? 'null'],
    ['taskKind', task.taskKind ?? 'null'],
    ['priority', task.priority ?? 'null'],
    ['retryCount', task.retryCount != null ? String(task.retryCount) : 'null'],
    ['maxRetries', task.maxRetries != null ? String(task.maxRetries) : 'null'],
    ['lastError', task.lastError ?? 'null'],
    ['resultRef', task.resultRef ?? 'null'],
    ['createdAt', task.createdAt],
    ['updatedAt', task.updatedAt],
  ];

  for (const [key, value] of fields) {
    console.log(`${key}: ${value}`);
  }
}
