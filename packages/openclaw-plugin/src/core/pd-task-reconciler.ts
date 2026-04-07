import * as fs from 'fs';
import * as path from 'path';
import type { PDTaskSpec, PDTaskExecutionRecord } from './pd-task-types.js';
import { BUILTIN_PD_TASKS } from './pd-task-types.js';
import { readTasks, writeTasks } from './pd-task-store.js';
import { withLockAsync } from '../utils/file-lock.js';

const CRON_STORE_PATH = path.join(
  process.env.HOME || '~',
  '.openclaw',
  'cron',
  'jobs.json',
);

export interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastRunStatus?: string;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastError?: string;
  lastDurationMs?: number;
  consecutiveErrors?: number;
}

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: { kind: 'every'; everyMs: number } | { kind: 'at'; at: string } | { kind: 'cron'; expr: string; tz?: string };
  sessionTarget: string;
  wakeMode: string;
  payload: { kind: 'systemEvent'; text: string } | { kind: 'agentTurn'; message: string; model?: string; thinking?: string; timeoutSeconds?: number; lightContext?: boolean; toolsAllow?: string[] };
  delivery?: { mode: string; channel?: string; to?: string };
  state: CronJobState;
  metadata?: Record<string, string>;
}

export interface CronStoreFile {
  version: number;
  jobs: CronJob[];
}

export type DiffActionType = 'CREATE' | 'UPDATE' | 'DISABLE' | 'ORPHAN' | 'SKIP';

export interface DiffAction {
  type: DiffActionType;
  task?: PDTaskSpec;
  job?: CronJob;
}

export interface ReconcileError {
  taskId: string;
  message: string;
}

export interface ReconcileResult {
  created: string[];
  updated: string[];
  skipped: string[];
  orphaned: string[];
  errors: ReconcileError[];
}

export interface ReconcileOptions {
  dryRun?: boolean;
  workspaceDir: string;
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void };
}

async function readCronStore(): Promise<CronStoreFile> {
  if (!fs.existsSync(CRON_STORE_PATH)) {
    return { version: 1, jobs: [] };
  }
  try {
    const raw = fs.readFileSync(CRON_STORE_PATH, 'utf-8');
    return JSON.parse(raw) as CronStoreFile;
  } catch (err) {
    console.warn(`[PD:Reconciler] Failed to parse cron/jobs.json: ${String(err)}`);
    return { version: 1, jobs: [] };
  }
}

async function writeCronStore(store: CronStoreFile): Promise<void> {
  await withLockAsync(CRON_STORE_PATH, async () => {
    const tmpPath = CRON_STORE_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), 'utf-8');
    fs.renameSync(tmpPath, CRON_STORE_PATH);
  });
}

function diff(declared: PDTaskSpec[], actual: CronJob[]): DiffAction[] {
  const actions: DiffAction[] = [];
  const actualByName = new Map<string, CronJob>();
  for (const job of actual) {
    actualByName.set(job.name, job);
  }

  for (const task of declared) {
    const job = actualByName.get(task.name);

    if (!job) {
      if (task.enabled) {
        actions.push({ type: 'CREATE', task });
      }
    } else {
      const pdVersion = job.metadata?.pdVersion;
      if (!task.enabled) {
        actions.push({ type: 'DISABLE', task, job });
      } else if (!pdVersion || pdVersion !== task.version) {
        actions.push({ type: 'UPDATE', task, job });
      } else {
        actions.push({ type: 'SKIP', task, job });
      }
    }
  }

  for (const job of actual) {
    if (!job.name.startsWith('PD ')) continue;
    const found = declared.find((t) => t.name === job.name);
    if (!found) {
      actions.push({ type: 'ORPHAN', job });
    }
  }

  return actions;
}

