import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlUiQueryService } from '../../src/service/control-ui-query-service.js';
import { CentralOverviewService } from '../../src/service/central-overview-service.js';
import { HealthQueryService } from '../../src/service/health-query-service.js';

// ---------------------------------------------------------------------------
// Shared mock infrastructure
// ---------------------------------------------------------------------------

const trajectoryMock = vi.hoisted(() => ({
  getDataStats: vi.fn(() => ({
    dbPath: '/mock/trajectory.db',
    dbSizeBytes: 0,
    assistantTurns: 10,
    userTurns: 5,
    toolCalls: 20,
    painEvents: 2,
    pendingSamples: 1,
    approvedSamples: 0,
    blobBytes: 0,
    lastIngestAt: '2026-04-09T00:00:00Z',
  })),
  reviewCorrectionSample: vi.fn(),
  exportCorrections: vi.fn(),
  listEvolutionEvents: vi.fn(() => []),
}));

const configMock = vi.hoisted(() => ({
  get: vi.fn((key: string) => {
    if (key === 'gfi_gate.thresholds.low_risk_block') return 70;
    return null;
  }),
  has: vi.fn(() => false),
}));

const eventLogMock = vi.hoisted(() => ({
  getBufferedEvents: vi.fn(() => []),
}));

const evolutionReducerMock = vi.hoisted(() => ({
  getStats: vi.fn(() => ({
    candidateCount: 1,
    probationCount: 0,
    activeCount: 2,
    deprecatedCount: 0,
  })),
  getPrincipleById: vi.fn(() => null),
}));

const controlUiDbMock = vi.hoisted(() => ({
  all: vi.fn(() => []),
  get: vi.fn(() => null),
  run: vi.fn(),
  execute: vi.fn(),
  dispose: vi.fn(),
  restoreRawText: vi.fn((rawText: string | null) => rawText ?? ''),
}));

vi.mock('../../src/core/workspace-context.js', () => ({
  WorkspaceContext: {
    fromHookContext: vi.fn(() => ({
      workspaceDir: '/mock/workspace',
      stateDir: '/mock/workspace/.openclaw',
      trajectory: trajectoryMock,
      config: configMock,
      eventLog: eventLogMock,
      evolutionReducer: evolutionReducerMock,
    })),
    clearCache: vi.fn(),
  },
}));

vi.mock('../../src/core/control-ui-db.js', () => ({
  ControlUiDatabase: class {
    all = controlUiDbMock.all;
    get = controlUiDbMock.get;
    run = controlUiDbMock.run;
    execute = controlUiDbMock.execute;
    dispose = controlUiDbMock.dispose;
    restoreRawText = controlUiDbMock.restoreRawText;
  },
}));

vi.mock('../../src/core/event-log.js', () => ({
  EventLog: vi.fn(),
}));

vi.mock('../../src/core/trajectory.js', () => ({
  TrajectoryRegistry: {
    get: vi.fn(() => trajectoryMock),
  },
}));

// ---------------------------------------------------------------------------
// CentralDatabase mock for CentralOverviewService
// ---------------------------------------------------------------------------

const centralDbMethods = {
  getOverviewStats: vi.fn(() => ({
    totalToolCalls: 10,
    totalFailures: 1,
    totalCorrections: 0,
    totalThinkingEvents: 5,
    totalPainEvents: 1,
    pendingSamples: 1,
    approvedSamples: 0,
    rejectedSamples: 0,
    workspaceCount: 2,
    enabledWorkspaceCount: 2,
    workspaceNames: ['ws1', 'ws2'],
    enabledWorkspaceNames: ['ws1', 'ws2'],
  })),
  getDailyTrend: vi.fn(() => []),
  getTopRegressions: vi.fn(() => []),
  getThinkingModelStats: vi.fn(() => ({
    totalModels: 3,
    activeModels: 2,
    models: [],
  })),
  getSamplePreview: vi.fn(() => []),
  getMostRecentSync: vi.fn(() => '2026-04-09T00:00:00Z'),
  getTaskOutcomes: vi.fn(() => 0),
  getPrincipleEventCount: vi.fn(() => 0),
  getSampleCountersByStatus: vi.fn(() => ({})),
  dispose: vi.fn(),
};

