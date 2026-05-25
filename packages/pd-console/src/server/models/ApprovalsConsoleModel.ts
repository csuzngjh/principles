import * as fs from 'node:fs';
import * as path from 'node:path';
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

const EMPTY_STATS = { pending: 0, approved: 0, rejected: 0, cancelled: 0 } as const;

type UnsupportedChannelResult = { ok: false; error: 'unsupported_channel'; channel: string };
type ChannelGuardedDecisionResult = ApprovalDecisionResult | UnsupportedChannelResult;

function stateDbExists(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'));
}

export class ApprovalsConsoleModel {
  private readConnection: SqliteConnection | null = null;
  private readQueue: ApprovalQueue | null = null;
  private writeConnection: SqliteConnection | null = null;
  private writeQueue: ApprovalQueue | null = null;
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  private getReadQueue(): ApprovalQueue {
    if (!this.readQueue) {
      this.readConnection = new SqliteConnection({ workspaceDir: this.workspaceDir, readonly: true });
      const store = new SqliteApprovalQueueStore(this.readConnection);
      this.readQueue = new ApprovalQueue(store);
    }
    return this.readQueue;
  }

  private getWriteQueue(): ApprovalQueue {
    if (!this.writeQueue) {
      this.writeConnection = new SqliteConnection({ workspaceDir: this.workspaceDir });
      const store = new SqliteApprovalQueueStore(this.writeConnection);
      this.writeQueue = new ApprovalQueue(store);
    }
    return this.writeQueue;
  }

  async listApprovals(filter?: ApprovalListFilter): Promise<ApprovalListResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { items: [], total: 0, stats: { ...EMPTY_STATS } };
    }
    const queue = this.getReadQueue();
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
    if (!stateDbExists(this.workspaceDir)) {
      return null;
    }
    const queue = this.getReadQueue();
    const record = await queue.getById(approvalId);
    if (!record) return null;
    return {
      ...record,
      confidenceLabel: mapConfidenceToLabel(record.confidence),
      isMvpProven: MVP_PROVEN_CHANNELS.has(record.channel),
    };
  }

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ChannelGuardedDecisionResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const readQueue = this.getReadQueue();
    const existing = await readQueue.getById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
    return this.getWriteQueue().approve(approvalId, decidedBy, note);
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ChannelGuardedDecisionResult> {
    if (!stateDbExists(this.workspaceDir)) {
      return { ok: false, error: 'not_found' };
    }
    const readQueue = this.getReadQueue();
    const existing = await readQueue.getById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!MVP_PROVEN_CHANNELS.has(existing.channel)) {
      return { ok: false, error: 'unsupported_channel', channel: existing.channel };
    }
    return this.getWriteQueue().reject(approvalId, decidedBy, reason);
  }

  dispose(): void {
    if (this.readConnection) {
      try { this.readConnection.close(); } catch { /* best-effort */ }
      this.readConnection = null;
    }
    this.readQueue = null;
    if (this.writeConnection) {
      try { this.writeConnection.close(); } catch { /* best-effort */ }
      this.writeConnection = null;
    }
    this.writeQueue = null;
  }
}
