import { describe, it, expect } from 'vitest';
import { decideAutoPromotion, ApprovalQueue } from '../approval-queue.js';
import { MemoryApprovalQueueStore } from '../memory-approval-store.js';

describe('decideAutoPromotion', () => {
  it('returns true for skill channel with confidence >= 0.95', () => {
    expect(decideAutoPromotion('skill', 0.95)).toBe(true);
    expect(decideAutoPromotion('skill', 0.96)).toBe(true);
    expect(decideAutoPromotion('skill', 1.0)).toBe(true);
  });

  it('returns false for skill channel with confidence < 0.95', () => {
    expect(decideAutoPromotion('skill', 0.94)).toBe(false);
    expect(decideAutoPromotion('skill', 0.5)).toBe(false);
    expect(decideAutoPromotion('skill', 0)).toBe(false);
  });

  it('returns false for code_tool_hook regardless of confidence', () => {
    expect(decideAutoPromotion('code_tool_hook', 0.99)).toBe(false);
    expect(decideAutoPromotion('code_tool_hook', 1.0)).toBe(false);
  });

  it('returns false for model_training regardless of confidence', () => {
    expect(decideAutoPromotion('model_training', 0.99)).toBe(false);
  });

  it('returns false for low-risk channels (already auto-activated)', () => {
    expect(decideAutoPromotion('prompt', 0.99)).toBe(false);
    expect(decideAutoPromotion('defer_archive', 0.99)).toBe(false);
  });

  it('returns false for undefined confidence', () => {
    expect(decideAutoPromotion('skill', undefined)).toBe(false);
  });

  it('returns false for null confidence', () => {
    expect(decideAutoPromotion('skill', null as unknown as number)).toBe(false);
  });

  it('returns false for negative confidence (out of range)', () => {
    expect(decideAutoPromotion('skill', -0.1)).toBe(false);
    expect(decideAutoPromotion('skill', -1)).toBe(false);
    expect(decideAutoPromotion('skill', -100)).toBe(false);
  });

  it('returns false for confidence > 1 (out of range)', () => {
    expect(decideAutoPromotion('skill', 1.1)).toBe(false);
    expect(decideAutoPromotion('skill', 2)).toBe(false);
    expect(decideAutoPromotion('skill', 100)).toBe(false);
  });
});

describe('ApprovalQueue', () => {
  it('enqueue creates a pending record', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const record = await queue.enqueue({
      artifactId: 'art-1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
      confidence: 0.8,
    }, '2026-05-18T00:00:00Z');
    expect(record.status).toBe('pending');
    expect(record.artifactId).toBe('art-1');
    expect(record.channel).toBe('code_tool_hook');
    expect(record.riskLevel).toBe('high');
    expect(record.confidence).toBe(0.8);
  });

  it('approve changes pending to approved', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const record = await queue.enqueue({
      artifactId: 'art-1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-05-18T00:00:00Z');
    const result = await queue.approve(record.approvalId, 'user-1', 'looks good');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe('approved');
      expect(result.record.decidedBy).toBe('user-1');
      expect(result.record.decisionNote).toBe('looks good');
    }
  });

  it('reject changes pending to rejected', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const record = await queue.enqueue({
      artifactId: 'art-1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-05-18T00:00:00Z');
    const result = await queue.reject(record.approvalId, 'user-1', 'too risky');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.status).toBe('rejected');
      expect(result.record.rejectionReason).toBe('too risky');
    }
  });

  it('approve returns error for already-decided record', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const record = await queue.enqueue({
      artifactId: 'art-1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-05-18T00:00:00Z');
    await queue.approve(record.approvalId, 'user-1');
    const result = await queue.approve(record.approvalId, 'user-2');
    expect(result.ok).toBe(false);
    if (!result.ok && result.error === 'already_decided') {
      expect(result.status).toBe('approved');
    }
  });

  it('reject returns error for already-decided record', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const record = await queue.enqueue({
      artifactId: 'art-1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-05-18T00:00:00Z');
    await queue.reject(record.approvalId, 'user-1', 'bad');
    const result = await queue.reject(record.approvalId, 'user-2', 'also bad');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('already_decided');
    }
  });

  it('approve returns not_found for missing record', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const result = await queue.approve('nonexistent', 'user-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  it('enqueue is idempotent for same artifact+channel', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const r1 = await queue.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    const r2 = await queue.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-19T00:00:00Z');
    expect(r1.approvalId).toBe(r2.approvalId);
    expect(r1.requestedAt).toBe(r2.requestedAt);
    expect(r1.requestedAt).toBe('2026-05-18T00:00:00Z');
    const pending = await queue.listPending();
    expect(pending).toHaveLength(1);
  });

    it('listPending returns only pending records', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    await queue.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await queue.enqueue({ artifactId: 'art-2', channel: 'model_training', riskLevel: 'critical' }, '2026-05-18T00:00:00Z');
    const r3 = await queue.enqueue({ artifactId: 'art-3', channel: 'skill', riskLevel: 'medium' }, '2026-05-18T00:00:00Z');
    await queue.approve(r3.approvalId, 'user-1');
    const pending = await queue.listPending();
    expect(pending).toHaveLength(2);
    expect(pending.every((r) => r.status === 'pending')).toBe(true);
  });

  it('listPending filters by channel', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    await queue.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await queue.enqueue({ artifactId: 'art-2', channel: 'model_training', riskLevel: 'critical' }, '2026-05-18T00:00:00Z');
    const pending = await queue.listPending({ channel: 'code_tool_hook' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.channel).toBe('code_tool_hook');
  });

  it('listPending filters by riskLevel', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    await queue.enqueue({ artifactId: 'art-1', channel: 'code_tool_hook', riskLevel: 'high' }, '2026-05-18T00:00:00Z');
    await queue.enqueue({ artifactId: 'art-2', channel: 'model_training', riskLevel: 'critical' }, '2026-05-18T00:00:00Z');
    await queue.enqueue({ artifactId: 'art-3', channel: 'skill', riskLevel: 'medium' }, '2026-05-18T00:00:00Z');
    const pending = await queue.listPending({ riskLevel: 'high' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.channel).toBe('code_tool_hook');
  });

  it('getById returns enqueued record', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);
    const record = await queue.enqueue({ artifactId: 'art-1', channel: 'skill', riskLevel: 'medium' }, '2026-05-18T00:00:00Z');
    const found = await queue.getById(record.approvalId);
    expect(found).not.toBeNull();
    expect(found?.artifactId).toBe('art-1');
  });
});
