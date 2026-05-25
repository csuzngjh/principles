import type {
  ApprovalListFilter,
  ApprovalListResult,
  ApprovalDecisionResult,
} from '@principles/core/runtime-v2';
import {
  SqliteConnection,
  SqliteApprovalQueueStore,
  ApprovalQueue,
  mapConfidenceToLabel,
  MVP_CHANNELS,
} from '@principles/core/runtime-v2';
import type { ApprovalWithContext } from '@principles/core/runtime-v2';

const MVP_PROVEN_CHANNELS: ReadonlySet<string> = new Set<string>(MVP_CHANNELS);

type UnsupportedChannelResult = { ok: false; error: 'unsupported_channel'; channel: string };
type ChannelGuardedDecisionResult = ApprovalDecisionResult | UnsupportedChannelResult;

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
    const allItems = await queue.listAll({ status: filter?.status, channel: filter?.channel });
    const mvpItems = allItems.filter((record) => MVP_PROVEN_CHANNELS.has(record.channel));
    const total = mvpItems.length;
    const page = filter?.page ?? 1;
    const pageSize = filter?.pageSize ?? 0;
    const pageItems = pageSize > 0 ? mvpItems.slice((page - 1) * pageSize, page * pageSize) : mvpItems;
    const enriched = pageItems.map((record) => ({
      ...record,
      confidenceLabel: mapConfidenceToLabel(record.confidence),
    }));
    const mvpStats = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const item of mvpItems) {
      const key = item.status as keyof typeof mvpStats;
      if (Object.hasOwn(mvpStats, key)) {
        mvpStats[key]++;
      }
    }
    return {
      items: enriched,
      total,
      stats: mvpStats,
    };
  }

  async getApprovalDetail(approvalId: string): Promise<(ApprovalWithContext & { isMvpProven: boolean }) | null> {
    const queue = this.getQueue();
    const record = await queue.getById(approvalId);
    if (!record) return null;
    return {
      ...record,
      confidenceLabel: mapConfidenceToLabel(record.confidence),
      isMvpProven: MVP_PROVEN_CHANNELS.has(record.channel),
    };
  }

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ChannelGuardedDecisionResult> {
    const queue = this.getQueue();
    const existing = await queue.getById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
    return queue.approve(approvalId, decidedBy, note);
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ChannelGuardedDecisionResult> {
    const queue = this.getQueue();
    const existing = await queue.getById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
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
