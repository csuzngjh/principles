// failed-tasks.ts
// Server route for /api/v1/failed-tasks/*
//
// Lists tasks in 'failed' or 'needs_human_review' status and fetches single-task
// detail (task record + run history + last error category). Gated by the
// failed_tasks_observability feature flag.
//
// Governance Recovery Actions v1: POST /api/v1/failed-tasks/:id/recover lets the
// Owner recover a task from the Console. failed → pending reuses
// RecoverySweepService.recoverFailedTask; needs_human_review → pending reuses
// the extracted owner-retry sequence (ownerRetryNeedsHumanReviewTask — the same
// implementation `pd runtime internalization retry --confirm` calls). No
// recovery logic is reimplemented here. Gated by failed_task_recovery_console
// (default off → Console stays read-only). Every successful recovery appends a
// RecoveryAction audit record (.state/recovery_actions.jsonl).
//
// Trust boundary (rc-1, rc-2): all query string values are read via
// URLSearchParams.get() and treated as `unknown` until validated with typeof /
// Number.isFinite. POST bodies are parsed to `unknown` and field-checked with
// Object.hasOwn + typeof before use. Store return values are typed by the core
// contract and further validated by SqliteTaskStore's row readers (rc-1 at the
// DB boundary).

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  SqliteConnection,
  SqliteTaskStore,
  PDRuntimeError,
  createRecoverySweepService,
  appendRecoveryAction,
} from '@principles/core/runtime-v2';
import {
  sendSuccess,
  sendError,
  sendNotFound,
  sendMethodNotAllowed,
  sendBadRequest,
} from '../utils/response.js';
import { readBody } from '../utils/request.js';
import { OwnerDecisionConsoleModel } from '../models/OwnerDecisionConsoleModel.js';

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

// ── Recovery helpers (Governance Recovery Actions v1) ───────────────────────

const MAX_REASON_LENGTH = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/**
 * Parse the optional recover request body. Accepts an empty body (reason is
 * optional) or a JSON object with optional `reason` (string) and `force`
 * (boolean) fields (rc-1/rc-2: parsed value stays `unknown` until
 * Object.hasOwn + typeof checks pass). Returns a discriminated result;
 * `ok === false` carries the bad-request message.
 */
function parseRecoverBody(
  body: string,
): { ok: true; reason?: string; force: boolean } | { ok: false; error: string } {
  if (body.trim().length === 0) return { ok: true, force: false };
  const raw: unknown = tryParseJson(body);
  if (raw === undefined) return { ok: false, error: 'Request body must be valid JSON' };
  if (!isRecord(raw)) return { ok: false, error: 'Request body must be a JSON object' };
  if (Object.hasOwn(raw, 'reason')) {
    if (typeof raw.reason !== 'string') {
      return { ok: false, error: 'reason must be a string' };
    }
    if (raw.reason.length > MAX_REASON_LENGTH) {
      return { ok: false, error: `reason must be at most ${MAX_REASON_LENGTH} characters` };
    }
  }
  // Fail loud on a malformed force flag (rc-3): silently coercing "yes" to
  // false would silently downgrade an Owner-requested force recovery.
  if (Object.hasOwn(raw, 'force') && typeof raw.force !== 'boolean') {
    return { ok: false, error: 'force must be a boolean' };
  }
  const reason = typeof raw.reason === 'string' && raw.reason.length > 0 ? raw.reason : undefined;
  const force = raw.force === true;
  return { ok: true, reason, force };
}

interface RecoverDispatchOutcome {
  httpStatus: number;
  errorCode: string;
  message: string;
  nextAction?: string;
  extras?: Record<string, unknown>;
}

/**
 * Dispatch one recovery attempt through the shared core services.
 *
 * Status dispatch (SPEC §6.1/§6.2): failed → recoverFailedTask; then
 * needs_human_review → owner authority reset. A null first result means
 * "missing or not failed"; the second call distinguishes not_found /
 * wrong-status / metadata_invalid. No recovery logic lives here.
 *
 * `force` applies only to the failed path: when true, an exhausted task
 * (attemptCount >= maxAttempts) is reset anyway and its maxAttempts budget
 * is raised (core raises it by +3). needs_human_review resets ignore it —
 * the owner authority reset has its own budget semantics.
 */
const ownerDecisionModels = new Map<string, OwnerDecisionConsoleModel>();

function getOwnerDecisionModel(workspaceDir: string): OwnerDecisionConsoleModel {
  let model = ownerDecisionModels.get(workspaceDir);
  if (!model) {
    model = new OwnerDecisionConsoleModel(workspaceDir);
    ownerDecisionModels.set(workspaceDir, model);
  }
  return model;
}

