import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OverviewConsoleModel } from '../../src/server/models/OverviewConsoleModel.js';
import { createTestWorkspace, cleanupTestWorkspace, sampleTrainingState } from '../test-utils.js';
import type { TestWorkspace } from '../test-utils.js';

describe('OverviewConsoleModel with real runtime-v2 data', () => {
  let ws: TestWorkspace | null = null;
  let model: OverviewConsoleModel | null = null;

  beforeEach(async () => {
    ws = await createTestWorkspace({
      tasks: [
        { taskId: 'task-1', taskKind: 'diagnostician', status: 'succeeded' },
        { taskId: 'task-2', taskKind: 'diagnostician', status: 'pending' },
        { taskId: 'task-3', taskKind: 'dreamer', status: 'failed' },
      ],
      candidates: [
        { candidateId: 'c-1', taskId: 'task-1', title: 'Test candidate', description: 'desc', status: 'pending' },
      ],
      principles: [
        { id: 'p-active', status: 'active', text: 'Active principle', triggerPattern: 'test', action: 'do something' },
        { id: 'p-candidate', status: 'candidate', text: 'Candidate principle', triggerPattern: 'test2', action: 'do else' },
      ],
      trainingState: sampleTrainingState(),
    });
    model = new OverviewConsoleModel(ws.workspaceDir);
  });

  afterEach(() => {
    model?.dispose();
    if (ws) cleanupTestWorkspace(ws);
  });

  it('getOverview returns correct structure with real data', async () => {
    const overview = await model.getOverview();

    expect(overview.workspaceDir).toBe(ws.workspaceDir);
    expect(overview.generatedAt).toBeTruthy();
    expect(typeof overview.dataFreshness).toBe('string');
    expect(['fresh', 'stale', 'error']).toContain(overview.dataFreshness);
  });

  it('getOverview populates health from OperatorHealthReadModel', async () => {
    const overview = await model.getOverview();

    expect(overview.health).toBeDefined();
    expect(['healthy', 'degraded', 'error']).toContain(overview.health.status);
    expect(typeof overview.health.gfi.current).toBe('number');
    expect(typeof overview.health.gfi.stage).toBe('string');
    expect(typeof overview.health.gfi.peakToday).toBe('number');
    expect(typeof overview.health.gfi.threshold).toBe('number');
  });

  it('getOverview populates principles from PruningReadModel', async () => {
    const overview = await model.getOverview();

    expect(typeof overview.health.principles.active).toBe('number');
    expect(typeof overview.health.principles.candidate).toBe('number');
    expect(typeof overview.health.principles.probation).toBe('number');
    expect(typeof overview.health.principles.deprecated).toBe('number');
  });

  it('getOverview populates queue from RuntimeStateManager', async () => {
    const overview = await model.getOverview();

    expect(typeof overview.health.queue.pending).toBe('number');
    expect(typeof overview.health.queue.completed).toBe('number');
    expect(overview.health.queue.completed).toBeGreaterThanOrEqual(0);
  });

  it('getOverview populates summary with real counts', async () => {
    const overview = await model.getOverview();

    expect(typeof overview.summary.principleEventCount).toBe('number');
    expect(typeof overview.summary.pendingSamples).toBe('number');
    expect(typeof overview.summary.approvedSamples).toBe('number');
    expect(typeof overview.summary.taskOutcomes).toBe('number');
    expect(overview.summary.taskOutcomes).toBeGreaterThanOrEqual(0);
  });

  it('getHealth returns same health data as getOverview', async () => {
    const overview = await model.getOverview();
    const health = await model.getHealth();

    expect(health.status).toBe(overview.health.status);
    expect(health.gfi.current).toBe(overview.health.gfi.current);
    expect(health.principles).toEqual(overview.health.principles);
  });

  it('handles empty workspace gracefully', async () => {
    const emptyWs = await createTestWorkspace();
    const emptyModel = new OverviewConsoleModel(emptyWs.workspaceDir);

    try {
      const overview = await emptyModel.getOverview();

      expect(overview.workspaceDir).toBe(emptyWs.workspaceDir);
      expect(overview.health.principles.active).toBe(0);
      expect(overview.health.principles.candidate).toBe(0);
      expect(overview.summary.taskOutcomes).toBeGreaterThanOrEqual(0);
    } finally {
      emptyModel.dispose();
      cleanupTestWorkspace(emptyWs);
    }
  });
});
