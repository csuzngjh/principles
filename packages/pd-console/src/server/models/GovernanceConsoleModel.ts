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
 * - `owner_review_ready`: At least one owner decision item exists (pending
 *   approval or validated principle artifact).
 * - `degraded`: Pipeline or data source is degraded — decisions may be
 *   incomplete or delayed.
 */
export type GovernanceState = 'none' | 'in_progress' | 'owner_review_ready' | 'degraded';

export interface DegradedSignal {
  reason: string;
  nextAction: string;
  /** Source of the degraded signal, e.g. 'internalization_task', 'chain_integrity' */
  source: string;
}

export interface GovernanceQueueResponse {
  /** Number of pending approvals awaiting owner review */
  pendingReviewCount: number;
  /** Number of high/critical risk pending approvals */
  behaviorDeviationCount: number;
  /** Stagnation signals for approvals older than 7 days */
  stagnationSignals: StagnationSignal[];
  /** Overall governance state */
  governanceState: GovernanceState;
  /** Human-readable explanation of the governance state */
  stateReason: string;
  /** Suggested action for the owner given the current state */
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
        stateReason: '状态数据库未初始化。PD 尚未在此工作空间中运行。',
        nextAction: '确保 OpenClaw 插件已启用，或运行 pd config doctor 检查配置。',
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

    // 2. Check for validated PI artifacts (owner-ready decision items)
    let validatedArtifactCount = 0;
    try {
      const validatedRow = db.prepare(
        `SELECT COUNT(*) as c FROM pi_artifacts WHERE validation_status = 'validated'`
      ).get() as { c: number } | undefined;
      if (validatedRow && typeof validatedRow.c === 'number') {
        validatedArtifactCount = validatedRow.c;
      }
    } catch (err) {
      // pi_artifacts table may not exist in old workspaces
      if (!isMissingTableError(err)) throw err;
    }

    // 3. Check internalization pipeline activity (tasks)
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
          const errText = task.last_error ? task.last_error.substring(0, 120) : '未知错误';
          retryWaitReasons.push(`${task.task_kind}: ${errText}`);
        }
        if (task.status === 'failed') {
          hasFailedTasks = true;
          const errText = task.last_error ? task.last_error.substring(0, 120) : '未知错误';
          failedReasons.push(`${task.task_kind}: ${errText}`);
        }
      }
    } catch (err) {
      if (!isMissingTableError(err)) throw err;
    }

    // 4. Check candidates table for pipeline activity
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

    // 5. Check for broken chain (integrity read model)
    const degradedSignals: DegradedSignal[] = [];

    if (hasRetryWaitTasks) {
      degradedSignals.push({
        reason: `内化任务等待重试: ${retryWaitReasons.join('; ')}`,
        nextAction: '检查内化管线状态，或等待自动重试。',
        source: 'internalization_task',
      });
    }

    if (hasFailedTasks) {
      degradedSignals.push({
        reason: `内化任务失败: ${failedReasons.join('; ')}`,
        nextAction: '检查失败详情，修复问题后重试。',
        source: 'internalization_task',
      });
    }

    if (missingApprovalTable) {
      degradedSignals.push({
        reason: '审批表不存在，无法读取待审批项。这可能是旧版工作空间。',
        nextAction: '运行 pd runtime internalization integrity 检查并修复表结构。',
        source: 'source_unavailable',
      });
    }

    // ── Determine governance state ──────────────────────────────────────

    const hasOwnerReadyItems = pendingReviewCount > 0 || validatedArtifactCount > 0;
    const hasPipelineActivity = hasInternalizationTasks || hasConsumedCandidates || hasPendingCandidates;
    const hasDegradation = degradedSignals.length > 0;

    let governanceState: GovernanceState;
    let stateReason: string;
    let nextAction: string;
    let inProgressSummary: string | undefined;

    if (hasOwnerReadyItems) {
      governanceState = 'owner_review_ready';
      if (pendingReviewCount > 0) {
        stateReason = `有 ${pendingReviewCount} 条原则需要你审查并决定是否批准。`;
        nextAction = '审查待审批的原则，做出批准、拒绝或暂存的决定。';
      } else {
        stateReason = `有 ${validatedArtifactCount} 条已验证的原则候选已就绪，等待审查。`;
        nextAction = '审查已验证的原则候选，做出决定。';
      }
    } else if (hasDegradation) {
      governanceState = 'degraded';
      stateReason = '部分治理链路或数据源处于降级状态。';
      nextAction = '检查降级信号详情，按建议操作修复。';
    } else if (hasPipelineActivity) {
      governanceState = 'in_progress';
      if (hasInternalizationTasks) {
        inProgressSummary = 'PD 正在处理内部化管线：已记录诊断、原则候选或内化任务活动，但尚无可审查的决策项。';
        stateReason = '管线中有活动，但候选原则尚未准备好审查。';
        nextAction = '等待内化任务完成。如果长期无变化，检查内化管线状态。';
      } else {
        inProgressSummary = 'PD 已记录到治理链路中的活动（已生成候选人），但候选人尚未准备好审查。';
        stateReason = '已存在候选人记录，但尚未进入审查阶段。';
        nextAction = '等待内化管线将候选人转化为可审查的原则。';
      }
    } else {
      governanceState = 'none';
      stateReason = '尚未记录到任何治理链路活动。';
      nextAction = 'PD 会在捕获到行为偏差并生成可审查候选后，将其放到这里。';
    }

    const response: GovernanceQueueResponse = {
      pendingReviewCount,
      behaviorDeviationCount,
      stagnationSignals,
      governanceState,
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