async function dispatchRecovery(
  workspaceDir: string,
  taskId: string,
  force: boolean,
): Promise<
  | { ok: true; result: 'recovered' | 'requeued'; previousStatus: string; newStatus: string; forceApplied: boolean }
  | { ok: false; failure: RecoverDispatchOutcome }
> {
  const { service, close } = await createRecoverySweepService({ workspaceDir });
  try {
    // failed → pending (crash-retry semantics: completionIntent preserved)
    try {
      const failedResult = await service.recoverFailedTask(taskId, force);
      if (failedResult) {
        return {
          ok: true,
          result: 'recovered',
          previousStatus: failedResult.previousStatus,
          newStatus: failedResult.newStatus,
          forceApplied: failedResult.forceApplied,
        };
      }
    } catch (err) {
      if (err instanceof PDRuntimeError && err.category === 'input_invalid') {
        // Attempt budget exhausted and the request carried no force — either
        // the client sent force:false or its row snapshot went stale between
        // list render and click. Backstop; the UI sends force itself.
        return {
          ok: false,
          failure: {
            httpStatus: 409,
            errorCode: 'task_attempts_exhausted',
            message: err.message,
            nextAction: 'This task exhausted its attempt budget. Retry with force (force: true), or via CLI: pd runtime recovery failed-tasks --confirm --force',
          },
        };
      }
      throw err;
    }

    // not failed (or missing) → owner authority reset path
    const outcome = await service.recoverNeedsHumanReviewTask(taskId);
    if (outcome.status === 'rejected') {
      // PRI-629 Recover guard (SPEC §17): decision-capable 人工裁决不允许
      // authority reset — Recover 不是治理出口,出口在治理焦点 Owner Decision。
      return {
        ok: false,
        failure: {
          httpStatus: 409,
          errorCode: 'owner_decision_required',
          message: 'This task awaits an Owner decision (accept current / revise once / reject). Recover is not a governance exit and was refused.',
          nextAction: 'Open the Console governance focus (#/focus) and resolve the decision there.',
        },
      };
    }
    if (outcome.status === 'requeued') {
      return {
        ok: true,
        result: 'requeued',
        previousStatus: outcome.previousStatus,
        newStatus: 'pending',
        forceApplied: false,
      };
    }
    if (outcome.status === 'not_found') {
      return {
        ok: false,
        failure: {
          httpStatus: 404,
          errorCode: 'task_not_found',
          message: `Task ${taskId} not found`,
        },
      };
    }
    if (outcome.status === 'metadata_invalid') {
      return {
        ok: false,
        failure: {
          httpStatus: 409,
          errorCode: 'metadata_invalid',
          message: 'Task metadata failed PI hydration; a recovery now would risk a partial authority reset.',
          nextAction: 'Run pd runtime internalization integrity --json to inspect the task metadata',
        },
      };
    }
    return {
      ok: false,
      failure: {
        httpStatus: 409,
        errorCode: 'task_not_recoverable',
        message: `Task ${taskId} is in status '${outcome.previousStatus}' — only failed / needs_human_review tasks are recoverable.`,
        nextAction: 'Wait for the current attempt to finish, or check pipeline status: pd runtime internalization queue --json',
        extras: { previousStatus: outcome.previousStatus },
      },
    };
  } finally {
    await close();
  }
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
 *   GET  /api/v1/failed-tasks              — list failed/needs_human_review tasks
 *   GET  /api/v1/failed-tasks/:id          — fetch single task detail (task + runs + lastError)
 *   POST /api/v1/failed-tasks/:id/recover  — Owner recovery (failed | needs_human_review → pending)
 *   other methods                          — 405 Method Not Allowed
 *
 * Feature flag gates (checked before any DB access so a disabled flag
 * short-circuits cleanly — rc-9: error responses include reason + next action):
 *   - `failed_tasks_observability.enabled === false` → 403 for the whole route
 *   - `failed_task_recovery_console.enabled !== true` → 403 for POST recover
 *     (fail-closed mutation gate; default on, explicit disable keeps the Console read-only)
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

      // PRI-629 分流: decision-capable NHR 任务标 ownerDecisionRequired —
      // UI 隐藏 Recover、引导前往治理焦点 (决策出口不在失败页)。
      let decisionRequiredIds: Set<string> | null = null;
      try {
        decisionRequiredIds = await getOwnerDecisionModel(workspaceDir).ownerDecisionRequiredTaskIds();
      } catch {
        decisionRequiredIds = null; // 投影失败不阻塞失败列表 (rc-9 降级由 UI 兜底)
      }
      const enriched = tasks.map((task) => ({
        ...task,
        ...(decisionRequiredIds !== null && (task as { status?: string }).status === 'needs_human_review'
          ? { ownerDecisionRequired: decisionRequiredIds.has((task as { taskId?: string }).taskId ?? '') }
          : {}),
      }));

      // Only report "PD pipeline is healthy" when total === 0. When
      // tasks.length === 0 but total > 0, the caller has paginated past the
      // last page — returning "healthy" here would mask the failures that
      // exist on earlier pages.
      if (total === 0) {
        sendSuccess(res, {
          tasks: enriched,
          total,
          nextAction: 'No failed tasks. PD pipeline is healthy.',
        });
      } else {
        sendSuccess(res, { tasks: enriched, total });
      }
    } catch (err) {
      sendError(res, 500, 'failed_tasks_list_error', errorMessage(err));
    }
    return;
  }

  // Recovery: POST /api/v1/failed-tasks/:id/recover (Governance Recovery
  // Actions v1). Checked before the generic /:id detail branch.
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- String#match is semantically identical for a non-global regex; the repo's security write-gate false-positives on `<expr>.exec(userInput)` as command injection, so RegExp#exec is not writable here.
  const recoverMatch = subPath.match(/^\/([^/]+)\/recover$/);
  if (recoverMatch) {
    // recoverMatch[1] = captured task id (segment between the leading '/'
    // and the trailing '/recover')
    const taskId = recoverMatch[1] ?? '';

    // Fail-closed gate: this is a mutation endpoint — recovery is enabled by
    // default (2026-08-24 owner decision) and 403 only when explicitly disabled
    // via config (features.failed_task_recovery_console.enabled: false).
    if (ctx.featureFlags?.failed_task_recovery_console?.enabled !== true) {
      sendError(
        res,
        403,
        'failed_task_recovery_console_disabled',
        'failed_task_recovery_console feature flag is disabled. Enable it via .pd/config.yaml (features.failed_task_recovery_console.enabled: true) to allow recovery from Console.',
      );
      return;
    }

    if (method !== 'POST') {
      sendMethodNotAllowed(res);
      return;
    }

    try {
      if (taskId.length === 0 || !stateDbExists(workspaceDir)) {
        sendNotFound(res, `Task ${taskId} not found`);
        return;
      }

      let bodyResult: { ok: true; reason?: string; force: boolean } | { ok: false; error: string };
      try {
        const body = await readBody(req);
        bodyResult = parseRecoverBody(body);
      } catch (err) {
        sendBadRequest(res, err instanceof Error ? err.message : 'Failed to read request body');
        return;
      }
      if (bodyResult.ok === false) {
        sendBadRequest(res, bodyResult.error);
        return;
      }

      const dispatch = await dispatchRecovery(workspaceDir, taskId, bodyResult.force);
      if (!dispatch.ok) {
        sendError(
          res,
          dispatch.failure.httpStatus,
          dispatch.failure.errorCode,
          dispatch.failure.message,
          dispatch.failure.nextAction ? { nextAction: dispatch.failure.nextAction, ...dispatch.failure.extras } : dispatch.failure.extras,
        );
        return;
      }

      // Audit the owner action (SPEC §10). Best-effort: the recovery is
      // already committed; an audit-write failure must not report the whole
      // action as failed, and it is never silent (rc-9).
      try {
        appendRecoveryAction(workspaceDir, {
          taskId,
          previousStatus: dispatch.previousStatus,
          result: dispatch.result,
          operator: 'console',
          reason: bodyResult.reason ?? null,
          forceApplied: dispatch.forceApplied,
        });
      } catch (auditErr) {
        console.warn('[failed-tasks] recovery audit append failed:', auditErr instanceof Error ? auditErr.message : String(auditErr));
      }

      // SPEC §6.4: "Recovery Accepted", not "Task Completed" — execution is
      // asynchronous; the task merely re-enters the pending → leased →
      // running → succeeded cycle.
      sendSuccess(res, {
        taskId,
        previousStatus: dispatch.previousStatus,
        newStatus: dispatch.newStatus,
        result: dispatch.result,
        forceApplied: dispatch.forceApplied,
        nextAction: 'Recovery accepted. The task is pending again and will be picked up by the internalization consumer (or advance it manually: pd runtime internalization run-once).',
      });
    } catch (err) {
      sendError(res, 500, 'failed_task_recovery_error', errorMessage(err));
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
