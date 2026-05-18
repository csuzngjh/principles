import type {
  ApprovalListFilter,
  ApprovalListResult,
  ApprovalWithContext,
  ApprovalDecisionResult,
} from '@principles/core/runtime-v2';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  ApprovalQueue,
  mapConfidenceToLabel,
} from '@principles/core/runtime-v2';

export class ApprovalsConsoleModel {
  private connection: SqliteConnection | null = null;
  private queue: ApprovalQueue | null = null;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getQueue(): ApprovalQueue {
    if (!this.queue) {
      this.connection = new SqliteConnection({ workspaceDir: this.workspaceDir });
      const store = new SqliteApprovalQueueStore(this.connection);
      this.queue = new ApprovalQueue(store);
    }
    return this.queue;
  }

  async listApprovals(filter?: ApprovalListFilter): Promise<ApprovalListResult> {
    const queue = this.getQueue();
    const [items, stats] = await Promise.all([
      queue.listAll({ status: filter?.status, channel: filter?.channel }),
      queue.countByStatus(),
    ]);
    const total = items.length;
    const page = filter?.page ?? 1;
    const pageSize = filter?.pageSize ?? 0;
    const pageItems = pageSize > 0 ? items.slice((page - 1) * pageSize, page * pageSize) : items;
    const enriched = pageItems.map((record) => ({
      ...record,
      confidenceLabel: mapConfidenceToLabel(record.confidence),
    }));
    return {
      items: enriched,
      total,
      stats,
    };
  }

  async getApprovalDetail(approvalId: string): Promise<ApprovalWithContext | null> {
    const queue = this.getQueue();
    const record = await queue.getById(approvalId);
    if (!record) return null;
    return {
      ...record,
      confidenceLabel: mapConfidenceToLabel(record.confidence),
    };
  }

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ApprovalDecisionResult> {
    const queue = this.getQueue();
    return queue.approve(approvalId, decidedBy, note);
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult> {
    const queue = this.getQueue();
    return queue.reject(approvalId, decidedBy, reason);
  }

  dispose(): void {
    if (this.connection) {
      try { this.connection.close(); } catch { /* best-effort */ }
      this.connection = null;
    }
    this.queue = null;
  }
}
