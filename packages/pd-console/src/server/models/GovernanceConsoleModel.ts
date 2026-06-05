import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  ApprovalQueue,
} from '@principles/core/runtime-v2';
import type { ApprovalRecord } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GovernanceQueueResponse {
  pendingReviewCount: number;
  behaviorDeviationCount: number;
  stagnationSignals: number;
  generatedAt: string;
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
        stagnationSignals: 0,
        generatedAt: new Date().toISOString(),
      };
    }

    const conn = this.getReadConnection();
    const store = new SqliteApprovalQueueStore(conn);
    const queue = new ApprovalQueue(store);

    let pendingApprovals: ApprovalRecord[];
    try {
      pendingApprovals = await queue.listPending();
    } catch (err) {
      if (isMissingTableError(err)) {
        return {
          pendingReviewCount: 0,
          behaviorDeviationCount: 0,
          stagnationSignals: 0,
          generatedAt: new Date().toISOString(),
        };
      }
      throw err;
    }

    // pendingReviewCount = total pending approvals
    const pendingReviewCount = pendingApprovals.length;

    // behaviorDeviationCount = pending approvals for high/critical risk channels
    const behaviorDeviationCount = pendingApprovals.filter(
      (a) => a.riskLevel === 'high' || a.riskLevel === 'critical',
    ).length;

    // stagnationSignals = pending approvals older than 7 days
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const stagnationSignals = pendingApprovals.filter((a) => {
      const requestedAt = new Date(a.requestedAt).getTime();
      return !Number.isNaN(requestedAt) && requestedAt < sevenDaysAgo;
    }).length;

    return {
      pendingReviewCount,
      behaviorDeviationCount,
      stagnationSignals,
      generatedAt: new Date().toISOString(),
    };
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch { /* best-effort */ }
      this.readConnection = null;
    }
  }
}
