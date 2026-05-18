import type { InternalizationChannel } from '../internalization/peer-runner-contracts.js';
import type {
  ApprovalDecisionResult,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalListFilter,
  ApprovalQueueStore,
  ApprovalRecord,
  ApprovalStats,
} from './activation-types.js';
import {
  AUTO_PROMOTABLE_CHANNELS,
  AUTO_PROMOTION_CONFIDENCE_THRESHOLD,
} from './activation-types.js';

export function decideAutoPromotion(channel: InternalizationChannel, confidence: number | undefined): boolean {
  if (confidence === undefined || confidence === null) return false;
  if (confidence < 0 || confidence > 1) return false;
  if (!AUTO_PROMOTABLE_CHANNELS.includes(channel)) return false;
  return confidence >= AUTO_PROMOTION_CONFIDENCE_THRESHOLD;
}

export class ApprovalQueue {
  constructor(private readonly store: ApprovalQueueStore) {}

  async enqueue(input: ApprovalEnqueueInput, now: string): Promise<ApprovalRecord> {
    return this.store.enqueue(input, now);
  }

  async getById(approvalId: string): Promise<ApprovalRecord | null> {
    return this.store.getById(approvalId);
  }

  async listPending(filter?: ApprovalFilter): Promise<ApprovalRecord[]> {
    return this.store.listPending(filter);
  }

  async approve(approvalId: string, decidedBy: string, note?: string): Promise<ApprovalDecisionResult> {
    const existing = await this.store.getById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }
    return this.store.approve(approvalId, decidedBy, note);
  }

  async reject(approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult> {
    const existing = await this.store.getById(approvalId);
    if (!existing) return { ok: false, error: 'not_found' };
    if (existing.status !== 'pending') {
      return { ok: false, error: 'already_decided', status: existing.status };
    }
    return this.store.reject(approvalId, decidedBy, reason);
  }

  async listAll(filter?: ApprovalListFilter): Promise<ApprovalRecord[]> {
    return this.store.listAll(filter);
  }

  async countByStatus(): Promise<ApprovalStats> {
    return this.store.countByStatus();
  }
}