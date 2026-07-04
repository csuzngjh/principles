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
 * Runtime Contract (rc-*):
 * - rc-1: API response is treated as `unknown` and validated before use
 * - rc-2: no `as` type assertions — runtime type guards only
 * - rc-5: `Object.hasOwn()` for untrusted object keys
 * - rc-9: every error/disabled path surfaces a reason + next action
 */
import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PageShell } from "../../components/layout/page-shell.js";
import { PageLoading } from "../../components/layout/page-loading.js";
import { Badge } from "../../components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Button } from "../../components/ui/button.js";
import { ShinyText } from "../../components/ui/shiny-text.js";
import { formatDate } from "../../utils/format.js";

// ── Types ────────────────────────────────────────────────────────────────────

interface FailedTask {
  taskId: string;
  taskKind: string;
  painId: string | null;
  status: string;
  lastError: string | null;
  attemptCount: number;
  createdAt: string;
  lastAttemptAt: string | null;
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
  const createdAt = readString(v, "createdAt");
  // Required fields — fail loud when missing or wrong type (rc-3)
  if (
    taskId === null ||
    taskKind === null ||
    status === null ||
    attemptCount === null ||
    createdAt === null
  ) {
    return null;
  }
  const painId = readNullableString(v, "painId");
  const lastError = readNullableString(v, "lastError");
  const lastAttemptAt = readNullableString(v, "lastAttemptAt");
  return {
    taskId,
    taskKind,
    painId,
    status,
    lastError,
    attemptCount,
    createdAt,
    lastAttemptAt,
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

  const loadData = useCallback(async () => {
    setState({ status: "loading" });
    try {
      // Auth header — read from sessionStorage (same storage as api.ts)
      const token = sessionStorage.getItem("pd_token");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch("/api/v1/failed-tasks", { headers });

      // 403 = feature flag disabled — show disabled state (rc-9: surface reason)
      if (response.status === 403) {
        setState({ status: "disabled" });
        return;
      }

      if (!response.ok) {
        let errorMessage = `HTTP ${response.status}`;
        let nextAction: string | undefined;
        try {
          const raw = await response.json();
          if (isObject(raw)) {
            const msg = readString(raw, "message") ?? readString(raw, "error");
            if (msg) errorMessage = msg;
            const na = readNullableString(raw, "nextAction");
            if (na) nextAction = na;
          }
        } catch {
          // ignore parse errors — fall back to HTTP status message
        }
        setState({ status: "error", message: errorMessage, nextAction });
        return;
      }

      const raw = await response.json();
      // Unwrap { success: true, data: {...} } envelope
      const dataRaw =
        isObject(raw) && Object.hasOwn(raw, "success") && Object.hasOwn(raw, "data")
          ? raw.data
          : raw;
      const validated = validateFailedTasksData(dataRaw);
      if (validated === null) {
        setState({
          status: "error",
          message: t("pages.failedTasks.error"),
        });
        return;
      }
      setState({ status: "loaded", data: validated });
    } catch (err) {
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  }, [t]);

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
            t={t}
          />
        </div>
      )}
    </PageShell>
  );
}

// ── Loaded content ───────────────────────────────────────────────────────────

interface LoadedContentProps {
  data: FailedTasksData;
  onCreateDraft: (task: FailedTask) => void;
  t: (key: string) => string;
}

function LoadedContent({ data, onCreateDraft, t }: LoadedContentProps) {
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
                <TaskTable tasks={tasks} onCreateDraft={onCreateDraft} t={t} />
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Footer: total count */}
      <div className="mt-8 font-mono text-[11px] text-ink-4">
        {t("common.total")}: {data.total}
      </div>
    </>
  );
}

// ── Task table (per group) ───────────────────────────────────────────────────

interface TaskTableProps {
  tasks: FailedTask[];
  onCreateDraft: (task: FailedTask) => void;
  t: (key: string) => string;
}

function TaskTable({ tasks, onCreateDraft, t }: TaskTableProps) {
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
