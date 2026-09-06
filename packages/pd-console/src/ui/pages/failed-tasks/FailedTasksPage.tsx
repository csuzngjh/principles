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
 * /api/v1/failed-tasks/:id/recover. The success state means "Recovery
 * Accepted" — the task is pending again; execution is asynchronous.
 *
 * Runtime Contract (rc-*):
 * - rc-1: API response is treated as `unknown` and validated before use
 * - rc-2: no `as` type assertions — runtime type guards only
 * - rc-5: `Object.hasOwn()` for untrusted object keys
 * - rc-9: every error/disabled path surfaces a reason + next action
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { Badge } from "../../components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Button } from "../../components/ui/button.js";
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
import { ShinyText } from "../../components/ui/shiny-text.js";
import { formatDate } from "../../utils/format.js";
import { recoverFailedTask, fetchConfigSummary, request } from "../../api.js";

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

interface FailedTasksData {
  tasks: FailedTask[];
  total: number;
  nextAction?: string;
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
  return { tasks, total, nextAction: nextAction ?? undefined };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateId(id: string): string {
  return id.length > 12 ? id.slice(0, 12) + "…" : id;
}

function statusToVariant(status: string): "default" | "destructive" | "amber" {
  if (status === "failed") return "destructive";
  if (status === "needs_human_review") return "amber";
  return "default";
}

/** A failed task whose retry budget is spent — only a force recovery can requeue it. */
function isAttemptBudgetExhausted(task: FailedTask): boolean {
  return task.status === "failed" && task.attemptCount >= task.maxAttempts;
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

export function FailedTasksPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [state, setState] = useState<PageState>({ status: "loading" });

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
    const result = await request("/api/v1/failed-tasks", undefined, validateFailedTasksData);
    if (result.success) {
      setState({ status: "loaded", data: result.data });
      return;
    }
    // 403 = feature flag disabled — show disabled state (rc-9: surface reason)
    if (result.status === 403) {
      setState({ status: "disabled" });
      return;
    }
    setState({ status: "error", message: result.error, nextAction: result.nextAction });
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
    <PageShell>
      {/* Page header */}
      <div className="mb-8">
        <div className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-3">
          {t("pages.failedTasks.title")}
        </div>
        <ShinyText
          as="h1"
          className="text-[29px] font-semibold tracking-tight text-ink mt-3 mb-2"
          duration={4.5}
          brightness={0.5}
          disabled={state.status !== "loaded" || state.data.tasks.length === 0}
        >
          {t("pages.failedTasks.title")}
        </ShinyText>
        <p className="text-ink-3 text-sm leading-relaxed max-w-[712px]">
          {t("pages.failedTasks.subtitle")}
        </p>
      </div>

      {/* Content area */}
      {state.status === "loading" && (
        <PageLoading cardCount={3} label={t("common.loading")} />
      )}

      {state.status === "disabled" && (
        <div className="py-8">
          <div className="p-5 bg-panel border border-amber/20 rounded-[var(--radius-md)] text-amber text-[13px] leading-relaxed">
            {t("pages.failedTasks.disabled")}
          </div>
          <div className="mt-4">
            <Button variant="outline" size="sm" onClick={loadData}>
              {t("common.refresh")}
            </Button>
          </div>
        </div>
      )}

      {state.status === "error" && (
        <div className="py-8">
          <div className="text-danger text-sm mb-2">
            {t("pages.failedTasks.error")}: {state.message}
          </div>
          {state.nextAction && (
            <div className="text-ink-3 text-[13px] mb-3">{state.nextAction}</div>
          )}
          <Button variant="outline" size="sm" onClick={loadData}>
            {t("common.refresh")}
          </Button>
        </div>
      )}

      {state.status === "loaded" && (
        <div className="animate-[pdFadeIn_400ms_ease-out]">
          <LoadedContent
            data={state.data}
            onCreateDraft={handleCreateDraft}
            onRecover={recoveryEnabled ? (task) => setRecoverTarget(task) : undefined}
            t={t}
          />
        </div>
      )}

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
              <div className="space-y-2 text-[13px] leading-relaxed">
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
  t: (key: string) => string;
}

function LoadedContent({ data, onCreateDraft, onRecover, t }: LoadedContentProps) {
  const hasTasks = data.tasks.length > 0;

  // Empty state — surface nextAction from the API (rc-9: no silent fallback)
  if (!hasTasks) {
    return (
      <div className="py-8">
        <div className="p-5 bg-panel border border-line rounded-[var(--radius-md)]">
          <h3 className="text-[17px] font-semibold text-ink mb-2">
            {t("pages.failedTasks.empty")}
          </h3>
          {data.nextAction && (
            <p className="text-ink-3 text-sm leading-relaxed">{data.nextAction}</p>
          )}
        </div>
      </div>
    );
  }

  const grouped = groupTasksByKind(data.tasks);
  const sortedKinds = Array.from(grouped.keys()).sort();

  return (
    <>
      <div className="space-y-6">
        {sortedKinds.map((kind) => {
          const tasks = grouped.get(kind);
          if (!tasks || tasks.length === 0) return null;
          return (
            <Card key={kind}>
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{t("pages.failedTasks.kind")}</Badge>
                  <CardTitle className="text-[15px] font-mono">
                    {kind} ({tasks.length})
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <TaskTable tasks={tasks} onCreateDraft={onCreateDraft} onRecover={onRecover} t={t} />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Footer: total count + partial-results hint */}
      <div className="mt-8 font-mono text-[11px] text-ink-4 space-y-1">
        <div>{t("common.total")}: {data.total}</div>
        {data.total > data.tasks.length && (
          <div className="text-amber/80 leading-relaxed">
            {t("pages.failedTasks.partialResults")
              .replace("{shown}", String(data.tasks.length))
              .replace("{total}", String(data.total))}
          </div>
        )}
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
  t: (key: string) => string;
}

function TaskTable({ tasks, onCreateDraft, onRecover, t }: TaskTableProps) {
  return (
    <div className="space-y-2">
      {/* Column headers */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-3 pb-2 border-b border-line font-mono text-[10px] uppercase tracking-[0.08em] text-ink-4">
        <span>{t("pages.failedTasks.taskId")}</span>
        <span>{t("pages.failedTasks.painId")}</span>
        <span>{t("pages.failedTasks.status")}</span>
        <span>{t("pages.failedTasks.lastError")}</span>
        <span>{t("pages.failedTasks.attempts")}</span>
        <span>{t("pages.failedTasks.lastAttempt")}</span>
        <span aria-hidden="true" />
      </div>

      {/* Rows */}
      {tasks.map((task) => (
        <div
          key={task.taskId}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-3 py-2 items-center text-[13px] border-b border-line/50 last:border-b-0"
        >
          <span className="font-mono text-ink-2 truncate" title={task.taskId}>
            {truncateId(task.taskId)}
          </span>
          <span className="font-mono text-ink-3 truncate" title={task.painId ?? ""}>
            {task.painId ? truncateId(task.painId) : t("pages.failedTasks.noPainId")}
          </span>
          <Badge variant={statusToVariant(task.status)}>{task.status}</Badge>
          <span className="text-ink-3 truncate" title={task.lastError ?? ""}>
            {task.lastError ?? "—"}
          </span>
          <span className="font-mono text-ink-2 text-center">{task.attemptCount}</span>
          <span className="font-mono text-ink-3 text-[12px]">
            {task.lastAttemptAt ? formatDate(task.lastAttemptAt) : "—"}
          </span>
          {task.ownerDecisionRequired === true ? (
            <span className="whitespace-nowrap text-[12px]">
              <span className="text-amber">{t("pages.failedTasks.awaitingOwnerDecision")}</span>{" "}
              <a href="#/focus" className="text-gov underline underline-offset-2 hover:text-gov/80" data-testid={`go-focus-${task.taskId}`}>
                {t("pages.failedTasks.goGovernanceFocus")}
              </a>
            </span>
          ) : onRecover ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => onRecover(task)}
              className="whitespace-nowrap"
            >
              {t("pages.failedTasks.recover")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onCreateDraft(task)}
            className="whitespace-nowrap"
          >
            {t("pages.failedTasks.createDraft")}
          </Button>
        </div>
      ))}
    </div>
  );
}
