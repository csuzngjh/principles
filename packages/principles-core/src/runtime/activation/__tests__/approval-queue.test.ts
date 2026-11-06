/**
 * Approval Queue Tests — PRI-145
 *
 * Unit tests for ApprovalQueue class and decideAutoPromotion function.
 *
 * Tests verify:
 * - decideAutoPromotion() correctly evaluates auto-promotion conditions
 * - ApprovalQueue class methods work correctly with mock store
 * - Boundary conditions for confidence threshold
 *
 * ERR checklist:
 * - ERR-002: Every decision path carries reason + nextAction
 * - ERR-009: Malformed state fails loud
 * - ERR-025: Production-path tests, not just helpers
 */

import { describe, it, expect, vi } from 'vitest';
import {
  decideAutoPromotion,
  ApprovalQueue,
} from '../approval-queue';
import type {
  ApprovalQueueStore,
  ApprovalRecord,
  ApprovalDecisionResult,
  ApprovalEnqueueInput,
  ApprovalFilter,
  ApprovalListFilter,
  ApprovalStats,
} from '../activation-types';
import {
  AUTO_PROMOTION_CONFIDENCE_THRESHOLD,
  AUTO_PROMOTABLE_CHANNELS,
} from '../activation-types';
import type { InternalizationChannel } from '../../internalization/peer-runner-contracts';

// ── decideAutoPromotion Tests ─────────────────────────────────────────────────

describe('decideAutoPromotion', () => {
  it('returns true for skill channel with confidence >= 0.95', () => {
    expect(decideAutoPromotion('skill', 0.95)).toBe(true);
    expect(decideAutoPromotion('skill', 0.96)).toBe(true);
    expect(decideAutoPromotion('skill', 0.99)).toBe(true);
    expect(decideAutoPromotion('skill', 1.0)).toBe(true);
  });

  it('returns false for skill channel with confidence < 0.95', () => {
    expect(decideAutoPromotion('skill', 0.94)).toBe(false);
    expect(decideAutoPromotion('skill', 0.90)).toBe(false);
    expect(decideAutoPromotion('skill', 0.80)).toBe(false);
    expect(decideAutoPromotion('skill', 0.50)).toBe(false);
  });

  it('returns false for non-AUTO_PROMOTABLE_CHANNELS regardless of confidence', () => {
    // code_tool_hook is not auto-promotable
    expect(decideAutoPromotion('code_tool_hook', 0.99)).toBe(false);
    expect(decideAutoPromotion('code_tool_hook', 1.0)).toBe(false);

    // prompt is low-risk but not auto-promotable (goes through direct activation)
    expect(decideAutoPromotion('prompt', 0.99)).toBe(false);

    // defer_archive is low-risk but not auto-promotable
    expect(decideAutoPromotion('defer_archive', 0.99)).toBe(false);
  });

  it('returns false for undefined confidence', () => {
    expect(decideAutoPromotion('skill', undefined)).toBe(false);
  });

  it('returns false for null confidence', () => {
    expect(decideAutoPromotion('skill', null as unknown as undefined)).toBe(false);
  });

  it('returns false for negative confidence (invalid)', () => {
    expect(decideAutoPromotion('skill', -0.1)).toBe(false);
  });

  it('returns false for confidence > 1.0 (invalid)', () => {
    expect(decideAutoPromotion('skill', 1.5)).toBe(false);
  });

  // Boundary tests
  it('returns true at exact threshold 0.95', () => {
    expect(decideAutoPromotion('skill', AUTO_PROMOTION_CONFIDENCE_THRESHOLD)).toBe(true);
  });

  it('returns false just below threshold 0.94', () => {
    expect(decideAutoPromotion('skill', 0.94)).toBe(false);
  });

  it('AUTO_PROMOTABLE_CHANNELS contains only skill', () => {
    expect(AUTO_PROMOTABLE_CHANNELS).toEqual(['skill']);
  });

  it('AUTO_PROMOTION_CONFIDENCE_THRESHOLD is 0.95', () => {
    expect(AUTO_PROMOTION_CONFIDENCE_THRESHOLD).toBe(0.95);
  });

  it('only skill channel can be auto-promoted', () => {
    const channels: InternalizationChannel[] = [
      'prompt', 'defer_archive', 'skill', 'code_tool_hook',
    ];
    for (const channel of channels) {
      const canAutoPromote = decideAutoPromotion(channel, 0.95);
      expect(canAutoPromote).toBe(channel === 'skill');
    }
  });

  // Invariant: auto-promotion requires both channel AND confidence conditions
  it('auto-promotion requires both channel match AND confidence threshold', () => {
    // skill + high confidence → true
    expect(decideAutoPromotion('skill', 0.96)).toBe(true);

    // skill + low confidence → false
    expect(decideAutoPromotion('skill', 0.50)).toBe(false);

    // non-skill + high confidence → false
    expect(decideAutoPromotion('code_tool_hook', 0.96)).toBe(false);

    // non-skill + low confidence → false
    expect(decideAutoPromotion('code_tool_hook', 0.50)).toBe(false);
  });
});

