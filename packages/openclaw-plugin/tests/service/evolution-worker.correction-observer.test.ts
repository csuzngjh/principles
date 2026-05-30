import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { ConfigService } from '../../src/core/config-service.js';

// Shared mocks
const mockLearner = {
  getStore: vi.fn(() => ({ keywords: [{ term: 'wrong', weight: 0.5 }] })),
};

const mockDb = {
  listRecentSessions: vi.fn(() => [{ sessionId: 'session-1' }]),
  listUserTurnsForSession: vi.fn(() => [{ rawExcerpt: 'User said wrong input', correctionDetected: true, correctionCue: 'wrong' }]),
};

const mockOptimizationService = {
  buildTrajectoryHistory: vi.fn(async () => [
    { sessionId: 'session-1', timestamp: 'now', term: 'wrong', userMessage: '' }
  ]),
  applyResult: vi.fn(),
};

// Mock dependencies
vi.mock('../../src/core/correction-cue-learner.js', () => ({
  CorrectionCueLearner: { get: vi.fn(() => mockLearner) },
}));

vi.mock('../../src/core/trajectory.js', () => ({
  TrajectoryRegistry: {
    get: vi.fn(() => mockDb),
    clear: vi.fn(),
  },
}));

vi.mock('../../src/service/keyword-optimization-service.js', () => ({
  KeywordOptimizationService: { get: vi.fn(() => mockOptimizationService) },
}));

// Mock principles-core runtime-v2 observer/scheduler classes
const mockDispatch = vi.fn().mockResolvedValue({
  updated: true,
  summary: 'Keyword store optimized',
  updates: { wrong: { action: 'update', weight: 0.4, reasoning: 'slightly high FP' } }
});

const mockRegister = vi.fn();

vi.mock('@principles/core/runtime-v2', () => {
  return {
    WorkflowFunnelLoader: class {
      getFunnel = vi.fn(() => ({
        policy: {
          runtimeKind: 'pi-ai',
          provider: 'anthropic',
          model: 'anthropic/claude-3-5-sonnet',
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          timeoutMs: 30000,
        }
      }));
    },
    PiAiRuntimeAdapter: class {},
    CorrectionObserver: class {},
    AgentScheduler: class {
      register = mockRegister;
      dispatch = mockDispatch;
    }
  };
});

// Import EvolutionWorkerService
import { EvolutionWorkerService } from '../../src/service/evolution-worker.js';
import { safeRmDir } from '../test-utils.js';

function createMockApi() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime: {
      agent: { runEmbeddedPiAgent: vi.fn() },
      system: {
        requestHeartbeatNow: vi.fn(),
        runHeartbeatOnce: vi.fn(),
      },
    },
  } as any;
}

const fastPollConfig = { get: (k: string) => k === 'intervals.worker_poll_ms' ? 1000 : undefined };

describe('EvolutionWorkerService Correction Observer Integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    EvolutionWorkerService.api = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    EvolutionWorkerService.api = null;
  });

  it('runs Correction Observer on heartbeat and applies updates when configured', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-worker-corr-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Initialize an empty queue to avoid processing actual queue items
    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([], null, 2),
      'utf8'
    );

    // Initialize pain settings with fast poll interval
    fs.writeFileSync(
      path.join(stateDir, 'pain_settings.json'),
      JSON.stringify({
        intervals: {
          worker_poll_ms: 1000
        }
      }, null, 2),
      'utf8'
    );

    // Invalidate workspace cache to load the newly written settings
    WorkspaceContext.clearCache();
    ConfigService.reset();

    const mockApi = createMockApi();
    EvolutionWorkerService.api = mockApi;

    try {
      EvolutionWorkerService.start({
        workspaceDir,
        stateDir,
        logger: mockApi.logger,
        config: fastPollConfig,
        api: mockApi,
      } as any);

      // 1. Advance to startup timer (5000ms) and wait for microtasks to settle
      await vi.advanceTimersByTimeAsync(5000);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }

      // 2. Advance past the poll interval (1000ms) to trigger runCycle
      await vi.advanceTimersByTimeAsync(1050);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }

      // Verify that the scheduler dispatch was called with correct payload
      expect(mockRegister).toHaveBeenCalled();
      expect(mockDispatch).toHaveBeenCalledWith('correction-observer', expect.objectContaining({
        parentSessionId: 'evolution-worker',
        workspaceDir,
        recentMessages: ['User said wrong input'],
      }));

      // Verify updates were applied using KeywordOptimizationService
      expect(mockOptimizationService.applyResult).toHaveBeenCalledWith(expect.objectContaining({
        updated: true,
        summary: 'Keyword store optimized',
      }));

    } finally {
      EvolutionWorkerService.stop!({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });
});
