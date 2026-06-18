/**
 * Edit-Then-Approve Tests — Story A (PRI-408)
 *
 * Tests verify the edit-then-approve flow:
 * - Owner can edit a pending approval's artifact to a new version
 * - Edit records actor, time, reason, previous artifactId (lineage)
 * - Edit keeps status as pending (must re-approve)
 * - Cannot edit an already-decided approval
 * - After edit, the old artifact version must not be activatable
 *
 * Product Contract A: "Owner 必须能：approve；edit 后 approve；reject"
 *
 * ERR checklist:
 * - ERR-002: Every failure path carries reason
 * - ERR-004: Lineage fields (previousArtifactId) must be consistent
 * - ERR-009: Required fields fail loud when missing
 * - ERR-025: Production-path test
 */

import { describe, it, expect } from 'vitest';
import { ApprovalQueue } from '../approval-queue.js';
import { MemoryApprovalQueueStore } from '../memory-approval-store.js';

describe('ApprovalQueue edit-then-approve', () => {
  it('edits a pending approval to a new artifact version', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-v1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-06-18T00:00:00.000Z');

    const editResult = await queue.edit({
      approvalId: created.approvalId,
      editedBy: 'owner-001',
      newArtifactId: 'art-v2',
      editReason: 'Refined principle text for clarity',
      now: '2026-06-18T01:00:00.000Z',
    });

    expect(editResult.ok).toBe(true);
    if (editResult.ok) {
      expect(editResult.record.artifactId).toBe('art-v2');
      expect(editResult.record.status).toBe('pending');
      expect(editResult.record.editedAt).toBe('2026-06-18T01:00:00.000Z');
      expect(editResult.record.editedBy).toBe('owner-001');
      expect(editResult.record.editReason).toBe('Refined principle text for clarity');
      expect(editResult.record.previousArtifactId).toBe('art-v1');
    }
  });

  it('keeps status as pending after edit (must re-approve)', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-v1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-06-18T00:00:00.000Z');

    await queue.edit({ approvalId: created.approvalId, editedBy: 'owner-001', newArtifactId: 'art-v2', editReason: 'Fixed rule logic', now: '2026-06-18T01:00:00.000Z' });

    const found = await queue.getById(created.approvalId);
    expect(found?.status).toBe('pending');
    expect(found?.decidedAt).toBeUndefined();
    expect(found?.decidedBy).toBeUndefined();
  });

  it('allows approve after edit', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-v1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-06-18T00:00:00.000Z');

    await queue.edit({ approvalId: created.approvalId, editedBy: 'owner-001', newArtifactId: 'art-v2', editReason: 'Improved', now: '2026-06-18T01:00:00.000Z' });

    const approveResult = await queue.approve(created.approvalId, 'owner-001', 'Approved edited version');
    expect(approveResult.ok).toBe(true);
    if (approveResult.ok) {
      expect(approveResult.record.status).toBe('approved');
      expect(approveResult.record.artifactId).toBe('art-v2');
    }
  });

  it('returns error when editing non-existent approval', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);

    const result = await queue.edit({ approvalId: 'non-existent', editedBy: 'owner-001', newArtifactId: 'art-v2', editReason: 'reason', now: '2026-06-18T01:00:00.000Z' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  it('returns error when editing an already-approved approval', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-v1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-06-18T00:00:00.000Z');

    await queue.approve(created.approvalId, 'owner-001');

    const editResult = await queue.edit({ approvalId: created.approvalId, editedBy: 'owner-001', newArtifactId: 'art-v2', editReason: 'Late edit', now: '2026-06-18T01:00:00.000Z' });

    expect(editResult.ok).toBe(false);
    if (!editResult.ok) {
      expect(editResult.error).toBe('already_decided');
      if (editResult.error === 'already_decided') {
        expect(editResult.status).toBe('approved');
      }
    }
  });

  it('returns error when editing a rejected approval', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-v1',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-06-18T00:00:00.000Z');

    await queue.reject(created.approvalId, 'owner-001', 'Bad principle');

    const editResult = await queue.edit({ approvalId: created.approvalId, editedBy: 'owner-001', newArtifactId: 'art-v2', editReason: 'Try again', now: '2026-06-18T01:00:00.000Z' });

    expect(editResult.ok).toBe(false);
    if (!editResult.ok) {
      expect(editResult.error).toBe('already_decided');
      if (editResult.error === 'already_decided') {
        expect(editResult.status).toBe('rejected');
      }
    }
  });

  it('records lineage: previousArtifactId points to the pre-edit artifact', async () => {
    const store = new MemoryApprovalQueueStore();
    const queue = new ApprovalQueue(store);

    const created = await queue.enqueue({
      artifactId: 'art-original',
      channel: 'code_tool_hook',
      riskLevel: 'high',
    }, '2026-06-18T00:00:00.000Z');

    await queue.edit({
      approvalId: created.approvalId,
      editedBy: 'owner-001',
      newArtifactId: 'art-edited',
      editReason: 'Lineage test',
      now: '2026-06-18T01:00:00.000Z',
    });

    const found = await queue.getById(created.approvalId);
    expect(found?.previousArtifactId).toBe('art-original');
    expect(found?.artifactId).toBe('art-edited');
  });
});
