import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
} from '@principles/core/runtime-v2';
import type { ApprovalRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface PrincipleApprovalGroup {
  principleId: string;
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  channels: {
    channel: string;
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
  }[];
}

export interface ApprovalsGroupedResponse {
  groups: PrincipleApprovalGroup[];
  generatedAt: string;
}

function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('no such table');
}

export class ApprovalsGroupedConsoleModel {
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

  async getApprovalsGrouped(): Promise<ApprovalsGroupedResponse> {
    const stateDbPath = path.join(this.workspaceDir, '.pd', 'state.db');
    if (!fs.existsSync(stateDbPath)) {
      return { groups: [], generatedAt: new Date().toISOString() };
    }

    const conn = this.getReadConnection();
    const store = new SqliteApprovalQueueStore(conn);
    const queue = new ApprovalQueue(store);
    const artifactStore = new SqlitePIArtifactStore(conn);

    let allApprovals: ApprovalRecord[];
    try {
      allApprovals = await queue.listAll();
    } catch (err) {
      if (isMissingTableError(err)) {
        return { groups: [], generatedAt: new Date().toISOString() };
      }
      throw err;
    }

    // Build artifactId → sourcePrincipleId map
    const artifactPrincipleMap = new Map<string, string | null>();
    for (const approval of allApprovals) {
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

    // Group by principleId (null → "unlinked")
    const groupMap = new Map<string, Map<string, { pending: number; approved: number; rejected: number }>>();

    for (const approval of allApprovals) {
      const principleId = artifactPrincipleMap.get(approval.artifactId) ?? 'unlinked';

      if (!groupMap.has(principleId)) {
        groupMap.set(principleId, new Map());
      }
      const channelMap = groupMap.get(principleId);
      if (!channelMap) continue;

      const { channel } = approval;
      if (!channelMap.has(channel)) {
        channelMap.set(channel, { pending: 0, approved: 0, rejected: 0 });
      }
      const counts = channelMap.get(channel);
      if (!counts) continue;

      if (approval.status === 'pending') counts.pending++;
      else if (approval.status === 'approved') counts.approved++;
      else if (approval.status === 'rejected') counts.rejected++;
    }

    const groups: PrincipleApprovalGroup[] = [];
    for (const [principleId, channelMap] of groupMap) {
      let pendingCount = 0;
      let approvedCount = 0;
      let rejectedCount = 0;
      const channels: PrincipleApprovalGroup['channels'] = [];

      for (const [channel, counts] of channelMap) {
        pendingCount += counts.pending;
        approvedCount += counts.approved;
        rejectedCount += counts.rejected;
        channels.push({
          channel,
          pendingCount: counts.pending,
          approvedCount: counts.approved,
          rejectedCount: counts.rejected,
        });
      }

      groups.push({
        principleId,
        pendingCount,
        approvedCount,
        rejectedCount,
        channels,
      });
    }

    return {
      groups,
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
