import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SampleConsoleModel } from '../../src/server/models/SampleConsoleModel.js';
import { createTestWorkspace, cleanupTestWorkspace } from '../test-utils.js';
import type { TestWorkspace } from '../test-utils.js';

describe('SampleConsoleModel with real runtime-v2 data', () => {
  let ws: TestWorkspace | null = null;
  let model: SampleConsoleModel | null = null;

  beforeEach(async () => {
    ws = await createTestWorkspace({
      tasks: [
        { taskId: 'task-1', taskKind: 'diagnostician', status: 'succeeded' },
        { taskId: 'task-2', taskKind: 'dreamer', status: 'pending' },
      ],
      candidates: [
        {
          candidateId: 'c-pending',
          taskId: 'task-1',
          title: 'Pending candidate',
          description: 'A pending sample for review',
          status: 'pending',
        },
        {
          candidateId: 'c-consumed',
          taskId: 'task-1',
          title: 'Consumed candidate',
          description: 'An already approved sample',
          status: 'consumed',
        },
        {
          candidateId: 'c-expired',
          taskId: 'task-2',
          title: 'Expired candidate',
          description: 'A rejected sample',
          status: 'expired',
        },
      ],
      principles: [],
    });
    model = new SampleConsoleModel(ws.workspaceDir);
  });

  afterEach(() => {
    model?.dispose();
    if (ws) cleanupTestWorkspace(ws);
  });

  it('listSamples returns all candidates with correct review status mapping', async () => {
    const result = await model.listSamples();

    expect(result.items.length).toBe(3);
    expect(result.pagination.total).toBe(3);

    const pendingItem = result.items.find((i) => i.sampleId === 'c-pending');
    const consumedItem = result.items.find((i) => i.sampleId === 'c-consumed');
    const expiredItem = result.items.find((i) => i.sampleId === 'c-expired');

    expect(pendingItem?.reviewStatus).toBe('pending');
    expect(consumedItem?.reviewStatus).toBe('approved');
    expect(expiredItem?.reviewStatus).toBe('rejected');
  });

  it('listSamples filters by status', async () => {
    const pendingOnly = await model.listSamples({ status: 'pending' });
    expect(pendingOnly.items.length).toBe(1);
    expect(pendingOnly.items[0].reviewStatus).toBe('pending');

    const approvedOnly = await model.listSamples({ status: 'approved' });
    expect(approvedOnly.items.length).toBe(1);
    expect(approvedOnly.items[0].reviewStatus).toBe('approved');

    const rejectedOnly = await model.listSamples({ status: 'rejected' });
    expect(rejectedOnly.items.length).toBe(1);
    expect(rejectedOnly.items[0].reviewStatus).toBe('rejected');
  });

  it('listSamples populates counters correctly', async () => {
    const result = await model.listSamples();

    expect(result.counters.pending).toBe(1);
    expect(result.counters.approved).toBe(1);
    expect(result.counters.rejected).toBe(1);
  });

  it('listSamples paginates correctly', async () => {
    const page1 = await model.listSamples({ page: 1, pageSize: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.pagination.page).toBe(1);
    expect(page1.pagination.pageSize).toBe(2);
    expect(page1.pagination.totalPages).toBe(2);

    const page2 = await model.listSamples({ page: 2, pageSize: 2 });
    expect(page2.items.length).toBe(1);
    expect(page2.pagination.page).toBe(2);
  });

  it('getSampleDetail returns full candidate data', async () => {
    const detail = await model.getSampleDetail('c-pending');

    expect(detail).not.toBeNull();
    expect(detail!.sampleId).toBe('c-pending');
    expect(detail!.taskId).toBe('task-1');
    expect(detail!.title).toBe('Pending candidate');
    expect(detail!.description).toBe('A pending sample for review');
    expect(detail!.reviewStatus).toBe('pending');
    expect(typeof detail!.createdAt).toBe('string');
  });

  it('getSampleDetail returns null for unknown sample', async () => {
    const detail = await model.getSampleDetail('nonexistent');
    expect(detail).toBeNull();
  });

  it('reviewSample approves a pending candidate', async () => {
    const result = await model.reviewSample('c-pending', { decision: 'approved' });

    expect(result.success).toBe(true);
    expect(result.reviewStatus).toBe('approved');

    const detail = await model.getSampleDetail('c-pending');
    expect(detail!.reviewStatus).toBe('approved');
  });

  it('reviewSample rejects a pending candidate', async () => {
    const result = await model.reviewSample('c-pending', { decision: 'rejected' });

    expect(result.success).toBe(true);
    expect(result.reviewStatus).toBe('rejected');

    const detail = await model.getSampleDetail('c-pending');
    expect(detail!.reviewStatus).toBe('rejected');
  });

  it('reviewSample throws for non-pending candidate', async () => {
    await expect(
      model.reviewSample('c-consumed', { decision: 'approved' }),
    ).rejects.toThrow(/not pending/);

    await expect(
      model.reviewSample('c-expired', { decision: 'rejected' }),
    ).rejects.toThrow(/not pending/);
  });

  it('reviewSample throws for nonexistent candidate', async () => {
    await expect(
      model.reviewSample('nonexistent', { decision: 'approved' }),
    ).rejects.toThrow(/not found/);
  });

  it('handles empty workspace gracefully', async () => {
    const emptyWs = await createTestWorkspace();
    const emptyModel = new SampleConsoleModel(emptyWs.workspaceDir);

    try {
      const result = await emptyModel.listSamples();
      expect(result.items.length).toBe(0);
      expect(result.pagination.total).toBe(0);
    } finally {
      emptyModel.dispose();
      cleanupTestWorkspace(emptyWs);
    }
  });
});