function buildCronJob(task: PDTaskSpec, nowMs: number): CronJob {
  return {
    id: `pd-${task.id}-${nowMs}`,
    name: task.name,
    description: task.description,
    enabled: task.enabled,
    schedule: { kind: 'every', everyMs: task.schedule.everyMs },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: buildTaskPrompt(task),
      lightContext: task.execution.lightContext ?? true,
      timeoutSeconds: task.execution.timeoutSeconds ?? 120,
      toolsAllow: task.execution.toolsAllow,
    },
    delivery: { mode: task.delivery.mode },
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    state: {
      nextRunAtMs: nowMs + task.schedule.everyMs,
    },
    metadata: {
      pdVersion: task.version,
      pdTaskId: task.id,
    },
  };
}

function buildTaskPrompt(task: PDTaskSpec): string {
  if (task.id === 'empathy-optimizer') {
    return `You are the Principles Disciple Empathy Keyword Optimizer.

## TASK
Analyze the current empathy keyword store and recent user messages.
Return STRICT JSON only (no markdown, no explanation):

{"updates": {"TERM": {"action": "add|update|remove", "weight": 0.1-0.9, "falsePositiveRate": 0.05-0.5, "reasoning": "brief reason"}}}

## DATA ACCESS
- Read keyword store: read_file tool on ~/.openclaw/workspace-main/.state/empathy_keywords.json
- Read recent user turns: read_file tool on trajectory DB (~/.openclaw/workspace-main/.state/trajectory.db is SQLite)
- Use search_file_content to find frustration patterns in recent messages

## RULES
- ADD: If user messages contain frustration signals NOT in current terms
- UPDATE: If a term has high hits → increase weight; low hits + high fp_rate → decrease
- REMOVE: If a term has 0 hits AND high false positive rate (>0.3)
- Weight: 0.1 (weak signal) to 0.9 (strong signal)
- falsePositiveRate: 0.05 (rare false alarm) to 0.5 (often wrong)
- Keep reasoning concise (max 80 chars)

## EXAMPLES
- User says "搞什么呀" → ADD "搞什么呀" weight=0.7
- "不对" has 50 hits → UPDATE weight=0.9
- "呵呵" has 0 hits and fp_rate=0.4 → REMOVE`;
  }
  return task.description;
}

export async function reconcilePDTasks(
  workspaceDir: string,
  options?: Partial<ReconcileOptions>,
): Promise<ReconcileResult> {
  const dryRun = options?.dryRun ?? false;
  const logger = options?.logger ?? console;
  const nowMs = Date.now();

  const result: ReconcileResult = { created: [], updated: [], skipped: [], orphaned: [], errors: [] };

  const storedTasks = readTasks(workspaceDir);
  const storedById = new Map(storedTasks.map((t) => [t.id, t]));
  const declared: PDTaskSpec[] = BUILTIN_PD_TASKS.map((t) => {
    const stored = storedById.get(t.id);
    if (stored) {
      return { ...t, meta: { ...t.meta, ...stored.meta } };
    }
    return { ...t, meta: { createdAtMs: nowMs } };
  });

  const cronStore = await readCronStore();
  const healthUpdated = healthCheck(declared, cronStore, logger);
  const actions = diff(healthUpdated, cronStore.jobs);

  for (const action of actions) {
    switch (action.type) {
      case 'CREATE':
        if (action.task) {
          if (!dryRun) {
            const job = buildCronJob(action.task, nowMs);
            cronStore.jobs.push(job);
            logger.info?.(`[PD:Reconciler] Created job: ${action.task.name}`);
          }
          result.created.push(action.task.name);
        }
        break;
      case 'UPDATE':
        if (action.task && action.job) {
          if (!dryRun) {
            const idx = cronStore.jobs.indexOf(action.job);
            const newJob = buildCronJob(action.task, nowMs);
            newJob.id = action.job.id;
            cronStore.jobs[idx] = newJob;
            logger.info?.(`[PD:Reconciler] Updated job: ${action.task.name}`);
          }
          result.updated.push(action.task.name);
        }
        break;
      case 'DISABLE':
        if (action.job) {
          if (!dryRun) {
            action.job.enabled = false;
            action.job.updatedAtMs = nowMs;
          }
          logger.warn?.(`[PD:Reconciler] Disabled job: ${action.job.name}`);
        }
        break;
      case 'ORPHAN':
        if (action.job) {
          logger.warn?.(`[PD:Reconciler] Orphaned job (no declaration): ${action.job.name}`);
          result.orphaned.push(action.job.name);
        }
        break;
      case 'SKIP':
        if (action.task) {
          result.skipped.push(action.task.name);
        }
        break;
    }
  }

  if (!dryRun && (result.created.length > 0 || result.updated.length > 0)) {
    await writeCronStore(cronStore);
  }

  if (!dryRun && declared.length > 0) {
    await writeTasks(workspaceDir, declared);
  }

  return result;
}

