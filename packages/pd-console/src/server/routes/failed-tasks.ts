// failed-tasks.ts
// Server route for /api/v1/failed-tasks/*
//
// Lists tasks in 'failed' or 'needs_human_review' status and fetches single-task
// detail (task record + run history + last error category). Gated by the
// failed_tasks_observability feature flag.
//
// Trust boundary (rc-1, rc-2): all query string values are read via
// URLSearchParams.get() and treated as `unknown` until validated with typeof /
// Number.isFinite. Store return values are typed by the core contract and
// further validated by SqliteTaskStore's row readers (rc-1 at the DB boundary).

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SqliteConnection,
  SqliteTaskStore,
} from '@principles/core/runtime-v2';
import {
  sendSuccess,
  sendError,
  sendNotFound,
  sendMethodNotAllowed,
  sendBadRequest,
} from '../utils/response.js';

// ── Per-workspace store cache ──────────────────────────────────────────────
//
// SqliteTaskStore holds a SqliteConnection; sharing one per workspace keeps
// the connection alive across requests instead of re-opening state.db on every
// call. Connections are readonly — this route never writes. disposeFailedTasksModels()
// closes every connection on server shutdown (mirrors the feedback-reports pattern).

interface StoreEntry {
  store: SqliteTaskStore;
  connection: SqliteConnection;
}

const entries = new Map<string, StoreEntry>();

function stateDbExists(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'));
}

function getStore(workspaceDir: string): SqliteTaskStore {
  let entry = entries.get(workspaceDir);
  if (!entry) {
    const connection = new SqliteConnection({ workspaceDir, readonly: true });
    const store = new SqliteTaskStore(connection);
    entry = { store, connection };
    entries.set(workspaceDir, entry);
  }
  return entry.store;
}

export function disposeFailedTasksModels(): void {
  for (const entry of entries.values()) {
    try {
      entry.connection.close();
    } catch {
      // best-effort close on shutdown
    }
  }
  entries.clear();
}

// ── Helpers ────────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Parse a non-negative integer query parameter.
 *
 * rc-1: the raw value from URLSearchParams is `string | null` (unknown shape
 * from the wire). We validate with typeof + Number.isFinite before use.
 *
 * Returns the parsed integer, or `{ error }` if invalid. When `raw` is null,
 * returns `defaultValue`.
 */
function parseNonNegInt(
  opts: { raw: string | null; fieldName: string; max: number; defaultValue: number },
): number | { error: string } {
  const { raw, fieldName, max, defaultValue } = opts;
  if (raw === null) return defaultValue;
  // rc-1: raw is string from URLSearchParams, but treat defensively
  if (typeof raw !== 'string') return { error: `${fieldName} must be a string` };
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return { error: `${fieldName} must be a finite integer` };
  if (parsed < 0) return { error: `${fieldName} must be >= 0` };
  if (parsed > max) return { error: `${fieldName} must be <= ${max}` };
  return parsed;
}

/**
 * Extract query params from req.url.
 *
 * Returns `null` when the URL has no `?` component (no params).
 */
function extractQueryParams(req: IncomingMessage): URLSearchParams | null {
  const urlStr = req.url ?? '';
  const qIdx = urlStr.indexOf('?');
  if (qIdx < 0) return null;
  return new URLSearchParams(urlStr.slice(qIdx + 1));
}

// ── Route handler ───────────────────────────────────────────────────────────

export type FailedTasksContext = {
  workspaceDir: string;
  subPath: string;
  featureFlags?: Record<string, { enabled: boolean }>;
  /** Optional injected store (used in tests). When absent, a per-workspace cached store is used. */
  sqliteTaskStore?: SqliteTaskStore;
};

/**
 * Handle requests to `/api/v1/failed-tasks*`.
 *
 * Routes:
 *   GET /api/v1/failed-tasks         — list failed/needs_human_review tasks
 *   GET /api/v1/failed-tasks/:id     — fetch single task detail (task + runs + lastError)
 *   other methods                    — 405 Method Not Allowed
 *
 * Feature flag gate: when `ctx.featureFlags.failed_tasks_observability.enabled`
 * is `false`, returns 403 `failed_tasks_observability_disabled`.
 */
