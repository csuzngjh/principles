import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  SqlitePIArtifactStore,
  ApprovalQueue,
  loadLedger,
} from '@principles/core/runtime-v2';
import type { ApprovalRecord, PIArtifactRecord } from '@principles/core/runtime-v2';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ApprovalGroup {
  principleId: string;
  principleTitle: string;
  status: 'pending' | 'approved' | 'rejected';
  records: {
    id: string;
    artifactId: string;
    channel: string;
    createdAt: string;
  }[];
}

export interface ApprovalsGroupedResponse {
  groups: ApprovalGroup[];
  generatedAt: string;
  /** Present when data is degraded/missing rather than genuinely empty */
  note?: string;
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
      return { groups: [], generatedAt: new Date().toISOString(), note: 'state.db not found — workspace may not be initialized' };
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
        return { groups: [], generatedAt: new Date().toISOString(), note: 'approval table not found — workspace may not be initialized' };
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

    // Load ledger for principle titles
    const stateDir = path.join(this.workspaceDir, '.state');
    let principleTitles = new Map<string, string>();
    try {
      const ledger = loadLedger(stateDir);
      for (const [id, principle] of Object.entries(ledger.tree.principles)) {
        principleTitles.set(id, principle.text);
      }
    } catch {
      // Ledger not available — will fall back to principleId
    }

    // Group by principleId (null → "unlinked")
    const groupMap = new Map<string, {
      id: string;
      artifactId: string;
      channel: string;
      createdAt: string;
      status: 'pending' | 'approved' | 'rejected';
    }[]>();

    for (const approval of allApprovals) {
      const principleId = artifactPrincipleMap.get(approval.artifactId) ?? 'unlinked';

      if (!groupMap.has(principleId)) {
        groupMap.set(principleId, []);
      }
      const records = groupMap.get(principleId);
      if (!records) continue;

      records.push({
        id: approval.approvalId,
        artifactId: approval.artifactId,
        channel: approval.channel,
        createdAt: approval.requestedAt,
        status: approval.status as 'pending' | 'approved' | 'rejected',
      });
    }

    const groups: ApprovalGroup[] = [];
    for (const [principleId, records] of groupMap) {
      // Determine overall group status
      const statuses = records.map((r) => r.status);
      let status: 'pending' | 'approved' | 'rejected';
      if (statuses.every((s) => s === 'approved')) {
        status = 'approved';
      } else if (statuses.every((s) => s === 'rejected')) {
        status = 'rejected';
      } else {
        status = 'pending';
      }

      const principleTitle = principleTitles.get(principleId) ?? principleId;

      groups.push({
        principleId,
        principleTitle,
        status,
        records,
      });
    }

    return {
      groups,
      generatedAt: new Date().toISOString(),
    };
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch (err) { console.warn('ApprovalsGroupedConsoleModel.dispose: failed to close connection:', err instanceof Error ? err.message : String(err)); }
      this.readConnection = null;
    }
  }
}
