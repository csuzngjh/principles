/**
 * FailedTasksPage — Pipeline observability page showing failed or
 * needs_human_review tasks, grouped by taskKind.
 *
 * Part of the PD feedback-pipeline observability spec (Task 10).
 * Gated by the `failed_tasks_observability` feature flag. When the flag is
 * disabled, the backend returns 403 and this page shows a "disabled" state
 * with guidance on how to enable the flag.
 *
 * Each row exposes a "Create Feedback Draft" button that deep-links into the
 * Report Problem page with the task/pain context pre-filled.
 *
 * Governance Recovery Actions v1: when the `failed_task_recovery_console`
 * feature flag is enabled, each row also exposes a "Resume Evolution" button.
 * Recovery is an Owner governance action (never auto-triggered on load): it
 * always goes through an explicit confirmation dialog before POSTing
 * /api/failed-tasks/:id/recover. The success state means "Recovery
 * Accepted" — the task is pending again; execution is asynchronous.
 *
 * PRI-747 F22 / PRI-749: each row can be expanded into its detail — the full
 * task record plus run history — fetched lazily from the pre-existing
 * GET /api/failed-tasks/:id endpoint (server route +
 * SqliteTaskStore.getFailedTaskDetail already existed; the UI simply never
 * consumed them).
 *
 * Runtime Contract (rc-*):
 * - rc-1: API response is treated as `unknown` and validated before use
 * - rc-2: no `as` type assertions — runtime type guards only
 * - rc-5: `Object.hasOwn()` for untrusted object keys
 * - rc-9: every error/disabled path surfaces a reason + next action
 */
import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { Badge } from "../../components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Button } from "../../components/ui/button.js";
import { FieldLabel } from "../../components/ui/field-label.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "../../components/ui/alert-dialog.js";
import { FreshnessStamp } from "../../components/layout/freshness-stamp.js";
import { StatePanel } from "../../components/ui/state-panel.js";
import { describeApiError, humanizeRuntimeText } from "../../utils/technical-detail.js";
import { formatDate } from "../../utils/format-date.js";
import i18n from "../../i18n/index.js";
import { recoverFailedTask, fetchConfigSummary, fetchFailedTaskDetail, request } from "../../api.js";
import type { FailedTaskDetailData } from "../../utils/validators.js";
import { deriveFailureSummary } from "./failure-summary.js";

// Same component set the former utils/format.js rendered, now served by the
// defensive single-owner formatter: an invalid date string returns the raw
// input instead of Intl throwing RangeError mid-render (review round of
// PRI-747 F22 — utils/format.js was retired with this migration).
const DATETIME_FORMAT_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};
function formatDateTime(iso: string): string {
  return formatDate(iso, i18n.language, DATETIME_FORMAT_OPTS);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface FailedTask {
  taskId: string;
  taskKind: string;
  painId: string | null;
  status: string;
  lastError: string | null;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
  /** PRI-629: decision-capable NHR — 决策出口在治理焦点,不显示 Recover */
  ownerDecisionRequired?: boolean;
}

interface PipelineHealthInfo {
  status: "healthy" | "backlogged" | "stalled" | "disabled" | "unknown";
  pendingCount: number | null;
  oldestPendingTaskKind: string | null;
  oldestPendingAgeMinutes: number | null;
  lastProgressAt: string | null;
  note: string;
  nextAction?: string;
}

interface FailedTasksData {
  tasks: FailedTask[];
  total: number;
  nextAction?: string;
  /** PRI-955 (F11): derived learning-queue health — "no failed tasks" is not "healthy". */
  pipeline?: PipelineHealthInfo;
}

// ── Pipeline metrics (SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §3.4) ──
//
// Distinct from `PipelineHealthInfo`: that is ONE derived status word, this is
// the quantitative projection (queue depth, stage percentiles, reliability,
// provider, tokens). Metrics whose data is not persisted arrive as
// `available: false` with a reason — the UI renders the reason, never a 0.

interface MetricValueView {
  available: boolean;
  value: number | null;
  reason: string | null;
}

interface LatencyView {
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

interface StageMetricsView {
  sampleCount: number;
  successCount: number;
  failureCount: number;
  duration: LatencyView;
}

interface PipelineMetricsView {
  windowHours: number;
  queue: {
    painQueueDepth: number;
    readyQueueDepth: number;
    retryQueueDepth: number;
    leasedCount: number;
    oldestPendingAgeMs: number | null;
  };
  stages: { a: StageMetricsView; b: StageMetricsView; c: StageMetricsView };
  queueWait: LatencyView;
  reliability: {
    stageRetryCount: number;
    expiredActiveLeaseCount: number;
    diagnosisSuccessRate: MetricValueView;
    leaseRenewalFailureCount: MetricValueView;
    leaseRecoveryCount: MetricValueView;
    staleCommitRejectedCount: MetricValueView;
  };
  provider: {
    errorRate: MetricValueView;
    rateLimitCount: number;
    timeoutCount: number;
  };
  tokens: { tokensPerPain: MetricValueView };
  stage2: { pendingDepth: MetricValueView };
  lineage: { available: boolean; reason: string | null; count: number };
}

// ── Page state ───────────────────────────────────────────────────────────────

type PageState =
  | { status: "loading" }
  | { status: "loaded"; data: FailedTasksData }
  | { status: "error"; message: string; nextAction?: string }
  | { status: "disabled" };

// ── Runtime validators (rc-1, rc-2, rc-5) ───────────────────────────────────
//
// The API response is `unknown` until these guards run. No `as` casts.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && !Number.isNaN(v);
}

function readString(v: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(v, key)) return null;
  return isString(v[key]) ? v[key] : null;
}

function readNullableString(v: Record<string, unknown>, key: string): string | null {
  if (!Object.hasOwn(v, key)) return null;
  const val = v[key];
  if (val === null) return null;
  return isString(val) ? val : null;
}

function readNumber(v: Record<string, unknown>, key: string): number | null {
  if (!Object.hasOwn(v, key)) return null;
  return isNumber(v[key]) ? v[key] : null;
}

function validateTask(v: unknown): FailedTask | null {
  if (!isObject(v)) return null;
  const taskId = readString(v, "taskId");
  const taskKind = readString(v, "taskKind");
  const status = readString(v, "status");
  const attemptCount = readNumber(v, "attemptCount");
  const maxAttempts = readNumber(v, "maxAttempts");
  const createdAt = readString(v, "createdAt");
  // Required fields — fail loud when missing or wrong type (rc-3)
  if (
    taskId === null ||
    taskKind === null ||
    status === null ||
    attemptCount === null ||
    maxAttempts === null ||
    createdAt === null
  ) {
    return null;
  }
  const painId = readNullableString(v, "painId");
  const lastError = readNullableString(v, "lastError");
  const lastAttemptAt = readNullableString(v, "lastAttemptAt");
  const ownerDecisionRequired = Object.hasOwn(v, "ownerDecisionRequired")
    ? v.ownerDecisionRequired === true
    : undefined;
  return {
    taskId,
    taskKind,
    painId,
    status,
    lastError,
    attemptCount,
    maxAttempts,
    createdAt,
    lastAttemptAt,
    ...(ownerDecisionRequired !== undefined ? { ownerDecisionRequired } : {}),
  };
}

