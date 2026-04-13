import * as fs from 'fs';
import * as path from 'path';
import type { PDTaskSpec } from './pd-task-types.js';
import { withLockAsync } from '../utils/file-lock.js';

const PD_TASKS_FILENAME = 'pd_tasks.json';

function resolvePdTasksPath(workspaceDir: string): string {
  return path.join(workspaceDir, '.state', PD_TASKS_FILENAME);
}

function ensureStateDir(workspaceDir: string): void {
  const stateDir = path.join(workspaceDir, '.state');
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }
}

export function readTasks(workspaceDir: string): PDTaskSpec[] {
  const filePath = resolvePdTasksPath(workspaceDir);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as PDTaskSpec[];
    }
    return [];
  } catch (err) {
    console.warn(`[PD:TaskStore] Failed to parse ${PD_TASKS_FILENAME}: ${String(err)}`);
    return [];
  }
}

export async function writeTasks(workspaceDir: string, tasks: PDTaskSpec[]): Promise<void> {
  const filePath = resolvePdTasksPath(workspaceDir);
  ensureStateDir(workspaceDir);

  await withLockAsync(filePath, async () => {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(tasks, null, 2), 'utf-8');
    fs.renameSync(tmpPath, filePath);
  });
}

export function initTaskMeta(task: PDTaskSpec): PDTaskSpec {
  if (!task.meta) {
    task.meta = {};
  }
  if (!task.meta.createdAtMs) {
    task.meta.createdAtMs = Date.now();
  }
  return task;
}

 
// eslint-disable-next-line @typescript-eslint/max-params
export function updateSyncMeta(
  task: PDTaskSpec,
  status: 'ok' | 'error',
  jobId?: string,
  error?: string,
): PDTaskSpec {
  if (!task.meta) {
    task.meta = {};
  }
  task.meta.lastSyncedAtMs = Date.now();
  task.meta.lastSyncStatus = status;
  if (jobId) {
    task.meta.lastSyncedJobId = jobId;
  }
  if (error) {
    task.meta.lastSyncError = error;
  }
  return task;
}
