 
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { PDTaskSpec } from './pd-task-types.js';
import { BUILTIN_PD_TASKS } from './pd-task-types.js';
import { readTasks, writeTasks } from './pd-task-store.js';
import { withLockAsync } from '../utils/file-lock.js';
import { atomicWriteFileSync } from '../utils/io.js';

const CRON_STORE_PATH = path.join(
  os.homedir(),
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
  agentId?: string;
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
   
  logger?: { info?: (_: string) => void; warn?: (_: string) => void };
   
}

 
function readCronStore(logger?: { info?: (_: string) => void; warn?: (_: string) => void }): CronStoreFile {
  if (!fs.existsSync(CRON_STORE_PATH)) {
    logger?.info?.(`[PD:Reconciler] cron/jobs.json not found, starting with empty store`);
    return { version: 1, jobs: [] };
  }
  try {
    const raw = fs.readFileSync(CRON_STORE_PATH, 'utf-8');
    const store = JSON.parse(raw) as CronStoreFile;
    logger?.info?.(`[PD:Reconciler] Loaded cron/jobs.json: ${store.jobs.length} jobs`);
    return store;
  } catch (err) {
    logger?.warn?.(`[PD:Reconciler] Failed to parse cron/jobs.json: ${String(err)}`);
    return { version: 1, jobs: [] };
  }
}