function validateFailedTasksData(v: unknown): FailedTasksData | null {
  if (!isObject(v)) return null;
  if (!Object.hasOwn(v, "tasks")) return null;
  const tasksRaw = v.tasks;
  if (!Array.isArray(tasksRaw)) return null;
  const tasks: FailedTask[] = [];
  for (const item of tasksRaw) {
    const task = validateTask(item);
    if (task === null) return null;
    tasks.push(task);
  }
  const total = readNumber(v, "total");
  if (total === null) return null;
  const nextAction = readNullableString(v, "nextAction");
  // PRI-955 (F11): optional pipeline health block — an invalid block is
  // omitted (never fails the whole payload), the page then renders nothing.
  let pipeline: PipelineHealthInfo | undefined;
  if (Object.hasOwn(v, "pipeline") && isObject(v.pipeline)) {
    const p = v.pipeline;
    const status = readString(p, "status");
    const note = readString(p, "note");
    if (status === "healthy" || status === "backlogged" || status === "stalled" || status === "disabled" || status === "unknown") {
      if (note !== null) {
        pipeline = {
          status,
          pendingCount: readNumber(p, "pendingCount"),
          oldestPendingTaskKind: readNullableString(p, "oldestPendingTaskKind"),
          oldestPendingAgeMinutes: readNumber(p, "oldestPendingAgeMinutes"),
          lastProgressAt: readNullableString(p, "lastProgressAt"),
          note,
          nextAction: readNullableString(p, "nextAction") ?? undefined,
        };
      }
    }
  }
  return { tasks, total, nextAction: nextAction ?? undefined, ...(pipeline ? { pipeline } : {}) };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readMetricValue(v: unknown): MetricValueView | null {
  if (!isObject(v)) return null;
  const available = Object.hasOwn(v, "available") ? v.available === true : false;
  const value = readNumber(v, "value");
  if (available && value === null) {
    // `available:true` without a value is a broken payload, not a zero.
    return { available: false, value: null, reason: "value missing from response" };
  }
  return { available, value: available ? value : null, reason: readNullableString(v, "reason") };
}

function readLatency(v: unknown): LatencyView | null {
  if (!isObject(v)) return null;
  const sampleCount = readNumber(v, "sampleCount");
  if (sampleCount === null) return null;
  return {
    sampleCount,
    p50Ms: readNumber(v, "p50Ms"),
    p95Ms: readNumber(v, "p95Ms"),
    p99Ms: readNumber(v, "p99Ms"),
  };
}

function readStageMetrics(v: unknown): StageMetricsView | null {
  if (!isObject(v)) return null;
  const sampleCount = readNumber(v, "sampleCount");
  const successCount = readNumber(v, "successCount");
  const failureCount = readNumber(v, "failureCount");
  if (sampleCount === null || successCount === null || failureCount === null) return null;
  const duration = readLatency(v.duration);
  if (duration === null) return null;
  return { sampleCount, successCount, failureCount, duration };
}

/**
 * Validate the /api/pipeline-health payload (rc-1/rc-2). Any malformed REQUIRED
 * block rejects the whole payload; optional unavailable metrics must still carry
 * their `available` flag so the UI can explain the gap.
 */
function validatePipelineMetricsData(v: unknown): PipelineMetricsView | null {
  if (!isObject(v)) return null;
  const windowHours = readNumber(v, "windowHours");
  const metrics = v.metrics;
  if (windowHours === null || !isObject(metrics)) return null;

  const queue = metrics.queue;
  if (!isObject(queue)) return null;
  const painQueueDepth = readNumber(queue, "painQueueDepth");
  const readyQueueDepth = readNumber(queue, "readyQueueDepth");
  const retryQueueDepth = readNumber(queue, "retryQueueDepth");
  const leasedCount = readNumber(queue, "leasedCount");
  if (painQueueDepth === null || readyQueueDepth === null || retryQueueDepth === null || leasedCount === null) return null;

  const stages = metrics.stages;
  if (!isObject(stages)) return null;
  const stageA = readStageMetrics(stages.a);
  const stageB = readStageMetrics(stages.b);
  const stageC = readStageMetrics(stages.c);
  if (stageA === null || stageB === null || stageC === null) return null;

  const queueWait = readLatency(metrics.queueWait);
  const reliability = metrics.reliability;
  const provider = metrics.provider;
  const tokens = metrics.tokens;
  const stage2 = metrics.stage2;
  const lineage = metrics.lineage;
  if (queueWait === null || !isObject(reliability) || !isObject(provider) || !isObject(tokens) || !isObject(stage2) || !isObject(lineage)) {
    return null;
  }

  const stageRetryCount = readNumber(reliability, "stageRetryCount");
  const expiredActiveLeaseCount = readNumber(reliability, "expiredActiveLeaseCount");
  const diagnosisSuccessRate = readMetricValue(reliability.diagnosisSuccessRate);
  const leaseRenewalFailureCount = readMetricValue(reliability.leaseRenewalFailureCount);
  const leaseRecoveryCount = readMetricValue(reliability.leaseRecoveryCount);
  const staleCommitRejectedCount = readMetricValue(reliability.staleCommitRejectedCount);
  const errorRate = readMetricValue(provider.errorRate);
  const rateLimitCount = readNumber(provider, "rateLimitCount");
  const timeoutCount = readNumber(provider, "timeoutCount");
  const tokensPerPain = readMetricValue(tokens.tokensPerPain);
  const pendingDepth = readMetricValue(stage2.pendingDepth);
  const recentExecutions = lineage.recentExecutions;
  if (
    stageRetryCount === null || expiredActiveLeaseCount === null || diagnosisSuccessRate === null
    || leaseRenewalFailureCount === null || leaseRecoveryCount === null || staleCommitRejectedCount === null
    || errorRate === null || rateLimitCount === null || timeoutCount === null
    || tokensPerPain === null || pendingDepth === null || !Array.isArray(recentExecutions)
  ) {
    return null;
  }

  return {
    windowHours,
    queue: {
      painQueueDepth,
      readyQueueDepth,
      retryQueueDepth,
      leasedCount,
      oldestPendingAgeMs: readNumber(queue, "oldestPendingAgeMs"),
    },
    stages: { a: stageA, b: stageB, c: stageC },
    queueWait,
    reliability: {
      stageRetryCount,
      expiredActiveLeaseCount,
      diagnosisSuccessRate,
      leaseRenewalFailureCount,
      leaseRecoveryCount,
      staleCommitRejectedCount,
    },
    provider: { errorRate, rateLimitCount, timeoutCount },
    tokens: { tokensPerPain },
    stage2: { pendingDepth },
    lineage: {
      available: Object.hasOwn(lineage, "available") ? lineage.available === true : false,
      reason: readNullableString(lineage, "reason"),
      count: recentExecutions.length,
    },
  };
}

function statusToVariant(status: string): "default" | "destructive" | "amber" {
  if (status === "failed") return "destructive";
  if (status === "needs_human_review") return "amber";
  return "default";
}

/** B1-03: task status is a snake_case enum in the API; the list shows words. */
const TASK_STATUS_KEYS: Record<string, string> = {
  failed: "pages.failedTasks.taskStatus.failed",
  needs_human_review: "pages.failedTasks.taskStatus.needsHumanReview",
  pending: "pages.failedTasks.taskStatus.pending",
  running: "pages.failedTasks.taskStatus.running",
  succeeded: "pages.failedTasks.taskStatus.succeeded",
  cancelled: "pages.failedTasks.taskStatus.cancelled",
};

function taskStatusLabel(status: string, t: (key: string) => string): string {
  const key = TASK_STATUS_KEYS[status];
  return key ? t(key) : t("pages.failedTasks.taskStatus.unknown");
}

/** A failed task whose retry budget is spent — only a force recovery can requeue it. */
function isAttemptBudgetExhausted(task: FailedTask): boolean {
  return task.status === "failed" && task.attemptCount >= task.maxAttempts;
}

const TASK_KIND_KEYS: Record<string, string> = {
  diagnostician: "pages.failedTasks.taskKinds.diagnostician",
  diag_router: "pages.failedTasks.taskKinds.diagRouter",
  diag_rootcause: "pages.failedTasks.taskKinds.diagRootcause",
  dreamer: "pages.failedTasks.taskKinds.dreamer",
  philosopher: "pages.failedTasks.taskKinds.philosopher",
  scribe: "pages.failedTasks.taskKinds.scribe",
  artificer: "pages.failedTasks.taskKinds.artificer",
  legacy_manual_source: "pages.failedTasks.taskKinds.legacyManual",
};

/** B4-03: the row never shows a raw enum. Unknown kinds say so in Chinese. */
function taskKindLabel(kind: string, t: (key: string) => string): string {
  const key = TASK_KIND_KEYS[kind];
  return key ? t(key) : t("pages.failedTasks.taskKinds.other");
}

/** One readable sentence for the row; the full error stays in the detail. */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  const match = /^[\s\S]*?[。！？.!?\n]/.exec(trimmed);
  return (match ? match[0] : trimmed).trim();
}

