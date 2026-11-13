// failed-tasks.ts
// Server route for /api/failed-tasks/*
//
// Lists tasks in 'failed' or 'needs_human_review' status and fetches single-task
// detail (task record + run history + last error category). Gated by the
// failed_tasks_observability feature flag.
//
// Governance Recovery Actions v1: POST /api/failed-tasks/:id/recover lets the
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
import {
  SqliteConnection,
  SqliteTaskStore,
  PDRuntimeError,
  createRecoverySweepService,
  appendRecoveryAction,
} from '@principles/core/runtime';
import { resolveStateDbPath } from '@principles/core/runtime/storage-paths';
import {
  sendSuccess,
  sendError,
  sendNotFound,
  sendMethodNotAllowed,
  sendBadRequest,
  errorMessage,
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
  return fs.existsSync(resolveStateDbPath(workspaceDir));
}

/**
 * Decode a percent-encoded path segment into the raw task id (PRI-747 F22
 * review round). The UI client sends `encodeURIComponent(taskId)`; without
 * this decode the store lookup would compare the encoded string ('task%2Fwith
 * %20spaces') against raw ids and 404. Malformed sequences ('%ZZ') are
 * rejected as invalid_encoding rather than thrown (400, same shape as the
 * lifecycle route's decode guard).
 */
function decodeTaskIdSegment(raw: string): { ok: true; value: string } | { ok: false } {
  if (!raw.includes('%')) return { ok: true, value: raw };
  try {
    return { ok: true, value: decodeURIComponent(raw) };
  } catch {
    return { ok: false };
  }
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

// ── PRI-955 (F11): derived learning-queue health projection ─────────────────
//
// "No failed tasks" is NOT "the pipeline is healthy" — the dogfood run
// (2026-10-13) had a 13-deep pending backlog with downstream stages starving
// for 35+ minutes while this page reported the pipeline as healthy. The
// health projection below is DERIVED on read from the same state.db facts the
// failed-task list already uses (no second truth, no new persistence):
// - pendingCount: pending runner-kind tasks (the learning queue)
// - oldestPendingAgeMinutes: queue age of the oldest pending task
// - lastProgressAt: newest succeeded transition (updated_at of the newest
//   succeeded task) — evidence that the pipeline actually advanced recently
// Status rules (documented, never over-claimed):
//   stalled    — work is waiting AND nothing progressed inside the window
//   backlogged — work is waiting and the pipeline still progresses
//   healthy    — nothing waiting AND a succeeded transition inside the window
//   unknown    — no usable evidence (fresh workspace, unreadable counters)
const PIPELINE_STALL_WINDOW_MS = 30 * 60 * 1000;
const PIPELINE_FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
// Runner-kind scoping lives inside SqliteTaskStore.aggregatePipelineHealth
// (the aggregate SQL itself), so unrelated task kinds can never fake freshness.

export interface PipelineHealth {
  status: 'healthy' | 'backlogged' | 'stalled' | 'disabled' | 'unknown';
  pendingCount: number | null;
  oldestPendingTaskKind: string | null;
  oldestPendingAgeMinutes: number | null;
  lastProgressAt: string | null;
  note: string;
  nextAction?: string;
}

function ageMinutes(iso: string | null | undefined, nowMs: number): number | null {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((nowMs - ms) / 60000));
}