async function writeCronStore(store: CronStoreFile): Promise<void> {
  await withLockAsync(CRON_STORE_PATH, async () => {
    atomicWriteFileSync(CRON_STORE_PATH, JSON.stringify(store, null, 2));
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

function buildCronJob(
  task: PDTaskSpec,
  nowMs: number,
  workspaceDir: string,
  logger?: { info?: (_: string) => void },
): CronJob {
  logger?.info?.(`[PD:Reconciler] Building cron job: ${task.name} (id=${task.id}, interval=${task.schedule.everyMs}ms)`);
  return {
    id: `pd-${task.id}-${nowMs}`,
    name: task.name,
    agentId: task.agentId || 'main',
    description: task.description,
    enabled: task.enabled,
    schedule: { kind: 'every', everyMs: task.schedule.everyMs },
    sessionTarget: 'isolated',
    wakeMode: 'now',
    payload: {
      kind: 'agentTurn',
      message: buildTaskPrompt(task, workspaceDir, logger),
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

 
function buildTaskPrompt(task: PDTaskSpec, _workspaceDir: string, _logger?: { info?: (_: string) => void }): string {
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

  const cronStore = await readCronStore(logger);
   
   
  const healthUpdated = healthCheck(declared, cronStore, logger);
  const actions = diff(healthUpdated, cronStore.jobs);

  for (const action of actions) {
    switch (action.type) {
      case 'CREATE':
        if (action.task) {
          if (!dryRun) {
            const job = buildCronJob(action.task, nowMs, workspaceDir, logger);
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
            const newJob = buildCronJob(action.task, nowMs, workspaceDir, logger);
            newJob.id = action.job.id;
            // Preserve original state — only CronService should recalculate nextRunAtMs
            newJob.state = {
              ...action.job.state,
              nextRunAtMs: undefined, // Let CronService recalculate
            };
            cronStore.jobs[idx] = newJob;
            logger.info?.(`[PD:Reconciler] Updated job: ${action.task.name}`);
          }
          result.updated.push(action.task.name);
        }
        break;
      case 'DISABLE':
        if (action.job) {
          if (!dryRun) {
            const idx = cronStore.jobs.indexOf(action.job);
            if (idx >= 0) {
              cronStore.jobs[idx] = { ...action.job, enabled: false, updatedAtMs: nowMs };
            }
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
    logger.info?.(`[PD:Reconciler] Wrote cron/jobs.json: ${cronStore.jobs.length} total jobs`);
    for (const job of cronStore.jobs) {
      if (job.name.startsWith('PD ')) {
        logger.info?.(`[PD:Reconciler] PD job: name=${job.name}, enabled=${job.enabled}, schedule=${JSON.stringify(job.schedule)}, nextRun=${job.state.nextRunAtMs ? new Date(job.state.nextRunAtMs).toISOString() : 'TBD'}`);
      }
    }
  }

  if (!dryRun && declared.length > 0) {
    await writeTasks(workspaceDir, declared);
  }

  return result;
}


function healthCheck(
  tasks: PDTaskSpec[],
  cronStore: CronStoreFile,
   
  logger: { info?: (_msg: string) => void; warn?: (_msg: string) => void },
   
): PDTaskSpec[] {
  const jobByName = new Map(cronStore.jobs.map((j) => [j.name, j]));

  return tasks.map((task) => {
    const job = jobByName.get(task.name);
    if (!job) return task;

    const errors = job.state.consecutiveErrors ?? 0;
    const lastError = job.state.lastError ?? '';
    const isTimeout = lastError.includes('timed out') || lastError.includes('timeout');

    // Auto-increase timeout on timeout error (exponential backoff: 2x, max 1800s)
    if (isTimeout && errors > 0 && job.payload.kind === 'agentTurn') {
      const currentTimeout = job.payload.timeoutSeconds ?? 120;
      const newTimeout = Math.min(1800, currentTimeout * 2);
      if (newTimeout > currentTimeout) {
        job.payload.timeoutSeconds = newTimeout;
        job.state.consecutiveErrors = 0;
        job.state.lastError = undefined;
        logger.info?.(`[PD:Reconciler] Auto-increased timeout for '${task.name}': ${currentTimeout}s → ${newTimeout}s (was ${errors} consecutive timeouts)`);
      }
    }

    // Auto-disable only for non-timeout errors after 3 consecutive failures
    const shouldAutoDisable = errors >= 3 && !isTimeout && !task.meta?.autoDisabled;

    // Reset consecutiveErrors on non-error runs
    if (errors === 0 && task.meta?.autoDisabled) {
      logger.info?.(`[PD:Reconciler] Task '${task.id}' was previously auto-disabled but has 0 consecutive errors now`);
    }

    if (shouldAutoDisable || task.meta || job.state.lastRunAtMs) {
      return {
        ...task,
        meta: {
          ...task.meta,
          ...(shouldAutoDisable ? {
            autoDisabled: true,
            autoDisabledAt: Date.now(),
            autoDisabledReason: `consecutiveErrors=${errors}`,
          } : {}),
          ...(task.meta ? { consecutiveFailCount: errors } : {}),
          ...(job.state.lastRunAtMs ? { lastFailedAtMs: job.state.lastRunAtMs } : {}),
        },
      };
    }

    return task;
  });
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

  const log = (msg: string) => console.info(`[PD:Trigger] ${msg}`);
  const cronStore = await readCronStore({ info: log, warn: log });
  const nowMs = Date.now();
  const existingJob = cronStore.jobs.find((j) => j.name === task.name);

  if (existingJob) {
    log(`Manually triggering existing job: ${task.name} (id=${existingJob.id})`);
    existingJob.enabled = true;
    existingJob.updatedAtMs = nowMs;
    existingJob.state.nextRunAtMs = nowMs;
    existingJob.deleteAfterRun = undefined;
  } else {
    log(`Creating new job for manual trigger: ${task.name}`);
    const newJob = buildCronJob(task, nowMs, workspaceDir, { info: log });
    newJob.enabled = true;
    newJob.state.nextRunAtMs = nowMs;
    cronStore.jobs.push(newJob);
  }

  if (!task.meta) task.meta = {};
  task.meta.lastTriggeredAtMs = nowMs;
  task.meta.lastTriggerStatus = 'pending';

  await writeCronStore(cronStore);
  await writeTasks(workspaceDir, tasks);
  log(`Trigger complete: nextRunAt=${nowMs}, will run on next cron cycle`);
  return { ok: true };
}
