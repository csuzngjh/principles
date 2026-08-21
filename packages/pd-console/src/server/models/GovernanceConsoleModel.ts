import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
} from '@principles/core/runtime-v2';
import type { ApprovalRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface StagnationSignal {
  type: 'no_pain' | 'never_activated';
  principleId: string;
  daysSince: number;
}

/**
 * System state indicator for the governance focus page.
 *
 * - `none`: No governance data exists (workspace not initialized or empty).
 * - `in_progress`: PD has recorded pipeline activity (tasks, candidates) but
 *   no owner-ready decision items are available yet.
 * - `owner_review_ready`: At least one pending approval awaits owner review.
 * - `degraded`: Pipeline or data source is degraded — decisions may be
 *   incomplete or delayed.
 */
export type GovernanceState = 'none' | 'in_progress' | 'owner_review_ready' | 'degraded';

/**
 * Machine-readable codes for degraded signals.
 * Frontend maps these via i18n; `reason` is English debug text.
 */
export type DegradedReasonCode = 'task_retry_wait' | 'task_failed' | 'approval_table_missing' | 'trajectory_db_unavailable';
export type DegradedNextActionCode = 'check_task_status' | 'fix_and_retry' | 'run_integrity_check' | 'check_trajectory_db';

export interface DegradedSignal {
  /** Machine-readable code for i18n mapping */
  reasonCode: DegradedReasonCode;
  /** Machine-readable code for i18n mapping */
  nextActionCode: DegradedNextActionCode;
  /** English debug text with dynamic details (task kind, error) */
  reason: string;
  /** English debug text for next action */
  nextAction: string;
  /** Source of the degraded signal, e.g. 'internalization_task', 'source_unavailable' */
  source: string;
  /**
   * PRI-556: bounded structured summary of the tasks behind this signal.
   * `reason` carries the same content as one bounded string; this field keeps
   * count + per-task details machine-readable for API consumers. The UI
   * validator currently ignores it (additive field).
   */
  failureSummary?: DegradedFailureSummary;
}

export interface DegradedFailureDetail {
  /** Task kind, e.g. 'artificer' */
  kind: string;
  /**
   * Short high-entropy task code — first 8 chars of the embedded UUID token
   * when present, else the last 12 chars. Full task id remains visible on
   * detail pages.
   */
  taskId: string;
  /** Bounded last_error excerpt */
  reason: string;
}

export interface DegradedFailureSummary {
  /** Bounded human-readable summary, e.g. "3 internalization failures require attention: …" */
  summary: string;
  /** Total number of in-window tasks behind this signal (may exceed details.length) */
  count: number;
  /** At most DEGRADED_SIGNAL_MAX_DETAILS entries */
  details: DegradedFailureDetail[];
}

/**
 * PRI-556: only failures/retries whose updated_at falls inside this window
 * drive the homepage degraded signal. Terminal `failed` rows have no cleanup
 * path, so counting all history made 'degraded' permanent (signal pollution).
 * Historical rows remain queryable on detail pages.
 */
const DEGRADED_SIGNAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** PRI-556: max per-task detail entries embedded in a degraded signal summary. */
const DEGRADED_SIGNAL_MAX_DETAILS = 5;

/**
 * Canonical UUID token inside a task id (`<role>-<chain>-<uuid>-<channel>×N`).
 * No `g` flag on purpose: stateless `match`, safe to share across calls.
 */
const TASK_ID_UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * PRI-556: short display code for a task id. Prefers the high-entropy UUID
 * head because most task ids end with the same repeated channel suffix
 * (e.g. `…-prompt-prompt-prompt`) — a tail slice would collapse distinct
 * tasks into identical short codes and defeat attribution. Falls back to the
 * tail slice for ids without a canonical UUID token; never throws on
 * unexpected id shapes (rc-1).
 */
function shortTaskId(taskId: string): string {
  const uuidMatch = TASK_ID_UUID_RE.exec(taskId);
  if (uuidMatch) return uuidMatch[0].slice(0, 8);
  return taskId.length <= 12 ? taskId : taskId.slice(-12);
}

function buildFailureSummary(prefix: string, details: DegradedFailureDetail[]): DegradedFailureSummary {
  const shown = details.slice(0, DEGRADED_SIGNAL_MAX_DETAILS);
  const shownText = shown.map((d) => `${d.kind}#${d.taskId} (${d.reason})`).join('; ');
  const remaining = details.length - shown.length;
  const summary = `${details.length} ${prefix}${shownText ? `: ${shownText}` : ''}${remaining > 0 ? `; +${remaining} more` : ''}`;
  return { summary, count: details.length, details: shown };
}

/**
 * Machine-readable codes for governance state reason/nextAction.
 * Frontend maps these via i18n; some codes support interpolation
 * (e.g. {{count}} from pendingReviewCount).
 */
export type StateReasonCode =
  | 'state_db_missing'
  | 'no_pipeline_activity'
  | 'pending_approvals'
  | 'pipeline_active'
  | 'consumed_candidates'
  | 'degraded_state';

export type NextActionCode =
  | 'run_config_doctor'
  | 'wait_for_pipeline'
  | 'review_approvals'
  | 'check_degraded_signals'
  | 'check_pipeline_status';

export interface GovernanceQueueResponse {
  /** Number of pending approvals awaiting owner review */
  pendingReviewCount: number;
  /** Number of high/critical risk pending approvals */
  behaviorDeviationCount: number;
  /** Stagnation signals for approvals older than 7 days */
  stagnationSignals: StagnationSignal[];
  /** Overall governance state */
  governanceState: GovernanceState;
  /** Machine-readable code for i18n mapping */
  stateReasonCode: StateReasonCode;
  /** Machine-readable code for i18n mapping */
  nextActionCode: NextActionCode;
  /** English debug text (fallback / logging) */
  stateReason: string;
  /** English debug text (fallback / logging) */
  nextAction: string;
  /** Human-readable summary of pipeline activity when state is 'in_progress' */
  inProgressSummary?: string;
  /** Degraded signals when state is 'degraded' */
  degradedSignals?: DegradedSignal[];
  /** PRI-380: Number of pain events in trajectory.db (behavior evidence in progress) */
  evidenceInProgressCount?: number;
  /** Wave 4: Number of gate blocks today (seconds-level auto-blocks by RuleHost) */
  gateBlocksToday?: number;
  generatedAt: string;
  /** Present when data is degraded/missing rather than genuinely zero */
  note?: string;
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class GovernanceConsoleModel {
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async getGovernanceQueue(): Promise<GovernanceQueueResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return {
        pendingReviewCount: 0,
        behaviorDeviationCount: 0,
        stagnationSignals: [],
        governanceState: 'none',
        stateReasonCode: 'state_db_missing',
        nextActionCode: 'run_config_doctor',
        stateReason: 'State database not initialized. PD has not run in this workspace.',
        nextAction: 'Ensure the OpenClaw plugin is enabled, or run pd config doctor.',
        generatedAt: new Date().toISOString(),
        note: 'state.db not found — workspace may not be initialized',
      };
    }

    const conn = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    try {
      const store = new SqliteApprovalQueueStore(conn);
      const queue = new ApprovalQueue(store);
      const artifactStore = new SqlitePIArtifactStore(conn);
      const db = conn.getDb();

      // 1. Pending approvals
      let pendingApprovals: ApprovalRecord[];
      let missingApprovalTable = false;
      try {
        pendingApprovals = await queue.listPending();
      } catch (err) {
        if (isMissingTableError(err)) {
          pendingApprovals = [];
          missingApprovalTable = true;
        } else {
          throw err;
        }
      }

      const pendingReviewCount = pendingApprovals.length;
      const behaviorDeviationCount = pendingApprovals.filter(
        (a) => a.riskLevel === 'high' || a.riskLevel === 'critical',
      ).length;

      const artifactPrincipleMap = new Map<string, string | null>();
      for (const approval of pendingApprovals) {
        if (!artifactPrincipleMap.has(approval.artifactId)) {
          try {
            const artifact: PIArtifactRecord | null = await artifactStore.getArtifactById(approval.artifactId);
            artifactPrincipleMap.set(approval.artifactId, artifact?.sourcePrincipleId ?? null);
          } catch (err) {
            if (isMissingTableError(err)) {
              artifactPrincipleMap.set(approval.artifactId, null);
            } else {
              throw err;
            }
          }
        }
      }

      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const stagnationSignals: StagnationSignal[] = pendingApprovals
        .filter((a) => {
          const requestedAt = new Date(a.requestedAt).getTime();
          return !Number.isNaN(requestedAt) && requestedAt < sevenDaysAgo;
        })
        .map((a) => {
          const requestedAt = new Date(a.requestedAt).getTime();
          const daysSince = Math.floor((Date.now() - requestedAt) / (24 * 60 * 60 * 1000));
          const principleId = artifactPrincipleMap.get(a.artifactId) ?? 'unlinked';
          return {
            type: 'never_activated' as const,
            principleId,
            daysSince,
          };
        });

      // 2. Check internalization pipeline activity (tasks)
      // PRI-556: pipeline activity still counts ALL tasks (drives in_progress),
      // but only in-window failures/retries produce degraded signals.
      let hasInternalizationTasks = false;
      const retryWaitDetails: DegradedFailureDetail[] = [];
      const failedDetails: DegradedFailureDetail[] = [];
      try {
        const tasks = db.prepare(
          `SELECT task_id, task_kind, status, last_error, updated_at FROM tasks WHERE task_kind IN ('dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator')`
        ).all() as { task_id: string; task_kind: string; status: string; last_error: string | null; updated_at: string }[];

        hasInternalizationTasks = tasks.length > 0;
        const actionableCutoff = Date.now() - DEGRADED_SIGNAL_WINDOW_MS;

        for (const task of tasks) {
          if (task.status !== 'retry_wait' && task.status !== 'failed') continue;
          // updated_at is untrusted row data — malformed timestamps fall
          // outside the window rather than poisoning the signal (rc-1).
          const updatedAtMs = new Date(task.updated_at).getTime();
          if (Number.isNaN(updatedAtMs) || updatedAtMs < actionableCutoff) continue;
          const detail: DegradedFailureDetail = {
            kind: task.task_kind,
            taskId: shortTaskId(task.task_id),
            reason: task.last_error ? task.last_error.substring(0, 120) : 'unknown error',
          };
          if (task.status === 'retry_wait') {
            retryWaitDetails.push(detail);
          } else {
            failedDetails.push(detail);
          }
        }
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }

      // 3. Check candidates table
      let hasConsumedCandidates = false;
      let hasPendingCandidates = false;
      try {
        const candidateRow = db.prepare(
          `SELECT status, COUNT(*) as c FROM principle_candidates GROUP BY status`
        ).all() as { status: string; c: number }[];

        for (const row of candidateRow) {
          if (row.status === 'consumed') hasConsumedCandidates = true;
          if (row.status === 'pending' || row.status === 'new') hasPendingCandidates = true;
        }
      } catch (err) {
        if (!isMissingTableError(err)) throw err;
      }

      // 4. Degraded signals
      const degradedSignals: DegradedSignal[] = [];

      if (retryWaitDetails.length > 0) {
        // PRI-556: bounded structured summary instead of unbounded concatenation
        const failureSummary = buildFailureSummary('internalization tasks waiting for retry', retryWaitDetails);
        degradedSignals.push({
          reasonCode: 'task_retry_wait',
          nextActionCode: 'check_task_status',
          reason: failureSummary.summary,
          nextAction: 'Check internalization pipeline status, or wait for automatic retry.',
          source: 'internalization_task',
          failureSummary,
        });
      }

      if (failedDetails.length > 0) {
        const failureSummary = buildFailureSummary('internalization failures require attention', failedDetails);
        degradedSignals.push({
          reasonCode: 'task_failed',
          nextActionCode: 'fix_and_retry',
          reason: failureSummary.summary,
          nextAction: 'Check failure details, fix the issue and retry.',
          source: 'internalization_task',
          failureSummary,
        });
      }

      if (missingApprovalTable) {
        degradedSignals.push({
          reasonCode: 'approval_table_missing',
          nextActionCode: 'run_integrity_check',
          reason: 'Approval table does not exist. This may be an old workspace.',
          nextAction: 'Run pd runtime internalization integrity to check and repair table structure.',
          source: 'source_unavailable',
        });
      }

      // ── Determine governance state ──────────────────────────────────────
      const hasOwnerReadyItems = pendingReviewCount > 0;
      const hasPipelineActivity = hasInternalizationTasks || hasConsumedCandidates || hasPendingCandidates;
      const hasDegradation = degradedSignals.length > 0;

      let governanceState: GovernanceState;
      let stateReasonCode: StateReasonCode;
      let nextActionCode: NextActionCode;
      let stateReason: string;
      let nextAction: string;
      let inProgressSummary: string | undefined;

      if (hasOwnerReadyItems) {
        governanceState = 'owner_review_ready';
        stateReasonCode = 'pending_approvals';
        nextActionCode = 'review_approvals';
        stateReason = `${pendingReviewCount} principle(s) pending your review and decision.`;
        nextAction = 'Review pending principles and approve, reject, or park.';
      } else if (hasDegradation) {
        governanceState = 'degraded';
        stateReasonCode = 'degraded_state';
        nextActionCode = 'check_degraded_signals';
        stateReason = 'Part of the governance pipeline or data source is degraded.';
        nextAction = 'Check degraded signal details and follow suggested actions.';
      } else if (hasPipelineActivity) {
        governanceState = 'in_progress';
        if (hasInternalizationTasks) {
          stateReasonCode = 'pipeline_active';
          nextActionCode = 'check_pipeline_status';
          inProgressSummary = 'PD is processing the internalization pipeline: diagnostics, principle candidates, or internalization task activity recorded, but no owner-reviewable decision items yet.';
          stateReason = 'Pipeline has activity, but candidate principles are not ready for review.';
          nextAction = 'Wait for internalization tasks to complete. If no change for a long time, check pipeline status.';
        } else {
          stateReasonCode = 'consumed_candidates';
          nextActionCode = 'wait_for_pipeline';
          inProgressSummary = 'PD has recorded governance chain activity (candidates generated), but candidates are not yet ready for review.';
          stateReason = 'Candidate records exist, but have not entered the review stage.';
          nextAction = 'Wait for the internalization pipeline to convert candidates into reviewable principles.';
        }
      } else {
        governanceState = 'none';
        stateReasonCode = 'no_pipeline_activity';
        nextActionCode = 'wait_for_pipeline';
        stateReason = 'No governance chain activity recorded yet.';
        nextAction = 'PD will surface principle candidates here once behavior deviations are captured and reviewable artifacts are generated.';
      }

      // PRI-380: Query trajectory.db for behavior evidence count
      let evidenceInProgressCount = 0;
      const trajectoryDbPath = path.join(this.workspaceDir, '.state', 'trajectory.db');
      if (fs.existsSync(trajectoryDbPath)) {
        try {
          const Database = (await import('better-sqlite3')).default;
          const trajDb = new Database(trajectoryDbPath, { readonly: true });
          try {
            const rows = trajDb.prepare('SELECT COUNT(*) as c FROM pain_events').all();
            if (Array.isArray(rows) && rows.length > 0) {
              const [row] = rows;
              if (isRecord(row) && Object.hasOwn(row, 'c') && typeof row.c === 'number') {
                evidenceInProgressCount = row.c;
              }
            }
          } catch (err) {
            if (!isMissingTableError(err)) throw err;
            degradedSignals.push({
              reasonCode: 'trajectory_db_unavailable',
              nextActionCode: 'check_trajectory_db',
              reason: 'Behavior evidence source (trajectory.db) is unavailable — evidence count may be inaccurate.',
              nextAction: 'Check trajectory.db file integrity in .state directory.',
              source: 'source_unavailable',
            });
          } finally {
            trajDb.close();
          }
        } catch (err) {
          degradedSignals.push({
            reasonCode: 'trajectory_db_unavailable',
            nextActionCode: 'check_trajectory_db',
            reason: 'Behavior evidence source (trajectory.db) is unavailable — evidence count may be inaccurate.',
            nextAction: 'Check trajectory.db file integrity in .state directory.',
            source: 'source_unavailable',
          });
          if (!(err instanceof Error)) throw err;
        }
      }

      // Wave 4: Query gate_blocks for today's auto-block count
      let gateBlocksToday = 0;
      if (fs.existsSync(trajectoryDbPath)) {
        try {
          const Database = (await import('better-sqlite3')).default;
          const trajDb = new Database(trajectoryDbPath, { readonly: true });
          try {
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            const row: unknown = trajDb.prepare('SELECT COUNT(*) as c FROM gate_blocks WHERE created_at >= ?').get(todayStart.toISOString());
            if (isRecord(row) && Object.hasOwn(row, 'c') && typeof row.c === 'number') {
              gateBlocksToday = row.c;
            }
          } catch (err) {
            if (!isMissingTableError(err)) throw err;
          } finally {
            trajDb.close();
          }
        } catch (err) {
          degradedSignals.push({
            reasonCode: 'trajectory_db_unavailable',
            nextActionCode: 'check_trajectory_db',
            reason: 'gate_blocks source is unavailable — gate block count may be inaccurate.',
            nextAction: 'Check trajectory.db file integrity in .state directory.',
            source: 'source_unavailable',
          });
          console.warn('GovernanceConsoleModel: failed to read gate_blocks:', err);
        }
      }

      const response: GovernanceQueueResponse = {
        pendingReviewCount,
        behaviorDeviationCount,
        stagnationSignals,
        governanceState,
        stateReasonCode,
        nextActionCode,
        stateReason,
        nextAction,
        generatedAt: new Date().toISOString(),
      };

      if (inProgressSummary) {
        response.inProgressSummary = inProgressSummary;
      }

      if (degradedSignals.length > 0) {
        response.degradedSignals = degradedSignals;
      }

      if (evidenceInProgressCount > 0) {
        response.evidenceInProgressCount = evidenceInProgressCount;
      }

      if (gateBlocksToday > 0) {
        response.gateBlocksToday = gateBlocksToday;
      }

      return response;
    } finally {
      try { conn.close(); } catch { /* best-effort */ }
    }
  }

  // eslint-disable-next-line @typescript-eslint/class-methods-use-this -- lifecycle interface; connections are request-scoped
  dispose(): void {
    // Connections are opened and closed per-request; no persistent state.
  }
}