function healthCheck(tasks: PDTaskSpec[], cronStore: CronStoreFile, logger: { warn?: (msg: string) => void }): PDTaskSpec[] {
  const jobByName = new Map(cronStore.jobs.map((j) => [j.name, j]));
  for (const task of tasks) {
    const job = jobByName.get(task.name);
    if (!job) continue;
    const errors = job.state.consecutiveErrors ?? 0;
    if (errors >= 3 && !task.meta?.autoDisabled) {
      if (!task.meta) task.meta = {};
      task.meta.autoDisabled = true;
      task.meta.autoDisabledAt = Date.now();
      task.meta.autoDisabledReason = `consecutiveErrors=${errors}`;
      logger.warn?.(`[PD:Reconciler] Auto-disabled task '${task.id}' due to ${errors} consecutive errors`);
    }
    if (task.meta) {
      task.meta.consecutiveFailCount = errors;
      if (job.state.lastRunAtMs) {
        task.meta.lastFailedAtMs = job.state.lastRunAtMs;
      }
    }
  }
  return tasks;
}

export async function trigger(
  taskId: string,
  workspaceDir: string,
  options?: { force?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const tasks = readTasks(workspaceDir);
  const task = tasks.find((t) => t.id === taskId);
  if (!task) {
    return { ok: false, error: `Task '${taskId}' not found` };
  }
  if (task.meta?.autoDisabled && !options?.force) {
    return { ok: false, error: 'Task is auto-disabled. Use force=true to override.' };
  }

  const cronStore = await readCronStore();
  const nowMs = Date.now();
  const existingJob = cronStore.jobs.find((j) => j.name === task.name);

  if (existingJob) {
    existingJob.enabled = true;
    existingJob.updatedAtMs = nowMs;
    existingJob.state.nextRunAtMs = nowMs;
  } else {
    const newJob = buildCronJob(task, nowMs);
    newJob.enabled = true;
    newJob.deleteAfterRun = true;
    cronStore.jobs.push(newJob);
  }

  if (!task.meta) task.meta = {};
  task.meta.lastTriggeredAtMs = nowMs;
  task.meta.lastTriggerStatus = 'pending';

  await writeCronStore(cronStore);
  await writeTasks(workspaceDir, tasks);
  return { ok: true };
}

export function getExecutionHistory(
  taskId: string,
  workspaceDir: string,
  options?: { limit?: number; status?: string },
): PDTaskExecutionRecord[] {
  const tasks = readTasks(workspaceDir);
  const task = tasks.find((t) => t.id === taskId);
  if (!task?.meta?.executionHistory) return [];

  let records = [...task.meta.executionHistory];
  if (options?.status) {
    records = records.filter((r) => r.status === options.status);
  }
  records.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  if (options?.limit) {
    records = records.slice(0, options.limit);
  }
  return records;
}

export function recordExecution(
  task: PDTaskSpec,
  runId: string,
  status: PDTaskExecutionRecord['status'],
  error?: string,
): PDTaskSpec {
  if (!task.meta) task.meta = {};
  if (!task.meta.executionHistory) task.meta.executionHistory = [];
  task.meta.executionHistory.push({
    runId,
    status,
    startedAt: Date.now(),
    endedAt: Date.now(),
    error,
  });
  if (task.meta.executionHistory.length > 100) {
    task.meta.executionHistory = task.meta.executionHistory.slice(-100);
  }
  return task;
}
