/**
 * Task-related types for failed-task observability (Task 8).
 *
 * These types support the failed_tasks_observability feature flag and the
 * /api/v1/failed-tasks route. They summarize task rows whose status is
 * 'failed' or 'needs_human_review' for operator inspection.
 */
import type { TaskRecord } from '../../task-status.js';
import type { RunRecord } from '../run/run-store.js';

/**
 * Summary of a failed (or needs-human-review) task, suitable for list views.
 *
 * Schema adaptation notes:
 * - `taskKind` maps to the `task_kind` column (PD has no `runner_kind` column;
 *   the task kind IS the runner kind for PD pipeline tasks).
 * - `painId` is extracted from `diagnostic_json.sourcePainId` when present
 *   (diagnostician tasks carry the originating pain signal ID there).
 * - `lastAttemptAt` is derived from `MAX(runs.started_at)` for the task;
 *   null when the task has no run records.
 * - `lastError` is the PDErrorCategory string from `tasks.last_error` (e.g.
 *   'runtime_unavailable'), NOT a free-text error message.
 */
export interface FailedTaskSummary {
  taskId: string;
  taskKind: string;
  painId: string | null;
  status: 'failed' | 'needs_human_review';
  lastError: string | null;
  attemptCount: number;
  /** Retry budget for this task; with attemptCount it lets consumers detect an exhausted task (attemptCount >= maxAttempts). */
  maxAttempts: number;
  createdAt: string;
  lastAttemptAt: string | null;
}

/**
 * Filter for listFailedTasks / countFailedTasks.
 *
 * - `kind`: filter by task_kind (e.g. 'diagnostician').
 * - `since`: Unix timestamp in ms; only tasks whose last run started at or
 *   after this time are included. Tasks with no runs are excluded when
 *   `since` is specified.
 * - `limit` / `offset`: pagination.
 */
export interface FailedTaskFilter {
  kind?: string;
  since?: number;
  limit?: number;
  offset?: number;
}

/**
 * Detail view for a single failed task, including its run history.
 *
 * `pendingAgentDraft` is null in Task 8; Task 13 will wire it to the
 * pending_agent_drafts table.
 */
export interface FailedTaskDetail {
  task: TaskRecord;
  runs: RunRecord[];
  lastError: string | null;
  pendingAgentDraft: unknown | null;
}
