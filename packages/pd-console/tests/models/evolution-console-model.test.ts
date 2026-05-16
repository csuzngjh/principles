import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolutionConsoleModel } from '../../src/server/models/EvolutionConsoleModel.js';
import { createTestWorkspace, cleanupTestWorkspace, sampleTrainingState } from '../test-utils.js';
import type { TestWorkspace } from '../test-utils.js';

describe('EvolutionConsoleModel with real runtime-v2 data', () => {
  let ws: TestWorkspace | null = null;
  let model: EvolutionConsoleModel | null = null;

  beforeEach(async () => {
    ws = await createTestWorkspace({
      tasks: [
        { taskId: 'task-1', taskKind: 'diagnostician', status: 'succeeded' },
        { taskId: 'task-2', taskKind: 'dreamer', status: 'pending' },
        { taskId: 'task-3', taskKind: 'diagnostician', status: 'failed' },
        { taskId: 'task-4', taskKind: 'dreamer', status: 'leased' },
      ],
      candidates: [],
      principles: [
        { id: 'p-active', status: 'active', text: 'Active', triggerPattern: 't1', action: 'a1' },
        { id: 'p-probation', status: 'probation', text: 'Probation', triggerPattern: 't2', action: 'a2' },
      ],
      trainingState: {
        _tree: {
          principles: {
            'p-active': {
              id: 'p-active',
              status: 'active',
              text: 'Active principle text',
              triggerPattern: 'on-error',
              action: 'analyze and fix',
              evaluability: 'deterministic',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-05-01T00:00:00Z',
            },
            'p-probation': {
              id: 'p-probation',
              status: 'probation',
              text: 'Probation principle text',
              triggerPattern: 'on-ambiguity',
              action: 'ask user',
              evaluability: 'weak_heuristic',
              createdAt: '2026-04-01T00:00:00Z',
              updatedAt: '2026-05-10T00:00:00Z',
            },
          },
        },
      },
    });
    model = new EvolutionConsoleModel(ws.workspaceDir);
  });

  afterEach(() => {
    model?.dispose();
    if (ws) cleanupTestWorkspace(ws);
  });

  it('getStats returns correct task counts from RuntimeStateManager', async () => {
    const stats = await model.getStats();

    expect(stats.total).toBe(4);
    expect(stats.completed).toBe(1);
    expect(stats.pending).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.inProgress).toBe(1);
  });

  it('getStats returns stage distribution', async () => {
    const stats = await model.getStats();

    expect(stats.stageDistribution.length).toBeGreaterThan(0);
    const succeededStage = stats.stageDistribution.find(s => s.stage === 'succeeded');
    expect(succeededStage?.count).toBe(1);
  });

  it('getTasks returns all tasks', async () => {
    const result = await model.getTasks();

    expect(result.items.length).toBe(4);
    expect(result.pagination.total).toBe(4);
  });

  it('getTasks filters by status', async () => {
    const result = await model.getTasks({ status: 'succeeded' });

    expect(result.items.length).toBe(1);
    expect(result.items[0].status).toBe('succeeded');
  });

  it('getTasks filters by taskKind', async () => {
    const result = await model.getTasks({ taskKind: 'diagnostician' });

    expect(result.items.length).toBe(2);
    expect(result.items.every(t => t.taskKind === 'diagnostician')).toBe(true);
  });

  it('getTasks paginates correctly', async () => {
    const page1 = await model.getTasks({ page: 1, pageSize: 2 });
    expect(page1.items.length).toBe(2);
    expect(page1.pagination.totalPages).toBe(2);

    const page2 = await model.getTasks({ page: 2, pageSize: 2 });
    expect(page2.items.length).toBe(2);
  });

  it('getPrinciples reads training state file', async () => {
    const result = await model.getPrinciples();

    expect(result.summary.total).toBe(2);
    expect(result.summary.active).toBe(1);
    expect(result.summary.probation).toBe(1);
  });

  it('getPrinciples returns recent transitions', async () => {
    const result = await model.getPrinciples();

    expect(result.recent.length).toBe(2);
    expect(result.recent[0].principleId).toBeDefined();
    expect(result.recent[0].text).toBeDefined();
  });

  it('getQueueHealth returns data from InternalizationQueueReadModel', async () => {
    const health = await model.getQueueHealth();

    expect(typeof health.pendingCount).toBe('number');
    expect(typeof health.retryWaitCount).toBe('number');
    expect(typeof health.readyTaskCount).toBe('number');
    expect(typeof health.countsByTaskKind).toBe('object');
  });

  it('handles empty workspace gracefully', async () => {
    const emptyWs = await createTestWorkspace();
    const emptyModel = new EvolutionConsoleModel(emptyWs.workspaceDir);

    try {
      const stats = await emptyModel.getStats();
      expect(stats.total).toBe(0);

      const principles = await emptyModel.getPrinciples();
      expect(principles.summary.total).toBe(0);

      const health = await emptyModel.getQueueHealth();
      expect(typeof health.pendingCount).toBe('number');
    } finally {
      emptyModel.dispose();
      cleanupTestWorkspace(emptyWs);
    }
  });
});