vi.mock('../../src/service/central-database.js', () => ({
  getCentralDatabase: vi.fn(() => centralDbMethods),
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Data Endpoints Regression Tests', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===== Overview Page Tests =====

  describe('Overview Page - /api/overview', () => {
    it('getOverview returns correct response shape with all required fields', () => {
      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.getOverview(30);

      // Top-level fields from OverviewResponse
      expect(result).toHaveProperty('workspaceDir');
      expect(result).toHaveProperty('generatedAt');
      expect(result).toHaveProperty('dataFreshness');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('dailyTrend');
      expect(result).toHaveProperty('topRegressions');
      expect(result).toHaveProperty('sampleQueue');
      expect(result).toHaveProperty('thinkingSummary');

      // dataSource fields from ControlUiQueryService
      expect(result.dataSource).toBe('trajectory_db_analytics');
      expect(result.runtimeControlPlaneSource).toBe('pd_evolution_status');

      // Summary fields
      expect(result.summary).toHaveProperty('repeatErrorRate');
      expect(result.summary).toHaveProperty('userCorrectionRate');
      expect(result.summary).toHaveProperty('pendingSamples');
      expect(result.summary).toHaveProperty('approvedSamples');
      expect(result.summary).toHaveProperty('thinkingCoverageRate');
      expect(result.summary).toHaveProperty('painEvents');
      expect(result.summary).toHaveProperty('principleEventCount');
      expect(result.summary).toHaveProperty('gateBlocks');
      expect(result.summary).toHaveProperty('taskOutcomes');

      // SampleQueue structure
      expect(result.sampleQueue).toHaveProperty('counters');
      expect(result.sampleQueue).toHaveProperty('preview');
      expect(typeof result.sampleQueue.counters).toBe('object');

      // ThinkingSummary structure
      expect(result.thinkingSummary).toHaveProperty('activeModels');
      expect(result.thinkingSummary).toHaveProperty('dormantModels');
      expect(result.thinkingSummary).toHaveProperty('effectiveModels');
      expect(result.thinkingSummary).toHaveProperty('coverageRate');

      service.dispose();
    });

    it('getOverview returns array fields (dailyTrend, topRegressions, sampleQueue.preview) as arrays', () => {
      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.getOverview(30);

      expect(Array.isArray(result.dailyTrend)).toBe(true);
      expect(Array.isArray(result.topRegressions)).toBe(true);
      expect(Array.isArray(result.sampleQueue.preview)).toBe(true);

      service.dispose();
    });

    it('getOverview dailyTrend items have correct shape when populated', () => {
      controlUiDbMock.all.mockImplementation((sql: string) => {
        if (sql.includes('v_daily_metrics')) {
          return [
            { day: '2026-04-08', tool_calls: 10, failures: 1, user_corrections: 0, thinking_turns: 5 },
          ];
        }
        return [];
      });

      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.getOverview(30);

      if (result.dailyTrend.length > 0) {
        const item = result.dailyTrend[0];
        expect(item).toHaveProperty('day');
        expect(item).toHaveProperty('toolCalls');
        expect(item).toHaveProperty('failures');
        expect(item).toHaveProperty('userCorrections');
        expect(item).toHaveProperty('thinkingTurns');
        expect(typeof item.day).toBe('string');
        expect(typeof item.toolCalls).toBe('number');
      }

      service.dispose();
    });

    it('getOverview topRegressions items have correct shape when populated', () => {
      controlUiDbMock.all.mockImplementation((sql: string) => {
        if (sql.includes('v_error_clusters')) {
          return [{ tool_name: 'Read', error_type: 'file_not_found', occurrences: 3 }];
        }
        return [];
      });
      controlUiDbMock.get.mockImplementation((sql: string) => {
        if (sql.includes('gate_blocks')) return { count: 0 };
        if (sql.includes('task_outcomes')) return { count: 0 };
        if (sql.includes('user_turns')) return { count: 0 };
        if (sql.includes('principle_events')) return { count: 0 };
        return { count: 0 };
      });

      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.getOverview(30);

      if (result.topRegressions.length > 0) {
        const item = result.topRegressions[0];
        expect(item).toHaveProperty('toolName');
        expect(item).toHaveProperty('errorType');
        expect(item).toHaveProperty('occurrences');
        expect(typeof item.toolName).toBe('string');
        expect(typeof item.errorType).toBe('string');
        expect(typeof item.occurrences).toBe('number');
      }

      service.dispose();
    });
  });

  describe('Overview Page - /api/central/overview', () => {
    it('CentralOverviewService.getOverview returns correct response shape', () => {
      const service = new CentralOverviewService();
      const result = service.getOverview(30);

      // Top-level fields
      expect(result).toHaveProperty('workspaceDir');
      expect(result).toHaveProperty('generatedAt');
      expect(result).toHaveProperty('dataFreshness');
      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('dailyTrend');
      expect(result).toHaveProperty('topRegressions');
      expect(result).toHaveProperty('sampleQueue');
      expect(result).toHaveProperty('thinkingSummary');

      // Central-specific fields
      expect(result.dataSource).toBe('central_aggregated_db');
      expect(result.runtimeControlPlaneSource).toBe('all_workspaces');
      expect(result).toHaveProperty('centralInfo');

      // Summary structure matches OverviewResponse
      expect(result.summary).toHaveProperty('repeatErrorRate');
      expect(result.summary).toHaveProperty('userCorrectionRate');
      expect(result.summary).toHaveProperty('pendingSamples');
      expect(result.summary).toHaveProperty('approvedSamples');
      expect(result.summary).toHaveProperty('thinkingCoverageRate');
      expect(result.summary).toHaveProperty('painEvents');
      expect(result.summary).toHaveProperty('principleEventCount');
      expect(result.summary).toHaveProperty('gateBlocks');
      expect(result.summary).toHaveProperty('taskOutcomes');

      // centralInfo structure
      expect(result.centralInfo).toHaveProperty('workspaceCount');
      expect(result.centralInfo).toHaveProperty('enabledWorkspaceCount');
      expect(result.centralInfo).toHaveProperty('workspaces');
      expect(result.centralInfo).toHaveProperty('enabledWorkspaces');
      expect(Array.isArray(result.centralInfo.workspaces)).toBe(true);

      service.dispose();
    });
  });

  describe('Overview Page - /api/overview/health', () => {
    it('getOverviewHealth returns correct response shape', () => {
      const service = new HealthQueryService('/mock/workspace');
      const result = service.getOverviewHealth();

      // Top-level fields from OverviewHealthResponse
      expect(result).toHaveProperty('gfi');
      expect(result).toHaveProperty('trust');
      expect(result).toHaveProperty('evolution');
      expect(result).toHaveProperty('painFlag');
      expect(result).toHaveProperty('principles');
      expect(result).toHaveProperty('queue');
      expect(result).toHaveProperty('activeStage');

      // GFI structure
      expect(result.gfi).toHaveProperty('current');
      expect(result.gfi).toHaveProperty('peakToday');
      expect(result.gfi).toHaveProperty('threshold');
      expect(typeof result.gfi.current).toBe('number');
      expect(typeof result.gfi.peakToday).toBe('number');
      expect(typeof result.gfi.threshold).toBe('number');

      // Trust structure
      expect(result.trust).toHaveProperty('stage');
      expect(result.trust).toHaveProperty('stageLabel');
      expect(result.trust).toHaveProperty('score');
      expect(typeof result.trust.stage).toBe('number');
      expect(typeof result.trust.stageLabel).toBe('string');
      expect(typeof result.trust.score).toBe('number');

      // Evolution structure
      expect(result.evolution).toHaveProperty('tier');
      expect(result.evolution).toHaveProperty('points');
      expect(typeof result.evolution.tier).toBe('string');
      expect(typeof result.evolution.points).toBe('number');

      // PainFlag structure
      expect(result.painFlag).toHaveProperty('active');
      expect(result.painFlag).toHaveProperty('source');
      expect(result.painFlag).toHaveProperty('score');

      // Principles structure
      expect(result.principles).toHaveProperty('candidate');
      expect(result.principles).toHaveProperty('probation');
      expect(result.principles).toHaveProperty('active');
      expect(result.principles).toHaveProperty('deprecated');

      // Queue structure
      expect(result.queue).toHaveProperty('pending');
      expect(result.queue).toHaveProperty('inProgress');
      expect(result.queue).toHaveProperty('completed');

      service.dispose();
    });
  });

  // ===== Samples Page Tests =====

  describe('Samples Page - /api/samples', () => {
    it('listSamples returns correct response shape', () => {
      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.listSamples({});

      // Top-level fields
      expect(result).toHaveProperty('counters');
      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('pagination');

      // Counters is an object
      expect(typeof result.counters).toBe('object');

      // Items array
      expect(Array.isArray(result.items)).toBe(true);

      // Pagination fields
      expect(result.pagination).toHaveProperty('page');
      expect(result.pagination).toHaveProperty('pageSize');
      expect(result.pagination).toHaveProperty('total');
      expect(result.pagination).toHaveProperty('totalPages');
      expect(typeof result.pagination.page).toBe('number');
      expect(typeof result.pagination.pageSize).toBe('number');
      expect(typeof result.pagination.total).toBe('number');
      expect(typeof result.pagination.totalPages).toBe('number');

      service.dispose();
    });

    it('listSamples items have all required fields when populated', () => {
      controlUiDbMock.all.mockImplementation((sql: string) => {
        if (sql.includes('correction_samples')) {
          return [
            {
              sample_id: 'sample-1',
              session_id: 'session-1',
              review_status: 'pending',
              quality_score: 0.6,
              created_at: '2026-04-09T00:00:00Z',
              updated_at: '2026-04-09T00:00:00Z',
              diff_excerpt: '...',
              failure_mode: 'Read',
              related_thinking_count: 2,
            },
          ];
        }
        return [];
      });
      controlUiDbMock.get.mockReturnValue({ count: 1 });

      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.listSamples({ pageSize: 1 });

      if (result.items.length > 0) {
        const item = result.items[0];
        expect(item).toHaveProperty('sampleId');
        expect(item).toHaveProperty('sessionId');
        expect(item).toHaveProperty('reviewStatus');
        expect(item).toHaveProperty('qualityScore');
        expect(item).toHaveProperty('failureMode');
        expect(item).toHaveProperty('relatedThinkingCount');
        expect(item).toHaveProperty('createdAt');
        expect(item).toHaveProperty('updatedAt');
        expect(item).toHaveProperty('diffExcerpt');
        expect(typeof item.sampleId).toBe('string');
        expect(typeof item.sessionId).toBe('string');
        expect(typeof item.reviewStatus).toBe('string');
        expect(typeof item.qualityScore).toBe('number');
      }

      service.dispose();
    });
  });

  describe('Samples Page - /api/samples/:id', () => {
    it('getSampleDetail returns null for non-existent sample', () => {
      controlUiDbMock.get.mockReturnValue(null);

      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.getSampleDetail('non-existent-id');

      expect(result).toBeNull();
      service.dispose();
    });

    it('getSampleDetail returns correct shape when sample exists', () => {
      controlUiDbMock.get.mockImplementation((sql: string) => {
        if (sql.includes('correction_samples')) {
          return {
            sample_id: 'sample-1',
            session_id: 'session-1',
            review_status: 'pending',
            quality_score: 0.6,
            created_at: '2026-04-09T00:00:00Z',
            updated_at: '2026-04-09T00:00:00Z',
            recovery_tool_span_json: '[{"id":1,"toolName":"Read"}]',
            principle_ids_json: '[]',
            bad_turn_id: 1,
            bad_raw_text: null,
            bad_blob_ref: null,
            bad_sanitized_text: 'bad code',
            bad_created_at: '2026-04-09T00:00:00Z',
            user_turn_id: 2,
            user_raw_text: null,
            user_blob_ref: null,
            user_correction_cue: null,
            user_created_at: '2026-04-09T00:01:00Z',
          };
        }
        return null;
      });
      controlUiDbMock.all.mockReturnValue([]);

      const service = new ControlUiQueryService('/mock/workspace');
      const result = service.getSampleDetail('sample-1');

      expect(result).not.toBeNull();
      if (result) {
        expect(result).toHaveProperty('sampleId');
        expect(result).toHaveProperty('sessionId');
        expect(result).toHaveProperty('reviewStatus');
        expect(result).toHaveProperty('qualityScore');
        expect(result).toHaveProperty('createdAt');
        expect(result).toHaveProperty('updatedAt');
        expect(result).toHaveProperty('badAttempt');
        expect(result).toHaveProperty('userCorrection');
        expect(result).toHaveProperty('recoveryToolSpan');
        expect(result).toHaveProperty('relatedPrinciples');
        expect(result).toHaveProperty('relatedThinkingHits');
        expect(result).toHaveProperty('reviewHistory');

        // badAttempt structure
        expect(result.badAttempt).toHaveProperty('assistantTurnId');
        expect(result.badAttempt).toHaveProperty('rawText');
        expect(result.badAttempt).toHaveProperty('sanitizedText');
        expect(result.badAttempt).toHaveProperty('createdAt');

        // userCorrection structure
        expect(result.userCorrection).toHaveProperty('userTurnId');
        expect(result.userCorrection).toHaveProperty('rawText');
        expect(result.userCorrection).toHaveProperty('correctionCue');
        expect(result.userCorrection).toHaveProperty('createdAt');
      }

      service.dispose();
    });
  });
});
