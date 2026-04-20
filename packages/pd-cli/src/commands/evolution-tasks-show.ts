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

  // eslint-disable-next-line @typescript-eslint/init-declarations
  let foundTask;
  try {
    const numericId = isNaN(Number(opts.id)) ? undefined : Number(opts.id);
    foundTask = getEvolutionTask(workspaceDir, numericId ?? opts.id);
  } catch {
    console.log('No evolution tasks found.');
    return;
  }

  if (!foundTask) {
    console.error(`Task not found: ${opts.id}`);
    process.exit(1);
  }

  const fields = [
    ['id', String(foundTask.id)],
    ['taskId', foundTask.taskId],
    ['traceId', foundTask.traceId],
    ['source', foundTask.source],
    ['reason', foundTask.reason ?? 'null'],
    ['score', String(foundTask.score)],
    ['status', foundTask.status],
    ['enqueuedAt', foundTask.enqueuedAt ?? 'null'],
    ['startedAt', foundTask.startedAt ?? 'null'],
    ['completedAt', foundTask.completedAt ?? 'null'],
    ['resolution', foundTask.resolution ?? 'null'],
    ['taskKind', foundTask.taskKind ?? 'null'],
    ['priority', foundTask.priority ?? 'null'],
    ['retryCount', foundTask.retryCount != null ? String(foundTask.retryCount) : 'null'],
    ['maxRetries', foundTask.maxRetries != null ? String(foundTask.maxRetries) : 'null'],
    ['lastError', foundTask.lastError ?? 'null'],
    ['resultRef', foundTask.resultRef ?? 'null'],
    ['createdAt', foundTask.createdAt],
    ['updatedAt', foundTask.updatedAt],
  ];

  for (const [key, value] of fields) {
    console.log(`${key}: ${value}`);
  }
}
