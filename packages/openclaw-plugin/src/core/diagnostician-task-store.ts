/**
 * Diagnostician Task Store
 *
 * Manages diagnostician task prompts stored in `.state/diagnostician_tasks.json`.
 * This replaces the previous HEARTBEAT.md approach which had a race condition:
 * the main session heartbeat would overwrite HEARTBEAT.md while the diagnostician
 * was still running, causing the task prompt to be lost.
 *
 * This store uses file-level locking via withLockAsync to prevent concurrent writes.
 *
 * Design:
 * - Each task is written once by the evolution worker (when pain is detected)
 * - The prompt hook reads tasks during heartbeat triggers and injects them
 * - The diagnostician agent completes the task and writes marker files
 * - The worker detects marker files and extracts principles
 *
 * File format:
 * {
 *   "tasks": {
 *     "<task-id>": {
 *       "prompt": "...full diagnostician prompt...",
 *       "createdAt": "ISO timestamp",
 *       "status": "pending" | "completed"
 *     }
 *   }
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import { withLockAsync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';

const DIAGNOSTICIAN_TASKS_FILE = 'diagnostician_tasks.json';

export interface DiagnosticianTask {
  prompt: string;
  createdAt: string;
  status: 'pending' | 'completed';
  /** Number of times task was retried due to marker exists but JSON report missing (#366) */
  reportMissingRetries?: number;
}

export interface DiagnosticianTaskStore {
  tasks: Record<string, DiagnosticianTask>;
}

/**
 * Resolve the diagnostician tasks file path.
 */
function resolveTasksPath(stateDir: string): string {
  return path.join(stateDir, DIAGNOSTICIAN_TASKS_FILE);
}

/**
 * Read the diagnostician task store from disk.
 * Returns an empty store if the file doesn't exist or is malformed.
 */
function readTaskStore(stateDir: string): DiagnosticianTaskStore {
  const filePath = resolveTasksPath(stateDir);
  if (!fs.existsSync(filePath)) {
    return { tasks: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.tasks === 'object') {
      return parsed as DiagnosticianTaskStore;
    }
    return { tasks: {} };
  } catch {
    return { tasks: {} };
  }
}

/**
 * Add a new diagnostician task to the store.
 * Overwrites if a task with the same ID already exists.
 * Read-modify-write is performed atomically inside the file lock.
 */
export async function addDiagnosticianTask(
  stateDir: string,
  taskId: string,
  prompt: string,
): Promise<void> {
  const filePath = resolveTasksPath(stateDir);
  await withLockAsync(filePath, async () => {
     
     
    const store = readTaskStoreSync(filePath);
    const existing = store.tasks[taskId];
    store.tasks[taskId] = {
      prompt,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      status: 'pending',
      reportMissingRetries: existing?.reportMissingRetries ?? 0,
    };
    atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));
  });
}

/**
 * Mark a task as completed and remove it from the store.
 * Read-modify-write is performed atomically inside the file lock.
 */
export async function completeDiagnosticianTask(
  stateDir: string,
  taskId: string,
): Promise<void> {
  const filePath = resolveTasksPath(stateDir);
  await withLockAsync(filePath, async () => {

     
    const store = readTaskStoreSync(filePath);
    delete store.tasks[taskId];
    atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));
  });
}

/**
 * Synchronous read without lock — for use INSIDE a lock context.
 */
 
function readTaskStoreSync(filePath: string): DiagnosticianTaskStore {
  if (!fs.existsSync(filePath)) {
    return { tasks: {} };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.tasks === 'object') {
      return parsed as DiagnosticianTaskStore;
    }
    return { tasks: {} };
  } catch {
    return { tasks: {} };
  }
}

/**
 * Get all pending diagnostician tasks.
 * Returns an array of [taskId, task] pairs.
 */
export function getPendingDiagnosticianTasks(
  stateDir: string,
): { id: string; task: DiagnosticianTask }[] {
  const store = readTaskStore(stateDir);
  return Object.entries(store.tasks)
    .filter(([, task]) => task.status === 'pending')
    .map(([id, task]) => ({ id, task }));
}

/**
 * Check if there are any pending diagnostician tasks.
 */
export function hasPendingDiagnosticianTasks(stateDir: string): boolean {
  const store = readTaskStore(stateDir);
  return Object.values(store.tasks).some(t => t.status === 'pending');
}

/**
 * Re-queue a diagnostician task with an incremented reportMissingRetries counter.
 * Used when a task has a marker file but no JSON report — the worker re-injects
 * the task for the LLM to retry (up to MAX_REPORT_MISSING_RETRIES times).
 *
 * Idempotent: if the task doesn't exist, does nothing.
 */
export async function requeueDiagnosticianTask(
  stateDir: string,
  taskId: string,
  maxRetries = 3,
): Promise<{ requeued: boolean; maxRetriesReached: boolean }> {
  const filePath = resolveTasksPath(stateDir);
  return withLockAsync(filePath, async () => {
    const store = readTaskStoreSync(filePath);
    const existing = store.tasks[taskId];
    if (!existing) {
      return { requeued: false, maxRetriesReached: false };
    }
    const retries = (existing.reportMissingRetries ?? 0) + 1;
    if (retries > maxRetries) {
      return { requeued: false, maxRetriesReached: true };
    }
    store.tasks[taskId] = {
      ...existing,
      status: 'pending',
      reportMissingRetries: retries,
    };
    atomicWriteFileSync(filePath, JSON.stringify(store, null, 2));
    return { requeued: true, maxRetriesReached: false };
  });
}
