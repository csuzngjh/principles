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

export interface GovernanceQueueResponse {
  pendingReviewCount: number;
  behaviorDeviationCount: number;
  stagnationSignals: StagnationSignal[];
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
        generatedAt: new Date().toISOString(),
        note: 'state.db not found — workspace may not be initialized',
      };
    }

    const conn = this.getReadConnection();
    const store = new SqliteApprovalQueueStore(conn);
    const queue = new ApprovalQueue(store);
    const artifactStore = new SqlitePIArtifactStore(conn);

    let pendingApprovals: ApprovalRecord[];
    try {
      pendingApprovals = await queue.listPending();
    } catch (err) {
      if (isMissingTableError(err)) {
        return {
          pendingReviewCount: 0,
          behaviorDeviationCount: 0,
          stagnationSignals: [],
          generatedAt: new Date().toISOString(),
          note: 'approval queue table not found — workspace may not be initialized',
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

    // stagnationSignals = pending approvals older than 7 days with principleId lookup
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

    return {
      pendingReviewCount,
      behaviorDeviationCount,
      stagnationSignals,
      generatedAt: new Date().toISOString(),
    };
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch (err) { console.warn('GovernanceConsoleModel.dispose: failed to close connection:', err instanceof Error ? err.message : String(err)); }
      this.readConnection = null;
    }
  }
}
