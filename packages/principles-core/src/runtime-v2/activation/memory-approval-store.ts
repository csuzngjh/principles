import { matchesApprovalReview, staleApprovalReview, type ApprovalReviewGuard } from './approval-review-guard.js';
import { isArtifactRevisionOf, type PIArtifactSnapshot } from './activation-types.js';
import type {
  ApprovalDecisionResult,
  ApprovalEditInput,
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
  constructor(private readonly readArtifact?: (artifactId: string) => PIArtifactSnapshot | null) {}

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
      if (Object.hasOwn(stats, r.status)) {
        stats[r.status]++;
      }
    }
    return stats;
  }

  // eslint-disable-next-line @typescript-eslint/max-params -- preserve the existing positional CLI contract with an additive optional review guard
  async approve(approvalId: string, decidedBy: string, note?: string, expectedReview?: ApprovalReviewGuard): Promise<ApprovalDecisionResult> {
    const existing = this.records.get(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }
    if (expectedReview && (!this.readArtifact || !matchesApprovalReview(existing, this.readArtifact(existing.artifactId), expectedReview))) return staleApprovalReview();
    const updated: ApprovalRecord = {
      ...existing,
      status: 'approved',
      artifactDigest: expectedReview?.artifactState === 'present' ? expectedReview.artifactDigest : existing.artifactDigest,
      decidedAt: new Date().toISOString(),
      decidedBy,
      decisionNote: note,
    };
    this.records.set(approvalId, updated);
    return { ok: true, record: updated };
  }

  // eslint-disable-next-line @typescript-eslint/max-params -- preserve the existing positional CLI contract with an additive optional review guard
  async reject(approvalId: string, decidedBy: string, reason: string, expectedReview?: ApprovalReviewGuard): Promise<ApprovalDecisionResult> {
    const existing = this.records.get(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }
    if (expectedReview && (!this.readArtifact || !matchesApprovalReview(existing, this.readArtifact(existing.artifactId), expectedReview, true))) return staleApprovalReview();
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

  async resetToPending(approvalId: string): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_approved' }> {
    const existing = this.records.get(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'approved') return { ok: false, error: 'not_approved' };
    const reset: ApprovalRecord = {
      ...existing,
      status: 'pending',
      decidedAt: undefined,
      decidedBy: undefined,
      decisionNote: undefined,
      artifactDigest: undefined,
    };
    this.records.set(approvalId, reset);
    return { ok: true };
  }

  async edit(input: ApprovalEditInput): Promise<ApprovalDecisionResult> {
    const existing = this.records.get(input.approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }
    if (input.expectedReview && (!this.readArtifact || !matchesApprovalReview(existing, this.readArtifact(existing.artifactId), input.expectedReview))) return staleApprovalReview();
    if (input.expectedReview) {
      const original = this.readArtifact?.(existing.artifactId);
      const replacement = this.readArtifact?.(input.newArtifactId);
      if (!original || !replacement || replacement.validationStatus !== 'validated' || !isArtifactRevisionOf(replacement, original)) return staleApprovalReview();
    }
    const updated: ApprovalRecord = {
      ...existing,
      artifactId: input.newArtifactId,
      artifactDigest: undefined,
      editedAt: input.now,
      editedBy: input.editedBy,
      editReason: input.editReason,
      previousArtifactId: existing.artifactId,
    };
    this.records.set(input.approvalId, updated);
    return { ok: true, record: updated };
  }
}