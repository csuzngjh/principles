import type {
  ApprovalDecisionResult,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalListFilter,
  ApprovalQueueStore,
  ApprovalRecord,
  ApprovalStats,
  InternalizationChannel,
} from './activation-types.js';

function makeApprovalId(artifactId: string, channel: InternalizationChannel): string {
  return 'apr_' + channel + '_' + artifactId;
}

export class MemoryApprovalQueueStore implements ApprovalQueueStore {
  private readonly records = new Map<string, ApprovalRecord>();

  async enqueue(input: ApprovalEnqueueInput, now: string): Promise<ApprovalRecord> {
    const approvalId = makeApprovalId(input.artifactId, input.channel);
    const existing = this.records.get(approvalId);
    if (existing) return existing;
    const record: ApprovalRecord = {
      approvalId,
      artifactId: input.artifactId,
      channel: input.channel,
      riskLevel: input.riskLevel,
      status: 'pending',
      confidence: input.confidence,
      requestedAt: now,
      summary: input.summary,
      triggerReason: input.triggerReason,
      confidenceExplanation: input.confidenceExplanation,
      effectDescription: input.effectDescription,
      rejectionEffect: input.rejectionEffect,
    };
    this.records.set(approvalId, record);
    return record;
  }

  async getById(approvalId: string): Promise<ApprovalRecord | null> {
    return this.records.get(approvalId) ?? null;
  }

  async listPending(filter?: ApprovalFilter): Promise<ApprovalRecord[]> {
    const all = [...this.records.values()].filter((r) => r.status === 'pending');
    if (!filter) return all;
    return all.filter((r) => {
      if (filter.channel && r.channel !== filter.channel) return false;
      if (filter.riskLevel && r.riskLevel !== filter.riskLevel) return false;
      return true;
    });
  }

  async listAll(filter?: ApprovalListFilter): Promise<ApprovalRecord[]> {
    let items = [...this.records.values()];
    if (filter?.status) {
      items = items.filter((r) => r.status === filter.status);
    }
    if (filter?.channel) {
      items = items.filter((r) => r.channel === filter.channel);
    }
    const page = Math.max(1, filter?.page ?? 1);
    const pageSize = filter?.pageSize ?? 0;
    if (pageSize <= 0) return items;
    const offset = (page - 1) * pageSize;
    return items.slice(offset, offset + pageSize);
  }

  async countByStatus(): Promise<ApprovalStats> {
    const stats: ApprovalStats = { pending: 0, approved: 0, rejected: 0, cancelled: 0 };
    for (const r of this.records.values()) {
      if (r.status in stats) {
        stats[r.status]++;
      }
    }
    return stats;
  }

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ApprovalDecisionResult> {
    const existing = this.records.get(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }
    const updated: ApprovalRecord = {
      ...existing,
      status: 'approved',
      decidedAt: new Date().toISOString(),
      decidedBy,
      decisionNote: note,
    };
    this.records.set(approvalId, updated);
    return { ok: true, record: updated };
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult> {
    const existing = this.records.get(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }
    const updated: ApprovalRecord = {
      ...existing,
      status: 'rejected',
      decidedAt: new Date().toISOString(),
      decidedBy,
      rejectionReason: reason,
    };
    this.records.set(approvalId, updated);
    return { ok: true, record: updated };
  }
}