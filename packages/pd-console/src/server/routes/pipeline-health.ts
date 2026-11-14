// pipeline-health.ts
// GET /api/pipeline-health?window=<hours>
//
// SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §3.4: read-only pipeline
// metrics for the Console. This route does NOT compute anything itself — the
// aggregation lives in `@principles/core/runtime` (`buildPipelineHealthMetrics`)
// and the run samples come from `SqliteRunStore`, the package that owns the
// `runs` schema. Console is a presentation layer over one implementation.
//
// Honesty contract: the response carries the core projection verbatim, so any
// metric whose data is not persisted arrives as `{available:false, reason}`.
// The route never substitutes 0, and never merges estimated values with
// provider-reported usage.
//
// Trust boundary (rc-1): the query string is read with URLSearchParams and the
// window is validated with Number.isFinite before use. State DB rows are
// validated by the store readers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import {
  SqliteConnection,
  SqliteRunStore,
  SqliteTaskStore,
} from '@principles/core/runtime';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';
import { buildPipelineHealthMetrics } from '../models/pipeline-health-metrics.js';
import { sendSuccess, sendError, sendBadRequest, sendMethodNotAllowed, errorMessage } from '../utils/response.js';

const DEFAULT_WINDOW_HOURS = 24;
const MAX_WINDOW_HOURS = 24 * 7;
const RECENT_TASK_LIMIT = 1000;

interface StoreEntry {
  readonly taskStore: SqliteTaskStore;
  readonly runStore: SqliteRunStore;
  readonly connection: SqliteConnection;
}

const entries = new Map<string, StoreEntry>();

function getStores(workspaceDir: string): StoreEntry {
  let entry = entries.get(workspaceDir);
  if (!entry) {
    const connection = new SqliteConnection({ workspaceDir, readonly: true });
    entry = {
      taskStore: new SqliteTaskStore(connection),
      runStore: new SqliteRunStore(connection),
      connection,
    };
    entries.set(workspaceDir, entry);
  }
  return entry;
}

export function disposePipelineHealthModels(): void {
  for (const entry of entries.values()) {
    try {
      entry.connection.close();
    } catch {
      // best-effort close on shutdown
    }
  }
  entries.clear();
}

export interface PipelineHealthContext {
  readonly workspaceDir: string;
  readonly featureFlags?: Readonly<Record<string, { enabled: boolean }>>;
}

export async function handlePipelineHealthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: PipelineHealthContext,
): Promise<void> {
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }

  // Same flag as the page that renders this data (failed-tasks observability).
  // A disabled flag short-circuits before any DB work.
  const flag = ctx.featureFlags && Object.hasOwn(ctx.featureFlags, 'failed_tasks_observability')
    ? ctx.featureFlags.failed_tasks_observability
    : undefined;
  if (flag && !flag.enabled) {
    sendError(
      res,
      403,
      'failed_tasks_observability_disabled',
      'failed_tasks_observability feature flag is disabled. Enable it in .pd/config.yaml (features.failed_tasks_observability.enabled: true) to read pipeline metrics.',
    );
    return;
  }

  const urlStr = req.url ?? '';
  const qIdx = urlStr.indexOf('?');
  const params = qIdx >= 0 ? new URLSearchParams(urlStr.slice(qIdx + 1)) : null;
  const rawWindow = params?.get('window');
  let windowHours = DEFAULT_WINDOW_HOURS;
  if (rawWindow !== null && rawWindow !== undefined) {
    const parsed = Number.parseInt(rawWindow, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      sendBadRequest(res, 'window must be a positive integer (hours)');
      return;
    }
    windowHours = Math.min(parsed, MAX_WINDOW_HOURS);
  }

  if (!fs.existsSync(resolveStateDbPath(ctx.workspaceDir))) {
    // A fresh workspace has no evidence yet. Report the SAME honest shape the
    // metric module would produce for zero samples — never a fake healthy state.
    sendSuccess(res, {
      windowHours,
      metrics: buildPipelineHealthMetrics({ nowMs: Date.now(), windowMs: windowHours * 3_600_000, tasks: [], stageRuns: [] }),
      nextAction: 'state.db 尚未初始化——管道指标为 UNKNOWN，运行时创建任务后回到本页复查。',
    });
    return;
  }

  try {
    const { taskStore, runStore } = getStores(ctx.workspaceDir);
    const nowMs = Date.now();
    const windowMs = windowHours * 3_600_000;
    const sinceIso = new Date(nowMs - windowMs).toISOString();

    const [pending, retryWait, leased, recentTasks, stageRuns] = await Promise.all([
      taskStore.listTasks({ status: 'pending' }),
      taskStore.listTasks({ status: 'retry_wait' }),
      taskStore.listTasks({ status: 'leased' }),
      taskStore.listTasks({ limit: RECENT_TASK_LIMIT, orderBy: 'updated_at_desc' }),
      runStore.listStageRunSamples({ sinceIso }),
    ]);

    // Deduplicate: the status lists are authoritative for queue depth, the
    // bounded recent list supplies createdAt/attemptCount for lineage. Rows are
    // identical records of the same table, so a first-wins merge is lossless.
    const merged = new Map<string, (typeof recentTasks)[number]>();
    for (const task of [...pending, ...retryWait, ...leased, ...recentTasks]) {
      if (!merged.has(task.taskId)) merged.set(task.taskId, task);
    }

    const metrics = buildPipelineHealthMetrics({
      nowMs,
      windowMs,
      tasks: [...merged.values()],
      stageRuns,
    });

    sendSuccess(res, {
      windowHours,
      metrics,
      dataSource: 'state.db (tasks + runs) — derived read model, no estimates',
    });
  } catch (err) {
    // rc-9: unreadable metrics are an explicit failure, not an empty success.
    sendError(res, 500, 'pipeline_health_read_error', errorMessage(err));
  }
}