// ── ApprovalQueue Class Tests ─────────────────────────────────────────────────

function createMockStore(): ApprovalQueueStore {
  const records: Map<string, ApprovalRecord> = new Map();

  return {
    enqueue: vi.fn(async (input: ApprovalEnqueueInput, now: string): Promise<ApprovalRecord> => {
      const approvalId = `apr_${input.channel}_${input.artifactId}`;
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
      records.set(approvalId, record);
      return record;
    }),

    getById: vi.fn(async (approvalId: string): Promise<ApprovalRecord | null> => {
      return records.get(approvalId) ?? null;
    }),

    listPending: vi.fn(async (filter?: ApprovalFilter): Promise<ApprovalRecord[]> => {
      const pending = Array.from(records.values()).filter(r => r.status === 'pending');
      if (filter?.channel) {
        return pending.filter(r => r.channel === filter.channel);
      }
      if (filter?.riskLevel) {
        return pending.filter(r => r.riskLevel === filter.riskLevel);
      }
      return pending;
    }),

    listAll: vi.fn(async (filter?: ApprovalListFilter): Promise<ApprovalRecord[]> => {
      let all = Array.from(records.values());
      if (filter?.status) {
        all = all.filter(r => r.status === filter.status);
      }
      if (filter?.channel) {
        all = all.filter(r => r.channel === filter.channel);
      }
      return all;
    }),

    countByStatus: vi.fn(async (): Promise<ApprovalStats> => {
      const all = Array.from(records.values());
      return {
        pending: all.filter(r => r.status === 'pending').length,
        approved: all.filter(r => r.status === 'approved').length,
        rejected: all.filter(r => r.status === 'rejected').length,
        cancelled: all.filter(r => r.status === 'cancelled').length,
      };
    }),

    approve: vi.fn(async (approvalId: string, decidedBy: string, note?: string): Promise<ApprovalDecisionResult> => {
      const record = records.get(approvalId);
      if (!record) return { ok: false, error: 'not_found' };
      if (record.status !== 'pending') return { ok: false, error: 'already_decided', status: record.status };
      record.status = 'approved';
      record.decidedAt = new Date().toISOString();
      record.decidedBy = decidedBy;
      record.decisionNote = note;
      return { ok: true, record };
    }),

    reject: vi.fn(async (approvalId: string, decidedBy: string, reason: string): Promise<ApprovalDecisionResult> => {
      const record = records.get(approvalId);
      if (!record) return { ok: false, error: 'not_found' };
      if (record.status !== 'pending') return { ok: false, error: 'already_decided', status: record.status };
      record.status = 'rejected';
      record.decidedAt = new Date().toISOString();
      record.decidedBy = decidedBy;
      record.rejectionReason = reason;
      return { ok: true, record };
    }),

    resetToPending: vi.fn(async (approvalId: string): Promise<{ ok: true } | { ok: false; error: 'not_found' | 'not_approved' }> => {
      const record = records.get(approvalId);
      if (!record) return { ok: false, error: 'not_found' };
      if (record.status !== 'approved') return { ok: false, error: 'not_approved' };
      record.status = 'pending';
      record.decidedAt = undefined;
      record.decidedBy = undefined;
      return { ok: true };
    }),

    edit: vi.fn(async (input: { approvalId: string; editedBy: string; newArtifactId: string; editReason: string; now: string }): Promise<ApprovalDecisionResult> => {
      const record = records.get(input.approvalId);
      if (!record) return { ok: false, error: 'not_found' };
      if (record.status !== 'pending') return { ok: false, error: 'already_decided', status: record.status };
      record.previousArtifactId = record.artifactId;
      record.artifactId = input.newArtifactId;
      record.editedAt = input.now;
      record.editedBy = input.editedBy;
      record.editReason = input.editReason;
      return { ok: true, record };
    }),
  };
}