async function derivePipelineHealth(store: SqliteTaskStore, consumerEnabled: boolean): Promise<PipelineHealth> {
  const nowMs = Date.now();
  try {
    // C2/C4 (PRI-955 review): exact, untruncated aggregates over the
    // authoritative tasks table, scoped to learning-pipeline runner kinds —
    // a global MAX(succeeded) would let unrelated task kinds fake freshness,
    // and a LIMIT-200 list length would misreport the queue size.
    const agg = await store.aggregatePipelineHealth();
    const {pendingCount} = agg;
    const oldestPendingAgeMinutes = ageMinutes(agg.oldestPendingCreatedAt, nowMs);
    const lastProgressAgeMinutes = ageMinutes(agg.lastSucceededAt, nowMs);
    if (!consumerEnabled) {
      return {
        status: 'disabled', pendingCount, oldestPendingTaskKind: agg.oldestPendingTaskKind, oldestPendingAgeMinutes, lastProgressAt: agg.lastSucceededAt,
        note: `内化自动消费者已禁用（internalization_auto_consumer=false）——学习管道不会推进。当前待处理 ${pendingCount} 个。`,
        nextAction: '在 .pd/config.yaml 设置 features.internalization_auto_consumer.enabled=true，或改用 pd runtime internalization run-once 手动推进。',
      };
    }
    if (pendingCount > 0) {
      const stalled = (oldestPendingAgeMinutes ?? 0) > PIPELINE_STALL_WINDOW_MS / 60000
        && (lastProgressAgeMinutes === null || lastProgressAgeMinutes > PIPELINE_STALL_WINDOW_MS / 60000);
      if (stalled) {
        return {
          status: 'stalled', pendingCount, oldestPendingTaskKind: agg.oldestPendingTaskKind, oldestPendingAgeMinutes, lastProgressAt: agg.lastSucceededAt,
          note: `学习队列有 ${pendingCount} 个待处理任务，最老等待 ${oldestPendingAgeMinutes ?? '?'} 分钟，且窗口内无任何推进。`,
          nextAction: '检查内化消费者是否在运行（OpenClaw 自动消费 / pd codex worker），并查看任务队列明细。',
        };
      }
      return {
        status: 'backlogged', pendingCount, oldestPendingTaskKind: agg.oldestPendingTaskKind, oldestPendingAgeMinutes, lastProgressAt: agg.lastSucceededAt,
        note: `学习队列有 ${pendingCount} 个待处理任务（最老等待 ${oldestPendingAgeMinutes ?? '?'} 分钟）；最近推进 ${agg.lastSucceededAt ?? '未知'}。`,
        nextAction: '积压会随消费者周期逐步消化；若长时间不降，检查消费者运行状态与模型通道。',
      };
    }
    // PRI-955 review P1: healthy requires NO unresolved states either —
    // pendingCount=0 + recent success is NOT healthy if failed, NHR, or
    // retry_wait tasks are still present.
    if (agg.failedCount > 0 || agg.needsHumanReviewCount > 0 || agg.retryWaitCount > 0) {
      const parts: string[] = [];
      if (agg.failedCount > 0) parts.push(`${agg.failedCount} 个失败`);
      if (agg.needsHumanReviewCount > 0) parts.push(`${agg.needsHumanReviewCount} 个需人工审查`);
      if (agg.retryWaitCount > 0) parts.push(`${agg.retryWaitCount} 个等待重试`);
      return {
        status: 'backlogged', pendingCount: 0, oldestPendingTaskKind: null, oldestPendingAgeMinutes: null, lastProgressAt: agg.lastSucceededAt,
        note: `学习队列无积压，但存在未解决任务：${parts.join('、')}。`,
        nextAction: '在失败任务列表查看详情，或在治理焦点处理需人工审查的任务。',
      };
    }
    if (lastProgressAgeMinutes !== null && lastProgressAgeMinutes <= PIPELINE_FRESH_WINDOW_MS / 60000) {
      return {
        status: 'healthy', pendingCount: 0, oldestPendingTaskKind: null, oldestPendingAgeMinutes: null, lastProgressAt: agg.lastSucceededAt,
        note: `学习队列无积压；最近推进 ${agg.lastSucceededAt}。`,
      };
    }
    return {
      status: 'unknown', pendingCount: 0, oldestPendingTaskKind: null, oldestPendingAgeMinutes: null, lastProgressAt: agg.lastSucceededAt,
      note: '当前没有待处理任务，但窗口内没有可确认的推进证据——无法判定管道健康。',
      nextAction: '产生一次真实任务（或运行一次内化消费者）后回到本页复查。',
    };
  } catch {
    // rc-9: 降级必须可观察——无法读取队列事实时报告 unknown，而非默认健康。
    return {
      status: 'unknown', pendingCount: null, oldestPendingTaskKind: null, oldestPendingAgeMinutes: null, lastProgressAt: null,
      note: '学习队列状态不可读（计数失败）——无法判定管道健康。',
      nextAction: '检查 .pd/state.db 可读性，或用 pd health 查看工作区诊断。',
    };
  }
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
          nextAction: 'Open the Console governance workbench (#/workbench) and resolve the decision there.',
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

/**
 * P1-3: project the structured failure facts already persisted in the task's
 * diagnosticJson into a small, validated read model for the failed-task page.
 *
 * Why server-side: the raw diagnosticJson is an internal envelope (pi_metadata,
 * lastValidatorErrors, output_failure_details, terminal_failure,
 * validator_error_history, failed_stage). Shipping it wholesale would expose
 * internals the UI must not depend on. This projection copies only the facts
 * the Owner needs and DROPS anything malformed — a projection is a read model
 * over the existing single source of truth, never a second one.
 */
interface FailureHumanReviewProjection {
  reasonCode: string | null;
  detail: string | null;
  missingFields: string[];
  nextAction: string | null;
  sourceRunId: string | null;
  sourceArtifactId: string | null;
  createdAt: string | null;
}

interface FailureIdentityPreflightProjection {
  status: string | null;
  reasonCode: string | null;
  detail: string | null;
  nextAction: string | null;
  /** P1-3: where the block happened + whether any artifact was produced. */
  stage: string | null;
  generated: boolean | null;
}

interface FailureDiagnosticsProjection {
  terminalReason: string | null;
  terminalErrorCategory: string | null;
  validatorErrors: string[];
  failedStage: {
    stageTaskId: string;
    stageTaskKind: string;
    errorCategory: string | null;
    terminalReason: string | null;
    attemptCount: number;
    maxAttempts: number;
    validatorErrors: string[];
  } | null;
  /** P1-4: structured Owner-facing diagnosis (pi_metadata.humanReviewContext). */
  humanReview: FailureHumanReviewProjection | null;
  /** P1-4: identity preflight outcome, when the producer recorded one. */
  identityPreflight: FailureIdentityPreflightProjection | null;
  /** Bounded raw evidence excerpts; never a replacement for the fact itself. */
  evidenceSummary: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function optionalString(obj: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(obj, key)) return null;
  const value = obj[key];
  return typeof value === 'string' ? value : null;
}

/** `detail` may itself be a JSON document; expose its useful fields without inventing them. */
function detailFields(detail: string | null): { missingFields: string[]; nextAction: string | null } {
  if (detail === null) return { missingFields: [], nextAction: null };
  try {
    const parsed = JSON.parse(detail);
    if (!isRecord(parsed)) return { missingFields: [], nextAction: null };
    return {
      missingFields: toStringArray(parsed.missingFields),
      nextAction: optionalString(parsed, 'nextAction'),
    };
  } catch {
    return { missingFields: [], nextAction: null };
  }
}

function projectHumanReview(value: unknown): FailureHumanReviewProjection | null {
  const record = asRecord(value);
  if (!record) return null;
  const detail = optionalString(record, 'detail');
  const { missingFields, nextAction } = detailFields(detail);
  return {
    reasonCode: optionalString(record, 'reasonCode'),
    detail,
    missingFields,
    nextAction,
    sourceRunId: optionalString(record, 'sourceRunId'),
    sourceArtifactId: optionalString(record, 'sourceArtifactId'),
    createdAt: optionalString(record, 'createdAt'),
  };
}

function projectIdentityPreflight(value: unknown): FailureIdentityPreflightProjection | null {
  const record = asRecord(value);
  if (!record) return null;
  const generatedRaw = Object.hasOwn(record, 'generated') ? record.generated : null;
  return {
    status: optionalString(record, 'status'),
    reasonCode: optionalString(record, 'reasonCode') ?? optionalString(record, 'reason'),
    detail: optionalString(record, 'detail') ?? optionalString(record, 'message'),
    nextAction: optionalString(record, 'nextAction'),
    stage: optionalString(record, 'stage'),
    generated: typeof generatedRaw === 'boolean' ? generatedRaw : null,
  };
}

function evidenceLine(label: string, value: string | null): string[] {
  if (value === null || value.trim() === '') return [];
  return [`${label}: ${value.length > 500 ? `${value.slice(0, 500)}…` : value}`];
}

function projectionFromFailure(
  failed: Record<string, unknown>,
): FailureDiagnosticsProjection['failedStage'] {
  const {attemptCount} = failed;
  const {maxAttempts} = failed;
  if (typeof failed.stageTaskId !== 'string' || typeof failed.stageTaskKind !== 'string') return null;
  if (typeof attemptCount !== 'number' || !Number.isFinite(attemptCount)) return null;
  if (typeof maxAttempts !== 'number' || !Number.isFinite(maxAttempts)) return null;
  return {
    stageTaskId: failed.stageTaskId,
    stageTaskKind: failed.stageTaskKind,
    errorCategory: optionalString(failed, 'errorCategory'),
    terminalReason: optionalString(failed, 'terminalReason'),
    attemptCount,
    maxAttempts,
    validatorErrors: toStringArray(failed.validatorErrors),
  };
}

function projectFailureDiagnostics(diagnosticJson: string | null | undefined): FailureDiagnosticsProjection | null {
  if (!diagnosticJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(diagnosticJson);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (!envelope) return null;

  const terminal = Object.hasOwn(envelope, 'terminal_failure') ? asRecord(envelope.terminal_failure) : null;
  const lastValidator = Object.hasOwn(envelope, 'lastValidatorErrors') ? asRecord(envelope.lastValidatorErrors) : null;
  const outputFailure = Object.hasOwn(envelope, 'output_failure_details') ? asRecord(envelope.output_failure_details) : null;
  const failedStage = Object.hasOwn(envelope, 'failed_stage') ? asRecord(envelope.failed_stage) : null;

  const validatorErrors = lastValidator ? toStringArray(lastValidator.errors) : [];
  const effectiveValidatorErrors = validatorErrors.length > 0
    ? validatorErrors
    : outputFailure
      ? toStringArray(outputFailure.validatorErrors)
      : [];

  const piMetadata = Object.hasOwn(envelope, 'pi_metadata') ? asRecord(envelope.pi_metadata) : null;
  const humanReview = piMetadata ? projectHumanReview(piMetadata.humanReviewContext) : null;
  const identityPreflight = Object.hasOwn(envelope, 'identityPreflight')
    ? projectIdentityPreflight(envelope.identityPreflight)
    : null;

  const evidenceSummary = [
    ...evidenceLine('humanReview.reasonCode', humanReview?.reasonCode ?? null),
    ...evidenceLine('humanReview.detail', humanReview?.detail ?? null),
    ...evidenceLine('humanReview.missingFields', humanReview && humanReview.missingFields.length > 0 ? humanReview.missingFields.join(', ') : null),
    ...evidenceLine('identityPreflight', identityPreflight
      ? JSON.stringify({
        status: identityPreflight.status,
        reasonCode: identityPreflight.reasonCode,
        detail: identityPreflight.detail,
        stage: identityPreflight.stage,
        generated: identityPreflight.generated,
      })
      : null),
    ...evidenceLine('terminal_failure', terminal ? JSON.stringify(terminal) : null),
    ...evidenceLine('validator_error', effectiveValidatorErrors[effectiveValidatorErrors.length - 1] ?? null),
    ...evidenceLine('failed_stage', failedStage ? JSON.stringify({
      stageTaskId: failedStage.stageTaskId,
      stageTaskKind: failedStage.stageTaskKind,
      errorCategory: failedStage.errorCategory,
    }) : null),
  ].slice(0, 8);

  const projection: FailureDiagnosticsProjection = {
    terminalReason: terminal ? optionalString(terminal, 'reason') : null,
    terminalErrorCategory: terminal ? optionalString(terminal, 'errorCategory') : null,
    validatorErrors: effectiveValidatorErrors,
    failedStage: failedStage ? projectionFromFailure(failedStage) : null,
    humanReview,
    identityPreflight,
    evidenceSummary,
  };

  // Nothing to say: behave as if the server never sent the block.
  if (
    projection.terminalReason === null
    && projection.terminalErrorCategory === null
    && projection.validatorErrors.length === 0
    && projection.failedStage === null
    && projection.humanReview === null
    && projection.identityPreflight === null
  ) {
    return null;
  }
  return projection;
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
 * Handle requests to `/api/failed-tasks*`.
 *
 * Routes:
 *   GET  /api/failed-tasks              — list failed/needs_human_review tasks
 *   GET  /api/failed-tasks/:id          — fetch single task detail (task + runs + lastError)
 *   POST /api/failed-tasks/:id/recover  — Owner recovery (failed | needs_human_review → pending)
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

  // Collection: GET /api/failed-tasks
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
          pipeline: { status: 'unknown', pendingCount: null, oldestPendingTaskKind: null, oldestPendingAgeMinutes: null, lastProgressAt: null, note: 'state.db 尚未初始化——工作区还没有任何任务，管道健康状态未知。', nextAction: '运行时开始创建任务后回到本页复查。' },
          nextAction: 'No failed tasks. (state.db not yet initialized — pipeline health is UNKNOWN until the runtime creates tasks.)',
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

      // PRI-955 (F11): "no failed tasks" ≠ "pipeline healthy" — derive the
      // learning-queue health projection from the same state.db facts and let
      // the UI show it next to the empty claim.
      const consumerFlag = ctx.featureFlags && Object.hasOwn(ctx.featureFlags, 'internalization_auto_consumer')
        ? ctx.featureFlags.internalization_auto_consumer
        : undefined;
      const consumerEnabled = consumerFlag ? consumerFlag.enabled === true : true; // 无该 flag 时无法断言禁用——不因缺失而宣称 disabled
      const pipeline = await derivePipelineHealth(store, consumerEnabled);

      // Only claim anything like "healthy" from the pipeline projection, never
      // from the failed-task count alone. When tasks.length === 0 but
      // total > 0, the caller has paginated past the last page.
      if (total === 0) {
        sendSuccess(res, {
          tasks: enriched,
          total,
          pipeline,
          nextAction: pipeline.status === 'healthy'
            ? `No failed tasks in the queried range. ${pipeline.note}`
            : `No failed tasks in the queried range. Pipeline status: ${pipeline.status} — ${pipeline.note}`,
        });
      } else {
        sendSuccess(res, { tasks: enriched, total, pipeline });
      }
    } catch (err) {
      sendError(res, 500, 'failed_tasks_list_error', errorMessage(err));
    }
    return;
  }

  // Recovery: POST /api/failed-tasks/:id/recover (Governance Recovery
  // Actions v1). Checked before the generic /:id detail branch.
  // eslint-disable-next-line @typescript-eslint/prefer-regexp-exec -- String#match is semantically identical for a non-global regex; the repo's security write-gate false-positives on `<expr>.exec(userInput)` as command injection, so RegExp#exec is not writable here.
  const recoverMatch = subPath.match(/^\/([^/]+)\/recover$/);
  if (recoverMatch) {
    // recoverMatch[1] = captured task id (segment between the leading '/'
    // and the trailing '/recover'); percent-decoded before store lookup
    const decodedTaskId = decodeTaskIdSegment(recoverMatch[1] ?? '');
    if (!decodedTaskId.ok) {
      sendError(res, 400, 'invalid_encoding', 'task id path segment is not valid percent-encoding');
      return;
    }
    const taskId = decodedTaskId.value;

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
        console.warn('[failed-tasks] recovery audit append failed:', errorMessage(auditErr));
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

  // Detail: GET /api/failed-tasks/:id
  const decodedId = decodeTaskIdSegment(subPath.replace(/^\//, ''));
  if (!decodedId.ok) {
    sendError(res, 400, 'invalid_encoding', 'task id path segment is not valid percent-encoding');
    return;
  }
  const id = decodedId.value;
  if (id.length === 0) {
    sendNotFound(res, `Route /api/failed-tasks${subPath} not found`);
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
    const projection = projectFailureDiagnostics(detail.task.diagnosticJson);
    sendSuccess(res, {
      task: detail.task,
      runs: detail.runs,
      lastError: detail.lastError,
      // P1-3: structured failure facts (terminal reason + newest validator
      // errors + failed-stage projection). Omitted entirely when nothing
      // structured is persisted, so older rows keep the previous payload shape.
      ...(projection !== null ? { diagnostics: projection } : {}),
      pendingAgentDraft: detail.pendingAgentDraft,
    });
  } catch (err) {
    sendError(res, 500, 'failed_tasks_detail_error', errorMessage(err));
  }
}