export async function handleFailedTasksRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: FailedTasksContext,
): Promise<void> {
  const { workspaceDir, subPath } = ctx;
  const method = req.method ?? 'GET';

  // Feature flag gate — checked before any DB access so a disabled flag
  // short-circuits cleanly (rc-9: error response includes reason + next action).
  if (ctx.featureFlags && Object.hasOwn(ctx.featureFlags, 'failed_tasks_observability')) {
    const flag = ctx.featureFlags.failed_tasks_observability;
    if (flag && !flag.enabled) {
      sendError(
        res,
        403,
        'failed_tasks_observability_disabled',
        'failed_tasks_observability feature flag is disabled. Enable it in .pd/config.yaml (features.failed_tasks_observability.enabled: true) to list failed tasks.',
      );
      return;
    }
  }

  // Collection: GET /api/v1/failed-tasks
  if (subPath === '' || subPath === '/') {
    if (method !== 'GET') {
      sendMethodNotAllowed(res);
      return;
    }

    try {
      const params = extractQueryParams(req);

      // kind: optional string filter (task_kind column)
      const kindRaw = params?.get('kind') ?? null;
      const kind = kindRaw !== null && kindRaw.length > 0 ? kindRaw : undefined;

      // since: optional hours ago → Unix ms cutoff
      let since: number | undefined;
      const sinceRaw = params?.get('since') ?? null;
      if (sinceRaw !== null) {
        const sinceHours = Number.parseInt(sinceRaw, 10);
        if (!Number.isFinite(sinceHours) || sinceHours < 0) {
          sendBadRequest(res, 'since must be a non-negative integer (hours ago)');
          return;
        }
        since = Date.now() - sinceHours * 3600 * 1000;
      }

      // limit: default 50, max 200
      const limitResult = parseNonNegInt({ raw: params?.get('limit') ?? null, fieldName: 'limit', max: 200, defaultValue: 50 });
      if (typeof limitResult !== 'number') {
        sendBadRequest(res, limitResult.error);
        return;
      }
      if (limitResult === 0) {
        sendBadRequest(res, 'limit must be >= 1');
        return;
      }

      // offset: default 0
      const offsetResult = parseNonNegInt({ raw: params?.get('offset') ?? null, fieldName: 'offset', max: 1_000_000, defaultValue: 0 });
      if (typeof offsetResult !== 'number') {
        sendBadRequest(res, offsetResult.error);
        return;
      }

      // If state.db does not exist yet (fresh workspace), return empty list
      // with a reason rather than letting the store throw a schema error.
      if (!stateDbExists(workspaceDir)) {
        sendSuccess(res, {
          tasks: [],
          total: 0,
          nextAction: 'No failed tasks. PD pipeline is healthy. (state.db not yet initialized — no tasks have been created.)',
        });
        return;
      }

      const store = ctx.sqliteTaskStore ?? getStore(workspaceDir);
      const tasks = await store.listFailedTasks({ kind, since, limit: limitResult, offset: offsetResult });
      const total = await store.countFailedTasks({ kind, since });

      if (tasks.length === 0) {
        sendSuccess(res, {
          tasks,
          total,
          nextAction: 'No failed tasks. PD pipeline is healthy.',
        });
      } else {
        sendSuccess(res, { tasks, total });
      }
    } catch (err) {
      sendError(res, 500, 'failed_tasks_list_error', errorMessage(err));
    }
    return;
  }

  // Detail: GET /api/v1/failed-tasks/:id
  const id = subPath.replace(/^\//, '');
  if (id.length === 0) {
    sendNotFound(res, `Route /api/v1/failed-tasks${subPath} not found`);
    return;
  }

  if (method !== 'GET') {
    sendMethodNotAllowed(res);
    return;
  }

  try {
    if (!stateDbExists(workspaceDir)) {
      sendNotFound(res, `Task ${id} not found`);
      return;
    }
    const store = ctx.sqliteTaskStore ?? getStore(workspaceDir);
    const detail = await store.getFailedTaskDetail(id);
    if (!detail) {
      sendNotFound(res, `Task ${id} not found (or it is not in 'failed' / 'needs_human_review' status)`);
      return;
    }
    sendSuccess(res, {
      task: detail.task,
      runs: detail.runs,
      lastError: detail.lastError,
      pendingAgentDraft: detail.pendingAgentDraft,
    });
  } catch (err) {
    sendError(res, 500, 'failed_tasks_detail_error', errorMessage(err));
  }
}
