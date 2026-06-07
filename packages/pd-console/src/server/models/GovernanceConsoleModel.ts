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
export type DegradedReasonCode = 'task_retry_wait' | 'task_failed' | 'approval_table_missing';
export type DegradedNextActionCode = 'check_task_status' | 'fix_and_retry' | 'run_integrity_check';

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
  generatedAt: string;
  /** Present when data is degraded/missing rather than genuinely zero */
  note?: string;
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

export class GovernanceConsoleModel {
  private readConnection: SqliteConnection | null = null;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getReadConnection(): SqliteConnection {
    if (!this.readConnection) {
      this.readConnection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
    }
    return this.readConnection;
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

    const conn = this.getReadConnection();
    const store = new SqliteApprovalQueueStore(conn);
    const queue = new ApprovalQueue(store);
    const artifactStore = new SqlitePIArtifactStore(conn);
    const db = conn.getDb();

    // ── Gather signals from multiple data sources ───────────────────────

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

    // Build artifactId → sourcePrincipleId map for stagnation signals
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
    let hasInternalizationTasks = false;
    let hasRetryWaitTasks = false;
    let hasFailedTasks = false;
    const retryWaitReasons: string[] = [];
    const failedReasons: string[] = [];
    try {
      const tasks = db.prepare(
        `SELECT task_kind, status, last_error FROM tasks WHERE task_kind IN ('dreamer', 'philosopher', 'scribe', 'artificer', 'evaluator')`
      ).all() as { task_kind: string; status: string; last_error: string | null }[];

      hasInternalizationTasks = tasks.length > 0;

      for (const task of tasks) {
        if (task.status === 'retry_wait') {
          hasRetryWaitTasks = true;
          const errText = task.last_error ? task.last_error.substring(0, 120) : 'unknown error';
          retryWaitReasons.push(`${task.task_kind}: ${errText}`);
        }
        if (task.status === 'failed') {
          hasFailedTasks = true;
          const errText = task.last_error ? task.last_error.substring(0, 120) : 'unknown error';
          failedReasons.push(`${task.task_kind}: ${errText}`);
        }
      }
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }

    // 3. Check candidates table for pipeline activity
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

    if (hasRetryWaitTasks) {
      degradedSignals.push({
        reasonCode: 'task_retry_wait',
        nextActionCode: 'check_task_status',
        reason: `Internalization task waiting for retry: ${retryWaitReasons.join('; ')}`,
        nextAction: 'Check internalization pipeline status, or wait for automatic retry.',
        source: 'internalization_task',
      });
    }

    if (hasFailedTasks) {
      degradedSignals.push({
        reasonCode: 'task_failed',
        nextActionCode: 'fix_and_retry',
        reason: `Internalization task failed: ${failedReasons.join('; ')}`,
        nextAction: 'Check failure details, fix the issue and retry.',
        source: 'internalization_task',
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
    // P1-2: Only pendingReviewCount determines owner_review_ready.
    // Validated artifacts are NOT sufficient — they may be demo/smoke/historical.
    // The owner-actionable queue read model (PRI-330) will refine this.

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

    return response;
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch (err) { console.warn('GovernanceConsoleModel.dispose: failed to close connection:', err instanceof Error ? err.message : String(err)); }
      this.readConnection = null;
    }
  }
}
