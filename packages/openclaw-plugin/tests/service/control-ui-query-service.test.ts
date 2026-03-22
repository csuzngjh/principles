import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlUiQueryService } from '../../src/service/control-ui-query-service.js';

const mocks = vi.hoisted(() => ({
  fromHookContext: vi.fn(),
  clearCache: vi.fn(),
  controlUiDb: {
    all: vi.fn(),
    get: vi.fn(),
    dispose: vi.fn(),
  },
  trajectory: {
    getDataStats: vi.fn(),
  },
}));

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: mocks.fromHookContext,
    clearCache: mocks.clearCache,
  },
}));

vi.mock('../../src/core/control-ui-db.js', () => ({
  ControlUiDatabase: class {
    constructor() {
      return mocks.controlUiDb as any;
    }
  },
}));

describe('ControlUiQueryService', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for unknown thinking models', () => {
    mocks.fromHookContext.mockReturnValue({ trajectory: mocks.trajectory } as any);
    const service = new ControlUiQueryService('/mock/workspace');

    expect(service.getThinkingModelDetail('UNKNOWN')).toBeNull();
    service.dispose();
  });

  it('labels overview responses as trajectory analytics rather than runtime control state', () => {
    mocks.fromHookContext.mockReturnValue({ trajectory: mocks.trajectory } as any);
    mocks.trajectory.getDataStats.mockReturnValue({
      dbPath: '/mock/trajectory.db',
      dbSizeBytes: 0,
      assistantTurns: 0,
      userTurns: 0,
      toolCalls: 0,
      painEvents: 0,
      pendingSamples: 0,
      approvedSamples: 0,
      blobBytes: 0,
      lastIngestAt: null,
    });
    mocks.controlUiDb.get.mockImplementation((sql: string) => {
      if (sql.includes('FROM gate_blocks')) return { count: 0 };
      if (sql.includes('FROM task_outcomes')) return { count: 0 };
      return { count: 0 };
    });
    mocks.controlUiDb.all.mockImplementation((sql: string) => {
      if (sql.includes('v_error_clusters')) return [];
      if (sql.includes('v_sample_queue')) return [];
      if (sql.includes('correction_samples')) return [];
      if (sql.includes('v_thinking_model_effectiveness')) return [];
      if (sql.includes('v_thinking_model_daily_trend')) return [];
      if (sql.includes('v_thinking_model_scenarios')) return [];
      return [];
    });
    const service = new ControlUiQueryService('/mock/workspace');
    const overview = service.getOverview();

    expect(overview.dataSource).toBe('trajectory_db_analytics');
    expect(overview.runtimeControlPlaneSource).toBe('pd_evolution_status');
    expect(overview.summary.gateBlocks).toBe(0);
    expect(overview.summary.taskOutcomes).toBe(0);
    service.dispose();
  });

  it('surfaces gate block and task outcome counts from trajectory analytics', () => {
    mocks.fromHookContext.mockReturnValue({ trajectory: mocks.trajectory } as any);
    mocks.trajectory.getDataStats.mockReturnValue({
      dbPath: '/mock/trajectory.db',
      dbSizeBytes: 0,
      assistantTurns: 0,
      userTurns: 0,
      toolCalls: 0,
      painEvents: 0,
      pendingSamples: 0,
      approvedSamples: 0,
      blobBytes: 0,
      lastIngestAt: null,
    });
    mocks.controlUiDb.get.mockImplementation((sql: string) => {
      if (sql.includes('FROM gate_blocks')) return { count: 1 };
      if (sql.includes('FROM task_outcomes')) return { count: 1 };
      return { count: 0 };
    });
    mocks.controlUiDb.all.mockImplementation((sql: string) => {
      if (sql.includes('v_error_clusters')) return [];
      if (sql.includes('v_sample_queue')) return [];
      if (sql.includes('correction_samples')) return [];
      if (sql.includes('v_thinking_model_effectiveness')) return [];
      if (sql.includes('v_thinking_model_daily_trend')) return [];
      if (sql.includes('v_thinking_model_scenarios')) return [];
      return [];
    });
    const service = new ControlUiQueryService('/mock/workspace');
    const overview = service.getOverview();

    expect(overview.summary.gateBlocks).toBe(1);
    expect(overview.summary.taskOutcomes).toBe(1);
    expect(overview.dataSource).toBe('trajectory_db_analytics');
    expect(overview.runtimeControlPlaneSource).toBe('pd_evolution_status');

    service.dispose();
  });
});