describe('ApprovalQueue', () => {
  it('enqueue creates a pending approval record', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const record = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
      confidence: 0.85,
      summary: 'Test approval',
    }, '2026-05-17T00:00:00Z');

    expect(record.status).toBe('pending');
    expect(record.artifactId).toBe('art-001');
    expect(record.channel).toBe('skill');
    expect(record.confidence).toBe(0.85);
  });

  it('getById returns the correct record', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    const found = await queue.getById(created.approvalId);
    expect(found).not.toBeNull();
    expect(found?.approvalId).toBe(created.approvalId);
  });

  it('getById returns null for non-existent approval', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const found = await queue.getById('non-existent');
    expect(found).toBeNull();
  });

  it('approve changes status to approved', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    const result = await queue.approve(created.approvalId, 'user-001', 'Looks good');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe('approved');
      expect(result.record.decidedBy).toBe('user-001');
      expect(result.record.decisionNote).toBe('Looks good');
    }
  });

  it('reject changes status to rejected', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    const result = await queue.reject(created.approvalId, 'user-001', 'Not ready');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe('rejected');
      expect(result.record.decidedBy).toBe('user-001');
      expect(result.record.rejectionReason).toBe('Not ready');
    }
  });

  it('approve returns error for non-existent approval', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const result = await queue.approve('non-existent', 'user-001');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  it('approve returns error for already decided approval', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    // First approve succeeds
    await queue.approve(created.approvalId, 'user-001');

    // Second approve fails
    const result = await queue.approve(created.approvalId, 'user-002');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'already_decided') {
      expect(result.status).toBe('approved');
    }
  });

  it('reject returns error for already decided approval', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    // First approve succeeds
    await queue.approve(created.approvalId, 'user-001');

    // Reject fails because already approved
    const result = await queue.reject(created.approvalId, 'user-002', 'Changed mind');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_decided');
    }
  });

  it('listPending returns only pending approvals', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    const created2 = await queue.enqueue({
      artifactId: 'art-002',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    // Approve one
    await queue.approve(created2.approvalId, 'user-001');

    const pending = await queue.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.artifactId).toBe('art-001');
  });

  it('listPending with filter returns matching approvals', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    await queue.enqueue({
      artifactId: 'art-002',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-05-17T00:00:00Z');

    const skillPending = await queue.listPending({ channel: 'skill' });
    expect(skillPending).toHaveLength(1);
    expect(skillPending[0]?.channel).toBe('skill');

    const highRiskPending = await queue.listPending({ riskLevel: 'high' });
    expect(highRiskPending).toHaveLength(1);
    expect(highRiskPending[0]?.riskLevel).toBe('high');
  });

  it('countByStatus returns correct counts', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created1 = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    const created2 = await queue.enqueue({
      artifactId: 'art-002',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    await queue.enqueue({
      artifactId: 'art-003',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    await queue.approve(created1.approvalId, 'user-001');
    await queue.reject(created2.approvalId, 'user-001', 'Not good');

    const stats = await queue.countByStatus();
    expect(stats.pending).toBe(1);
    expect(stats.approved).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.cancelled).toBe(0);
  });

  it('resetToPending rolls back approved approval', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    await queue.approve(created.approvalId, 'user-001');

    const result = await queue.resetToPending(created.approvalId);
    expect(result.ok).toBe(true);

    const found = await queue.getById(created.approvalId);
    expect(found?.status).toBe('pending');
  });

  it('resetToPending returns error for non-existent approval', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const result = await queue.resetToPending('non-existent');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  it('resetToPending returns error for non-approved approval', async () => {
    const store = createMockStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-001',
      channel: 'skill',
      riskLevel: 'medium',
    }, '2026-05-17T00:00:00Z');

    // Still pending, not approved
    const result = await queue.resetToPending(created.approvalId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_approved');
    }
  });
});