function groupTasksByKind(tasks: FailedTask[]): Map<string, FailedTask[]> {
  const grouped = new Map<string, FailedTask[]>();
  for (const task of tasks) {
    const existing = grouped.get(task.taskKind) ?? [];
    existing.push(task);
    grouped.set(task.taskKind, existing);
  }
  return grouped;
}

// ── Component ────────────────────────────────────────────────────────────────

const FAILED_TASKS_PAGE_SIZE = 20;

export function FailedTasksPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // ?taskId= deep link (治理焦点「查看恢复详情」直达): initial value only —
  // the row auto-expands once; the Owner can still collapse/switch freely.
  const deepLinkTaskId = searchParams.get("taskId") ?? undefined;
  // B4-03: paging lives in the URL (?page=) and is read from the same server
  // contract that already accepts limit/offset — no new endpoint.
  const parsedPage = Number.parseInt(searchParams.get("page") ?? "1", 10);
  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const [state, setState] = useState<PageState>({ status: "loading" });
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  // SPEC-PD-PIPELINE... §3.4: quantitative pipeline metrics are a separate
  // read model — a failures-list failure must not blank the health numbers.
  const [metricsState, setMetricsState] = useState<
    { status: "loading" } | { status: "loaded"; metrics: PipelineMetricsView } | { status: "error"; error: string }
  >({ status: "loading" });

  // Governance Recovery Actions v1 — flag-gated recovery UI (fail-closed:
  // absent/false → no recovery entry, Console stays read-only).
  const [recoveryEnabled, setRecoveryEnabled] = useState(false);
  const [recoverTarget, setRecoverTarget] = useState<FailedTask | null>(null);
  const [recoverLoading, setRecoverLoading] = useState(false);
  // Exhausted targets recover with force: the dialog warns first and the
  // action button becomes 强制恢复 (server refuses force=false for these).
  const recoverExhausted = recoverTarget !== null && isAttemptBudgetExhausted(recoverTarget);
  let recoverConfirmLabel = t("pages.failedTasks.recoverConfirmButton");
  if (recoverLoading) {
    recoverConfirmLabel = t("common.loading");
  } else if (recoverExhausted) {
    recoverConfirmLabel = t("pages.failedTasks.recoverConfirmForceButton");
  }

  useEffect(() => {
    let cancelled = false;
    fetchConfigSummary()
      .then((result) => {
        if (cancelled) return;
        // Fail-closed: only an explicitly enabled flag shows the action
        if (result.success && result.data) {
          const flag = result.data.features.find((f) => f.id === "failed_task_recovery_console");
          setRecoveryEnabled(flag?.enabled === true);
        }
      })
      .catch(() => {
        // rc-9: flag probe failure keeps recovery hidden (fail-closed)
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadData = useCallback(async () => {
    setState({ status: "loading" });
    // Shared request(): same auth header and global 401 session-expiry
    // handling as every other page (PRI-643 — a manual fetch here bypassed
    // session-expiry routing entirely).
    const offset = (page - 1) * FAILED_TASKS_PAGE_SIZE;
    const result = await request(
      `/api/failed-tasks?limit=${FAILED_TASKS_PAGE_SIZE}&offset=${offset}`,
      undefined,
      validateFailedTasksData,
    );
    if (result.success) {
      setLoadedAt(new Date());
      setState({ status: "loaded", data: result.data });
      return;
    }
    // 403 = feature flag disabled — show disabled state (rc-9: surface reason)
    if (result.status === 403) {
      setState({ status: "disabled" });
      return;
    }
    setState({ status: "error", message: result.error, nextAction: result.nextAction });
  }, [page]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const loadMetrics = useCallback(async () => {
    setMetricsState({ status: "loading" });
    const result = await request("/api/pipeline-health", undefined, validatePipelineMetricsData);
    if (result.success) {
      setMetricsState({ status: "loaded", metrics: result.data });
      return;
    }
    setMetricsState({ status: "error", error: result.error });
  }, []);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  const handleCreateDraft = (task: FailedTask) => {
    const params = new URLSearchParams({
      source: "failed_tasks_page",
      taskId: task.taskId,
    });
    if (task.painId) {
      params.set("painId", task.painId);
    }
    navigate(`/report-problem?${params.toString()}`);
  };

  // Owner-confirmed recovery (SPEC §6.3: explicit confirmation only — this
  // handler runs exclusively from the dialog's action button, never on load).
  const handleRecoverConfirmed = async () => {
    if (!recoverTarget || recoverLoading) return;
    setRecoverLoading(true);
    try {
      const result = await recoverFailedTask(recoverTarget.taskId, undefined, recoverExhausted);
      if (result.success) {
        toast.success(t("pages.failedTasks.recoverSuccess"));
        setRecoverTarget(null);
        await loadData();
      } else {
        // rc-9: server-provided reason + next action accompany the failure
        const detail = result.nextAction
          ? `${result.error} — ${result.nextAction}`
          : result.error;
        toast.error(`${t("pages.failedTasks.recoverFailed")}: ${detail}`);
      }
    } catch (err) {
      toast.error(`${t("pages.failedTasks.recoverFailed")}: ${err instanceof Error ? err.message : "Network error"}`);
    } finally {
      setRecoverLoading(false);
    }
  };

  return (
    <PageShell width="table">
      {/* Page header */}
      <div className="mb-8">
        <div className="flex items-baseline justify-between gap-3">
          <div className="font-mono text-eyebrow uppercase tracking-[0.14em] text-ink-3">
            {t("pages.failedTasks.title")}
          </div>
          <FreshnessStamp at={loadedAt} />
        </div>
        <h1 className="text-display font-semibold tracking-tight text-ink mt-3 mb-2">
          {t("pages.failedTasks.title")}
        </h1>
        <p className="text-ink-3 text-sm leading-relaxed max-w-[712px]">
          {t("pages.failedTasks.subtitle")}
        </p>
      </div>

      {/* Content area */}
      {metricsState.status !== "loading" && (
        <PipelineMetricsCard
          {...(metricsState.status === "loaded" ? { metrics: metricsState.metrics } : {})}
          {...(metricsState.status === "error" ? { error: metricsState.error } : {})}
          onRetry={() => { void loadMetrics(); }}
          t={t}
        />
      )}

      {state.status === "loading" && (
        <PageLoading cardCount={3} label={t("common.loading")} />
      )}

      {state.status === "disabled" && (
        <div className="py-8">
          <StatePanel
            kind="empty"
            title={t("pages.failedTasks.disabled")}
            action={{ label: t("common.refresh"), onClick: () => { void loadData(); } }}
            testId="failed-tasks-disabled-state"
          />
        </div>
      )}

      {state.status === "error" && (() => {
        const ownerError = describeApiError(state.message, state.nextAction);
        return (
          <div className="py-8">
            <StatePanel
              kind="unreachable"
              title={t("pages.failedTasks.error")}
              body={[ownerError.text, ownerError.nextAction].filter(Boolean).join(" ")}
              technical={ownerError.technical ?? undefined}
              action={{ label: t("common.retry"), onClick: () => { void loadData(); } }}
              testId="failed-tasks-error-state"
            />
          </div>
        );
      })()}

      {state.status === "loaded" && (() => {
        const totalPages = Math.max(1, Math.ceil(state.data.total / FAILED_TASKS_PAGE_SIZE));
        const goToPage = (next: number) => {
          const params = new URLSearchParams(searchParams);
          if (next <= 1) params.delete("page");
          else params.set("page", String(next));
          setSearchParams(params, { replace: true });
        };
        return (
          <div>
            <LoadedContent
              key={page}
              data={state.data}
              onCreateDraft={handleCreateDraft}
              onRecover={recoveryEnabled ? (task) => setRecoverTarget(task) : undefined}
              initialExpandedTaskId={deepLinkTaskId}
              t={t}
            />
            {totalPages > 1 && (
              <nav className="mt-6 flex items-center justify-between gap-4 border-t border-line pt-4" aria-label={t("pages.failedTasks.paginationLabel")}>
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                  className="text-body text-gov underline underline-offset-4 disabled:text-ink-4 disabled:no-underline"
                >
                  {t("pages.failedTasks.previousPage")}
                </button>
                <span className="text-caption text-ink-4 tabular-nums">
                  {t("pages.failedTasks.pageOf", { page, pages: totalPages })}
                </span>
                <button
                  type="button"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                  className="text-body text-gov underline underline-offset-4 disabled:text-ink-4 disabled:no-underline"
                >
                  {t("pages.failedTasks.nextPage")}
                </button>
              </nav>
            )}
          </div>
        );
      })()}

      {/* Recovery confirmation dialog (SPEC §8) — opens only from the row's
          explicit button click; nothing here triggers on page load. */}
      <AlertDialog
        open={recoverTarget !== null}
        onOpenChange={(open) => {
          if (!open && !recoverLoading) {
            setRecoverTarget(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("pages.failedTasks.recoverConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-body leading-relaxed">
                <div>
                  <span className="font-medium">{t("pages.failedTasks.recoverConfirmStatus")}:</span>{" "}
                  <span className="font-mono">{recoverTarget?.status ?? "—"}</span>
                </div>
                {recoverExhausted && (
                  <>
                    <div>
                      <span className="font-medium">{t("pages.failedTasks.recoverConfirmAttempts")}:</span>{" "}
                      <span className="font-mono">
                        {recoverTarget?.attemptCount} / {recoverTarget?.maxAttempts}
                      </span>
                    </div>
                    <div className="text-danger">
                      {t("pages.failedTasks.recoverExhaustedWarning", {
                        attempt: recoverTarget?.attemptCount ?? 0,
                        max: recoverTarget?.maxAttempts ?? 0,
                      })}
                    </div>
                  </>
                )}
                <div>
                  <span className="font-medium">{t("pages.failedTasks.recoverConfirmActionLabel")}:</span>{" "}
                  {t("pages.failedTasks.recoverConfirmActionDesc")}
                </div>
                <div>
                  <span className="font-medium">{t("pages.failedTasks.recoverConfirmImpactLabel")}:</span>{" "}
                  {recoverExhausted
                    ? t("pages.failedTasks.recoverConfirmForceImpactDesc")
                    : t("pages.failedTasks.recoverConfirmImpactDesc")}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={recoverLoading}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={recoverLoading}
              onClick={(event) => {
                // Prevent Radix from auto-closing before the async POST
                // resolves; handleRecoverConfirmed closes on success.
                event.preventDefault();
                void handleRecoverConfirmed();
              }}
            >
              {recoverConfirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageShell>
  );
}

// ── Loaded content ───────────────────────────────────────────────────────────

interface LoadedContentProps {
  data: FailedTasksData;
  onCreateDraft: (task: FailedTask) => void;
  /** Present only when failed_task_recovery_console is enabled (undefined = hidden) */
  onRecover?: (task: FailedTask) => void;
  /** ?taskId= deep link: auto-expand this task's row once data is loaded. */
  initialExpandedTaskId?: string;
  t: (key: string) => string;
}

/** PRI-955 (F11): derived learning-queue health block — never claims health
 *  from the failed-task count alone. Facts come from the server projection. */
function PipelineHealthCard({ pipeline, t }: { pipeline: PipelineHealthInfo; t: (key: string) => string }) {
  const statusLabel =
    pipeline.status === "healthy" ? t("pages.failedTasks.pipeline.statusHealthy")
    : pipeline.status === "backlogged" ? t("pages.failedTasks.pipeline.statusBacklogged")
    : pipeline.status === "stalled" ? t("pages.failedTasks.pipeline.statusStalled")
    : t("pages.failedTasks.pipeline.statusUnknown");
  const variant =
    pipeline.status === "healthy" ? "default"
    : pipeline.status === "stalled" ? "destructive"
    : pipeline.status === "backlogged" ? "amber"
    : "default";
  return (
    <div className="p-5 bg-panel border border-line rounded-[var(--radius-md)] mb-4">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-reading font-semibold text-ink">{t("pages.failedTasks.pipeline.title")}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full border ${
          variant === "destructive" ? "border-red-300 text-red-700 bg-red-50"
          : variant === "amber" ? "border-amber-300 text-amber-700 bg-amber-50"
          : "border-line text-ink-3 bg-canvas"
        }`}>{statusLabel}</span>
      </div>
      <p className="text-ink-3 text-sm leading-relaxed">{pipeline.note}</p>
      {pipeline.nextAction && (
        <p className="text-ink-3 text-sm leading-relaxed mt-1">{t("pages.failedTasks.pipeline.nextActionPrefix")}{pipeline.nextAction}</p>
      )}
    </div>
  );
}

// ── Pipeline metrics card (SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001) ──

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function metricText(metric: MetricValueView, format: (value: number) => string, unavailableLabel: string): string {
  if (!metric.available || metric.value === null) {
    return `${unavailableLabel}: ${metric.reason ?? "—"}`;
  }
  return format(metric.value);
}

function MetricCell({ label, value, unavailable }: { label: string; value: string; unavailable: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-caption text-ink-4">{label}</span>
      <span className={`text-sm tabular-nums ${unavailable ? "text-amber-700" : "text-ink"}`}>{value}</span>
    </div>
  );
}

function StageCell({ label, stage, t }: { label: string; stage: StageMetricsView; t: (key: string) => string }) {
  const unavailable = stage.sampleCount === 0;
  return (
    <div className="border border-line rounded-[var(--radius-sm)] p-3">
      <div className="text-sm font-medium text-ink mb-1">{label}</div>
      <div className="text-caption text-ink-3 tabular-nums">
        {t("pages.failedTasks.metrics.samples")}: {stage.sampleCount} · {t("pages.failedTasks.metrics.success")}: {stage.successCount} · {t("pages.failedTasks.metrics.failure")}: {stage.failureCount}
      </div>
      <div className="text-caption text-ink-3 tabular-nums">
        {t("pages.failedTasks.metrics.p50")}: {formatDuration(stage.duration.p50Ms)} · {t("pages.failedTasks.metrics.p95")}: {formatDuration(stage.duration.p95Ms)}
        {unavailable && <span className="text-amber-700"> · {t("pages.failedTasks.metrics.noSamples")}</span>}
      </div>
    </div>
  );
}

function PipelineMetricsCard({
  metrics,
  error,
  onRetry,
  t,
}: {
  metrics?: PipelineMetricsView;
  error?: string;
  onRetry: () => void;
  t: (key: string) => string;
}) {
  const unavailableLabel = t("pages.failedTasks.metrics.unavailable");
  if (!metrics) {
    return (
      <div className="p-5 bg-panel border border-line rounded-[var(--radius-md)] mb-4">
        <div className="text-reading font-semibold text-ink mb-1">{t("pages.failedTasks.metrics.title")}</div>
        <p className="text-sm text-amber-700">{t("pages.failedTasks.metrics.loadFailed")}: {error ?? "—"}</p>
        <button type="button" onClick={onRetry} className="text-sm text-gov underline underline-offset-4 mt-2">
          {t("common.retry")}
        </button>
      </div>
    );
  }
  const { queue, stages, reliability, provider, tokens, stage2, queueWait, lineage } = metrics;
  return (
    <div className="p-5 bg-panel border border-line rounded-[var(--radius-md)] mb-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <span className="text-reading font-semibold text-ink">{t("pages.failedTasks.metrics.title")}</span>
        <span className="text-caption text-ink-4">
          {t("pages.failedTasks.metrics.windowHours")}: {metrics.windowHours}
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
        <MetricCell label={t("pages.failedTasks.metrics.queuePain")} value={String(queue.painQueueDepth)} unavailable={false} />
        <MetricCell label={t("pages.failedTasks.metrics.queueReady")} value={String(queue.readyQueueDepth)} unavailable={false} />
        <MetricCell label={t("pages.failedTasks.metrics.queueRetry")} value={String(queue.retryQueueDepth)} unavailable={false} />
        <MetricCell label={t("pages.failedTasks.metrics.queueLeased")} value={String(queue.leasedCount)} unavailable={false} />
        <MetricCell
          label={t("pages.failedTasks.metrics.oldestPending")}
          value={queue.oldestPendingAgeMs === null ? "—" : formatDuration(queue.oldestPendingAgeMs)}
          unavailable={queue.oldestPendingAgeMs === null}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <StageCell label={t("pages.failedTasks.metrics.stageA")} stage={stages.a} t={t} />
        <StageCell label={t("pages.failedTasks.metrics.stageB")} stage={stages.b} t={t} />
        <StageCell label={t("pages.failedTasks.metrics.stageC")} stage={stages.c} t={t} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <MetricCell
          label={t("pages.failedTasks.metrics.queueWaitP95")}
          value={queueWait.sampleCount === 0 ? `${unavailableLabel}: ${t("pages.failedTasks.metrics.noSamples")}` : formatDuration(queueWait.p95Ms)}
          unavailable={queueWait.sampleCount === 0}
        />
        <MetricCell label={t("pages.failedTasks.metrics.retries")} value={String(reliability.stageRetryCount)} unavailable={false} />
        <MetricCell label={t("pages.failedTasks.metrics.expiredLeases")} value={String(reliability.expiredActiveLeaseCount)} unavailable={false} />
        <MetricCell
          label={t("pages.failedTasks.metrics.diagnosisSuccessRate")}
          value={metricText(reliability.diagnosisSuccessRate, formatPercent, unavailableLabel)}
          unavailable={!reliability.diagnosisSuccessRate.available}
        />
        <MetricCell
          label={t("pages.failedTasks.metrics.leaseRenewalFailures")}
          value={metricText(reliability.leaseRenewalFailureCount, String, unavailableLabel)}
          unavailable={!reliability.leaseRenewalFailureCount.available}
        />
        <MetricCell
          label={t("pages.failedTasks.metrics.leaseRecoveries")}
          value={metricText(reliability.leaseRecoveryCount, String, unavailableLabel)}
          unavailable={!reliability.leaseRecoveryCount.available}
        />
        <MetricCell
          label={t("pages.failedTasks.metrics.staleCommits")}
          value={metricText(reliability.staleCommitRejectedCount, String, unavailableLabel)}
          unavailable={!reliability.staleCommitRejectedCount.available}
        />
        <MetricCell
          label={t("pages.failedTasks.metrics.providerErrorRate")}
          value={metricText(provider.errorRate, formatPercent, unavailableLabel)}
          unavailable={!provider.errorRate.available}
        />
        <MetricCell label={t("pages.failedTasks.metrics.rateLimit")} value={String(provider.rateLimitCount)} unavailable={false} />
        <MetricCell label={t("pages.failedTasks.metrics.timeout")} value={String(provider.timeoutCount)} unavailable={false} />
        <MetricCell
          label={t("pages.failedTasks.metrics.tokensPerPain")}
          value={metricText(tokens.tokensPerPain, (v) => v.toFixed(0), unavailableLabel)}
          unavailable={!tokens.tokensPerPain.available}
        />
        <MetricCell
          label={t("pages.failedTasks.metrics.stage2Pending")}
          value={metricText(stage2.pendingDepth, String, unavailableLabel)}
          unavailable={!stage2.pendingDepth.available}
        />
      </div>

      <p className="text-caption text-ink-4 mt-3">
        {lineage.available
          ? `${t("pages.failedTasks.metrics.lineageRecent")}: ${lineage.count}`
          : `${t("pages.failedTasks.metrics.lineageRecent")}: 0 — ${lineage.reason ?? "—"}`}
      </p>
    </div>
  );
}

function LoadedContent({ data, onCreateDraft, onRecover, initialExpandedTaskId, t }: LoadedContentProps) {  const hasTasks = data.tasks.length > 0;

  // Empty state — surface nextAction from the API (rc-9: no silent fallback).
  // PRI-955: the empty copy no longer claims the pipeline is healthy; the
  // derived queue-health block carries that judgment with facts.
  if (!hasTasks) {
    return (
      <div className="py-8">
        <div className="p-5 bg-panel border border-line rounded-[var(--radius-md)]">
          <h3 className="text-subtitle font-semibold text-ink mb-2">
            {t("pages.failedTasks.empty")}
          </h3>
          {data.nextAction && (
            <p className="text-ink-3 text-sm leading-relaxed">{data.nextAction}</p>
          )}
        </div>
        {data.pipeline && <PipelineHealthCard pipeline={data.pipeline} t={t} />}
      </div>
    );
  }

  const grouped = groupTasksByKind(data.tasks);
  const sortedKinds = Array.from(grouped.keys()).sort();

  return (
    <>
      {data.pipeline && <PipelineHealthCard pipeline={data.pipeline} t={t} />}
      <div className="space-y-6">
        {sortedKinds.map((kind) => {
          const tasks = grouped.get(kind);
          if (!tasks || tasks.length === 0) return null;
          return (
            <Card key={kind}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{t("pages.failedTasks.kind")}</Badge>
                  <CardTitle className="text-reading">
                    {taskKindLabel(kind, t)} ({tasks.length})
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <TaskTable
                  tasks={tasks}
                  onCreateDraft={onCreateDraft}
                  onRecover={onRecover}
                  initialExpandedTaskId={initialExpandedTaskId}
                  t={t}
                />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* B4-03: paging is a control, not a CLI hint. */}
      <div className="mt-6 text-caption text-ink-4">
        {t("common.total")}: {data.total}
      </div>
    </>
  );
}

// ── Task table (per group) ───────────────────────────────────────────────────

interface TaskTableProps {
  tasks: FailedTask[];
  onCreateDraft: (task: FailedTask) => void;
  /** Present only when failed_task_recovery_console is enabled (undefined = hidden) */
  onRecover?: (task: FailedTask) => void;
  /** ?taskId= deep link — only honoured by the table that holds the task. */
  initialExpandedTaskId?: string;
  t: (key: string) => string;
}

function TaskTable({ tasks, onCreateDraft, onRecover, initialExpandedTaskId, t }: TaskTableProps) {
  // PRI-747 F22: one row at a time is expanded into its detail panel.
  // ?taskId= deep link seeds the initial expansion (only when this table
  // actually contains the task); after mount it behaves like a normal toggle.
  const deepLinkTask = initialExpandedTaskId !== undefined
    ? tasks.find((task) => task.taskId === initialExpandedTaskId)
    : undefined;
  const [expandedId, setExpandedId] = useState<string | null>(deepLinkTask?.taskId ?? null);
  const [detail, setDetail] = useState<TaskDetailState>({ status: "idle" });
  // Drop responses from a superseded expand/collapse (rc-7: only the newest
  // request's result may become current state).
  const detailRequestIdRef = useRef(0);
  const deepLinkFetchedRef = useRef(false);

  // Fetch (or refetch) one task's detail; a stale response from a superseded
  // request is dropped (rc-7: only the newest request's result may land).
  const requestDetail = useCallback(async (taskId: string) => {
    const requestId = ++detailRequestIdRef.current;
    setDetail({ status: "loading", taskId });
    // Lazy fetch on expand: the list view stays cheap; the run history is
    // only loaded when the Owner actually asks for this task's detail.
    const result = await fetchFailedTaskDetail(taskId);
    if (requestId !== detailRequestIdRef.current) return;
    if (result.success) {
      setDetail({ status: "loaded", taskId, data: result.data });
    } else {
      // rc-9: surface the server-provided reason + next action (404 = the
      // task recovered/changed state after the list was loaded).
      setDetail({ status: "error", taskId, message: result.error, nextAction: result.nextAction });
    }
  }, []);

  // Deep link (?taskId=): fetch the linked task's detail and scroll its row
  // into view once. The table mounts only after the task list has loaded, so
  // the row is present at first effect run. The URL param is untrusted
  // (rc-1): CSS.escape (unquoted attribute selector) keeps a crafted id from
  // breaking the selector.
  useEffect(() => {
    if (deepLinkTask === undefined || deepLinkFetchedRef.current) return;
    deepLinkFetchedRef.current = true;
    void requestDetail(deepLinkTask.taskId);
    const row = document.querySelector(
      `[data-testid=${CSS.escape(`detail-toggle-${deepLinkTask.taskId}`)}]`,
    );
    row?.scrollIntoView({ block: "center" });
  }, [deepLinkTask, requestDetail]);

  const toggleDetail = useCallback((taskId: string) => {
    if (expandedId === taskId) {
      // Invalidate any in-flight response, then collapse.
      detailRequestIdRef.current += 1;
      setExpandedId(null);
      setDetail({ status: "idle" });
      return;
    }
    setExpandedId(taskId);
    void requestDetail(taskId);
  }, [expandedId, requestDetail]);

  return (
    <div className="space-y-2">
      {/* B4-03: one row = what happened + the reason's first sentence + one
          action. Every identifier lives in the expanded technical details. */}
      <div className="hidden grid-cols-[auto_minmax(0,5fr)_minmax(0,4fr)_auto] gap-3 pb-2 border-b border-line font-mono text-caption uppercase tracking-[0.08em] text-ink-4 md:grid">
        <span aria-hidden="true" />
        <span>{t("pages.failedTasks.whatHappened")}</span>
        <span>{t("pages.failedTasks.reason")}</span>
        <span className="text-right">{t("pages.failedTasks.action")}</span>
      </div>

      {/* Rows */}
      {tasks.map((task) => {
        const isExpanded = expandedId === task.taskId;
        return (
          <Fragment key={task.taskId}>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-1 py-3 items-start text-body border-b border-line/50 last:border-b-0 md:grid-cols-[auto_minmax(0,5fr)_minmax(0,4fr)_auto] md:items-center md:gap-3 md:py-2">
              <Button
                variant="quiet"
                size="icon"
                className="h-6 w-6 shrink-0 text-[12px]"
                onClick={() => toggleDetail(task.taskId)}
                aria-label={t("pages.failedTasks.detailToggle")}
                aria-expanded={isExpanded}
                data-testid={`detail-toggle-${task.taskId}`}
              >
                {isExpanded ? "▾" : "▸"}
              </Button>
              <div className="flex min-w-0 items-baseline gap-2 md:block">
                <FieldLabel>{t("pages.failedTasks.whatHappened")}</FieldLabel>
                <span className="min-w-0 truncate text-ink-2" data-testid={`task-kind-${task.taskId}`}>
                  {taskKindLabel(task.taskKind, t)}
                </span>
                <span className="ml-2 text-[12px] text-ink-4 tabular-nums">
                  {task.createdAt ? formatDateTime(task.createdAt) : "—"}
                </span>
              </div>
              <div className="col-span-2 flex min-w-0 items-baseline gap-2 md:col-span-1 md:block">
                <FieldLabel>{t("pages.failedTasks.reason")}</FieldLabel>
                <span className="min-w-0 break-words text-ink-3 md:truncate" title={task.lastError ?? ""}>
                  {task.lastError ? firstSentence(humanizeRuntimeText(task.lastError).text) : "—"}
                </span>
              </div>
              <div className="col-span-2 flex flex-wrap items-center gap-3 md:col-span-1 md:justify-end">
                {task.ownerDecisionRequired === true ? (
                  <a href="#/workbench" className="text-gov underline underline-offset-2 hover:text-gov/80" data-testid={`go-focus-${task.taskId}`}>
                    {t("pages.failedTasks.goGovernanceFocus")}
                  </a>
                ) : onRecover ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onRecover(task)}
                    className="whitespace-nowrap"
                  >
                    {t("pages.failedTasks.recover")}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onCreateDraft(task)}
                    className="whitespace-nowrap"
                  >
                    {t("pages.failedTasks.createDraft")}
                  </Button>
                )}
              </div>
            </div>
            {isExpanded && (
              <div className="border border-line/60 rounded-[var(--radius-md)] bg-panel/60 p-4 mb-2" data-testid={`detail-panel-${task.taskId}`}>
                <TaskDetailPanel
                  state={detail.status === "idle" ? { status: "loading", taskId: task.taskId } : detail}
                  taskId={task.taskId}
                  onRetry={requestDetail}
                  t={t}
                />
                <div className="mt-3 flex flex-wrap items-center gap-4 text-caption">
                  {task.ownerDecisionRequired !== true && onRecover !== undefined && (
                    <button type="button" onClick={() => onCreateDraft(task)} className="text-gov underline underline-offset-4">
                      {t("pages.failedTasks.createDraft")}
                    </button>
                  )}
                  <details className="w-full" data-testid={`task-technical-${task.taskId}`}>
                    <summary className="cursor-pointer text-ink-4">{t("pages.failedTasks.technicalDetails")}</summary>
                    <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-caption text-ink-4">
                      <dt>{t("pages.failedTasks.taskId")}</dt><dd className="break-all">{task.taskId}</dd>
                      <dt>{t("pages.failedTasks.painId")}</dt><dd className="break-all">{task.painId ?? t("pages.failedTasks.noPainId")}</dd>
                      <dt>{t("pages.failedTasks.status")}</dt><dd>{taskStatusLabel(task.status, t)}</dd>
                      <dt>{t("pages.failedTasks.attempts")}</dt><dd>{task.attemptCount} / {task.maxAttempts}</dd>
                      <dt>{t("pages.failedTasks.lastAttempt")}</dt><dd>{task.lastAttemptAt ? formatDateTime(task.lastAttemptAt) : "—"}</dd>
                      <dt>{t("pages.failedTasks.createdAt")}</dt><dd>{task.createdAt ? formatDateTime(task.createdAt) : "—"}</dd>
                    </dl>
                  </details>
                </div>
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

// ── Task detail panel (PRI-747 F22) ─────────────────────────────────────────

type TaskDetailState =
  | { status: "idle" }
  | { status: "loading"; taskId: string }
  | { status: "loaded"; taskId: string; data: FailedTaskDetailData }
  | { status: "error"; taskId: string; message: string; nextAction?: string };

interface TaskDetailPanelProps {
  state: TaskDetailState;
  taskId: string;
  onRetry: (taskId: string) => void;
  t: (key: string) => string;
}

/**
 * P1-3: the failure diagnosis block. Every value is projected from the detail
 * payload; the retry line reports the ATTEMPT BUDGET, not a guess about
 * whether the runner would retry this error category.
 */
function FailureSummaryPanel({ data, t }: { data: FailedTaskDetailData; t: (key: string) => string }) {
  const summary = deriveFailureSummary(data);
  const nextAction = t(`pages.failedTasks.failureNextAction.${summary.nextActionCode}`);
  return (
    <div
      className="p-3 border border-line/60 rounded-[var(--radius-md)] bg-canvas/60"
      data-testid="failure-summary"
    >
      <div className="font-mono text-caption uppercase tracking-[0.08em] text-ink-4 mb-2">
        {t("pages.failedTasks.failureSummaryTitle")}
      </div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[12px]">
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureStage")}</span>
        <span className="font-mono text-ink-2" data-testid="failure-stage">{summary.stage}</span>

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureErrorType")}</span>
        <span className="font-mono text-ink-2" data-testid="failure-error-type">
          {summary.errorCategory ?? "—"}
        </span>

        {/* P1-4: structured reason and the concrete cause, never a generic
            "execution failed" line. */}
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureReasonCode")}</span>
        <span className="font-mono text-ink-2" data-testid="failure-reason-code">{summary.reasonCode ?? "—"}</span>

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureConcreteReason")}</span>
        <span className={summary.concreteReason ? "text-danger break-words" : "text-ink-3"} data-testid="failure-concrete-reason">
          {summary.concreteReason ?? "—"}
        </span>

        {summary.missingFields.length > 0 && (
          <>
            <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureMissingFields")}</span>
            <span className="font-mono break-words text-amber" data-testid="failure-missing-fields">
              {summary.missingFields.join(", ")}
            </span>
          </>
        )}

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureOwnerAction")}</span>
        <span className="font-mono text-ink-2" data-testid="failure-owner-action">
          {summary.ownerActionRequired ? t("common.yes") : t("common.no")}
        </span>

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureAutoRetry")}</span>
        <span className="font-mono text-ink-2" data-testid="failure-auto-retry">
          {summary.autoRetryAllowed ? t("common.yes") : t("common.no")}
        </span>

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureSafetyBoundary")}</span>
        <span className="text-ink-3 break-words" data-testid="failure-safety-boundary">{summary.safetyBoundary}</span>

        {summary.evidenceSummary.length > 0 && (
          <>
            <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureEvidence")}</span>
            <ul className="font-mono break-words text-ink-3 space-y-0.5" data-testid="failure-evidence">
              {summary.evidenceSummary.map((line, index) => (
                <li key={`${index}-${line.slice(0, 24)}`}>{line}</li>
              ))}
            </ul>
          </>
        )}

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureLatestError")}</span>
        <span className={summary.latestError ? "text-danger" : "text-ink-3"} data-testid="failure-latest-error">
          {summary.latestError ?? "—"}
        </span>

        {summary.latestValidatorError && (
          <>
            <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureLatestValidatorError")}</span>
            <span className="font-mono break-words text-amber" data-testid="failure-latest-validator-error">
              {summary.latestValidatorError}
            </span>
          </>
        )}

        {/* P1-3: the terminal mechanism is SUPPLEMENTARY — it explains why
            execution stopped, never replaces the classified error type above. */}
        {summary.terminalReason && (
          <>
            <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureTerminalReason")}</span>
            <span className="font-mono text-ink-3" data-testid="failure-terminal-reason">
              {summary.terminalReason}
            </span>
          </>
        )}

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureAttempts")}</span>
        <span className="font-mono text-ink-2" data-testid="failure-attempts">
          {summary.attemptCount} / {summary.maxAttempts}
        </span>

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureRetryLabel")}</span>
        <span
          className={summary.budgetExhausted ? "text-amber" : "text-ink-2"}
          data-testid="failure-retryable"
        >
          {summary.budgetExhausted
            ? t("pages.failedTasks.failureRetryExhausted")
            : t("pages.failedTasks.failureRetryBudget").replace("{remaining}", String(summary.remainingAttempts)).replace("{{remaining}}", String(summary.remainingAttempts))}
        </span>

        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.failureNextActionLabel")}</span>
        <span className="text-ink-3 leading-relaxed" data-testid="failure-next-action">
          {nextAction}
        </span>
      </div>
    </div>
  );
}

function TaskDetailPanel({ state, taskId, onRetry, t }: TaskDetailPanelProps) {
  if (state.status === "loading") {
    return (
      <div className="text-ink-3 text-body" data-testid="detail-loading">
        {t("common.loading")}
      </div>
    );
  }

  if (state.status === "error") {
    // rc-9: reason + next action + an explicit retry affordance
    return (
      <div className="text-body space-y-2" data-testid="detail-error">
        <div className="text-danger">
          {t("pages.failedTasks.detailError")}: {state.message}
        </div>
        {state.nextAction && <div className="text-ink-3">{state.nextAction}</div>}
        <div>
          <Button variant="outline" size="sm" onClick={() => onRetry(taskId)}>
            {t("common.refresh")}
          </Button>
        </div>
      </div>
    );
  }

  // The idle state only occurs if the panel renders for a task whose fetch was
  // superseded mid-flight; treat it as loading for the row just expanded.
  if (state.status === "idle" || state.taskId !== taskId) {
    return (
      <div className="text-ink-3 text-body" data-testid="detail-loading">
        {t("common.loading")}
      </div>
    );
  }

  const { data } = state;

  return (
    <div className="space-y-4 text-body">
      {/* P1-3: five facts the Owner needs to act — failed stage, error type,
          latest error, attempt usage, and whether the retry budget is spent. */}
      <FailureSummaryPanel data={data} t={t} />

      {/* Full task record (the list truncates ids and error category) */}
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 font-mono text-[12px]">
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.taskId")}</span>
        <span className="text-ink-2 break-all">{data.taskId}</span>
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.kind")}</span>
        <span className="text-ink-2">{data.taskKind}</span>
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.status")}</span>
        <span className="text-ink-2">{data.status}</span>
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.createdAt")}</span>
        <span className="text-ink-3">{formatDateTime(data.createdAt)}</span>
        {data.updatedAt && (
          <>
            <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.updatedAt")}</span>
            <span className="text-ink-3">{formatDateTime(data.updatedAt)}</span>
          </>
        )}
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.attempts")}</span>
        <span className="text-ink-2">
          {data.attemptCount} / {data.maxAttempts}
        </span>
        <span className="text-ink-4 uppercase tracking-[0.08em] self-center">{t("pages.failedTasks.lastError")}</span>
        <span className={data.lastError ? "text-danger" : "text-ink-3"}>{data.lastError ?? "—"}</span>
      </div>

      {/* Run history — the per-attempt free-text reason is the part the list
          view cannot show and the reason this endpoint was built. */}
      <div>
        <div className="font-mono text-caption uppercase tracking-[0.08em] text-ink-4 mb-2">
          {t("pages.failedTasks.runsTitle")} ({data.runs.length})
        </div>
        {data.runs.length === 0 ? (
          <div className="text-ink-3">{t("pages.failedTasks.noRuns")}</div>
        ) : (
          <div className="space-y-1">
            <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)] gap-3 pb-1 border-b border-line/50 font-mono text-caption uppercase tracking-[0.08em] text-ink-4">
              <span>{t("pages.failedTasks.runAttempt")}</span>
              <span>{t("pages.failedTasks.status")}</span>
              <span>{t("pages.failedTasks.runStarted")}</span>
              <span>{t("pages.failedTasks.runReason")}</span>
            </div>
            {data.runs.map((run) => (
              <div
                key={run.runId}
                className="grid grid-cols-[auto_auto_minmax(0,1fr)_minmax(0,1fr)] gap-3 py-1 text-[12px] border-b border-line/30 last:border-b-0"
                title={`${t("pages.failedTasks.runEnded")}: ${run.endedAt ? formatDateTime(run.endedAt) : "—"}${run.errorCategory ? ` · ${t("pages.failedTasks.runErrorCategory")}: ${run.errorCategory}` : ""}`}
              >
                <span className="font-mono text-ink-2">#{run.attemptNumber}</span>
                <span className="font-mono text-ink-3">{run.executionStatus}</span>
                <span className="font-mono text-ink-3">{formatDateTime(run.startedAt)}</span>
                <span className="text-ink-3 break-words min-w-0" title={run.reason ?? undefined}>
                  {run.errorCategory && (
                    <span className="font-mono text-[11px] text-amber mr-1" data-testid="run-error-type">
                      [{run.errorCategory}]
                    </span>
                  )}
                  {run.reason ?? (run.errorCategory ? "" : "—")}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
