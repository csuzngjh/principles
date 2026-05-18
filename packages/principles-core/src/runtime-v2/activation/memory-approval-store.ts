import type {
  ApprovalDecisionResult,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalQueueStore,
  ApprovalRecord,
  ApprovalStatus,
  InternalizationChannel,
} from './activation-types.js';

function makeApprovalId(artifactId: string, channel: InternalizationChannel): string {
  return `apr_${channel}_${artifactId}`;
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
      status: 'pending' as ApprovalStatus,
      confidence: input.confidence,
      requestedAt: now,
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
