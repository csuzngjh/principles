/**
 * State API — exposes stalled/dirty workspace tasks for operator inspection.
 *
 * GET /api/v1/state
 *   Returns all tasks in needs_human_review status with workspace and error info.
 *
 * GET /api/v1/state/:taskId
 *   Returns detailed state for a specific task including dirty files.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';
import type { RuntimeStateManager } from '@principles/core/runtime-v2';

interface DirtyWorkspaceInfo {
  taskId: string;
  taskKind: string;
  workspaceDir: string | null;
  dirtyFiles: string[];
  lastError: string | null;
  attemptCount: number;
  updatedAt: string;
  diagnosticJson: Record<string, unknown> | null;
}

function extractDirtyFiles(diagnosticJson: string | null | undefined): string[] {
  if (!diagnosticJson) return [];
  try {
    const parsed = JSON.parse(diagnosticJson);
    return parsed.dirtyFiles ?? [];
  } catch {
    return [];
  }
}

function extractWorkspaceDir(diagnosticJson: string | null | undefined): string | null {
  if (!diagnosticJson) return null;
  try {
    const parsed = JSON.parse(diagnosticJson);
    return parsed.workspaceDir ?? null;
  } catch {
    return null;
  }
}

async function getHumanReviewTasks(stateManager: RuntimeStateManager): Promise<DirtyWorkspaceInfo[]> {
  const tasks = await stateManager.listTasks({ status: 'needs_human_review' });
  return tasks.map((task) => ({
    taskId: task.taskId,
    taskKind: task.taskKind,
    workspaceDir: extractWorkspaceDir(task.diagnosticJson),
    dirtyFiles: extractDirtyFiles(task.diagnosticJson),
    lastError: task.lastError ?? null,
    attemptCount: task.attemptCount,
    updatedAt: task.updatedAt,
    diagnosticJson: task.diagnosticJson ? JSON.parse(task.diagnosticJson) : null,
  }));
}

async function getTaskState(stateManager: RuntimeStateManager, taskId: string): Promise<DirtyWorkspaceInfo | null> {
  const task = await stateManager.getTask(taskId);
  if (!task) return null;
  return {
    taskId: task.taskId,
    taskKind: task.taskKind,
    workspaceDir: extractWorkspaceDir(task.diagnosticJson),
    dirtyFiles: extractDirtyFiles(task.diagnosticJson),
    lastError: task.lastError ?? null,
    attemptCount: task.attemptCount,
    updatedAt: task.updatedAt,
    diagnosticJson: task.diagnosticJson ? JSON.parse(task.diagnosticJson) : null,
  };
}

/* eslint-disable @typescript-eslint/max-params */
export async function handleStateRoute(
  req: IncomingMessage,
  res: ServerResponse,
  workspaceDir: string,
  subPath: string,
): Promise<void> {
  // Lazy import to avoid circular dependency issues
  const { RuntimeStateManager } = await import('@principles/core/runtime-v2');

  if (req.method !== 'GET') {
    sendError(res, 405, 'method_not_allowed', 'Only GET is allowed for this route');
    return;
  }

  const stateManager = new RuntimeStateManager({ workspaceDir });
  await stateManager.initialize();

  try {
    // GET /api/v1/state
    if (subPath === '' || subPath === '/' || subPath === '/tasks') {
      const tasks = await getHumanReviewTasks(stateManager);
      sendSuccess(res, {
        status: 'ok',
        tasks,
        count: tasks.length,
      });
      return;
    }

    // GET /api/v1/state/:taskId
    const parts = subPath.split('/').filter(Boolean);
    if (parts.length === 1 && parts[0]) {
      const taskId = parts[0];
      const taskState = await getTaskState(stateManager, taskId);
      if (!taskState) {
        sendNotFound(res, `Task ${taskId} not found`);
        return;
      }
      sendSuccess(res, {
        status: 'ok',
        task: taskState,
      });
      return;
    }

    sendNotFound(res, `Route /api/v1/state${subPath} not found`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendError(res, 500, 'state_error', message);
  } finally {
    await stateManager.close();
  }
}