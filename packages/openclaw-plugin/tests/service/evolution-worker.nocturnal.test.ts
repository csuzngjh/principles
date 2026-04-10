import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../src/core/dictionary-service.js', () => ({
  DictionaryService: {
    get: vi.fn(() => ({ flush: vi.fn() })),
  },
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  initPersistence: vi.fn(),
  flushAllSessions: vi.fn(),
  listSessions: vi.fn(() => []),
}));

const { mockStartWorkflow, mockGetWorkflowDebugSummary } = vi.hoisted(() => ({
  mockStartWorkflow: vi.fn(),
  mockGetWorkflowDebugSummary: vi.fn(),
}));

vi.mock('../../src/service/subagent-workflow/nocturnal-workflow-manager.js', () => ({
  NocturnalWorkflowManager: class {
    startWorkflow = mockStartWorkflow;
    getWorkflowDebugSummary = mockGetWorkflowDebugSummary;
  },
  nocturnalWorkflowSpec: {
    workflowType: 'nocturnal',
    transport: 'runtime_direct',
    timeoutMs: 15 * 60 * 1000,
    ttlMs: 30 * 60 * 1000,
  },
}));

const { mockGetNocturnalSessionSnapshot } = vi.hoisted(() => ({
  mockGetNocturnalSessionSnapshot: vi.fn(),
}));
vi.mock('../../src/core/nocturnal-trajectory-extractor.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/nocturnal-trajectory-extractor.js')>(
    '../../src/core/nocturnal-trajectory-extractor.js'
  );
  return {
    ...actual,
    createNocturnalTrajectoryExtractor: vi.fn(() => ({
      getNocturnalSessionSnapshot: mockGetNocturnalSessionSnapshot,
    })),
  };
});

import { EvolutionWorkerService } from '../../src/service/evolution-worker.js';
import { safeRmDir } from '../test-utils.js';

function readQueue(stateDir: string) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
}

describe('EvolutionWorkerService nocturnal hardening', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    EvolutionWorkerService.api = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    EvolutionWorkerService.api = null;
  });

  it('does not start a nocturnal workflow when only an empty fallback snapshot is available', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-empty-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    mockGetNocturnalSessionSnapshot.mockReturnValue(null);

    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([
        {
          id: 'sleep-empty',
          taskKind: 'sleep_reflection',
          priority: 'medium',
          score: 50,
          source: 'nocturnal',
          reason: 'Sleep reflection',
          timestamp: '2026-04-10T00:00:00.000Z',
          enqueued_at: '2026-04-10T00:00:00.000Z',
          status: 'pending',
          retryCount: 0,
          maxRetries: 1,
          recentPainContext: {
            mostRecent: null,
            recentPainCount: 0,
            recentMaxPainScore: 0,
          },
        },
      ], null, 2),
      'utf8'
    );

    try {
      EvolutionWorkerService.start({
        workspaceDir,
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        config: {},
      } as any);

      await vi.advanceTimersByTimeAsync(6000);

      const queue = readQueue(stateDir);
      expect(queue[0].status).toBe('failed');
      expect(queue[0].lastError).toContain('missing_usable_snapshot');
      expect(queue[0].resultRef).toBeFalsy();
      expect(mockStartWorkflow).not.toHaveBeenCalled();
    } finally {
      EvolutionWorkerService.stop({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });

  it('keeps gateway-only background failures as failed instead of completed stub fallback', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-nocturnal-gateway-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    mockGetNocturnalSessionSnapshot.mockReturnValue({
      sessionId: 'sleep-gateway',
      startedAt: '2026-04-10T00:00:00.000Z',
      updatedAt: '2026-04-10T00:01:00.000Z',
      assistantTurns: [],
      userTurns: [],
      toolCalls: [],
      painEvents: [],
      gateBlocks: [],
      stats: {
        totalAssistantTurns: 1,
        totalToolCalls: 1,
        totalPainEvents: 0,
        totalGateBlocks: 0,
        failureCount: 0,
      },
    });
    mockStartWorkflow.mockResolvedValue({ workflowId: 'wf-1', childSessionKey: 'child-1', state: 'active' });
    mockGetWorkflowDebugSummary.mockResolvedValue({
      state: 'terminal_error',
      metadata: {},
      recentEvents: [
        {
          reason: 'Error: Plugin runtime subagent methods are only available during a gateway request.',
          payload: {},
        },
      ],
    });

    EvolutionWorkerService.api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {
        subagent: {
          run: vi.fn().mockRejectedValue(new Error("gateway request failed (subagent error)")),
        },
      },
    } as any;

    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([
        {
          id: 'sleep-gateway',
          taskKind: 'sleep_reflection',
          priority: 'medium',
          score: 50,
          source: 'nocturnal',
          reason: 'Sleep reflection',
          timestamp: '2026-04-10T00:00:00.000Z',
          enqueued_at: '2026-04-10T00:00:00.000Z',
          status: 'pending',
          retryCount: 0,
          maxRetries: 1,
          recentPainContext: {
            mostRecent: { score: 0.5, source: 'pain', reason: 'x', timestamp: '2026-04-10T00:00:00.000Z' },
            recentPainCount: 1,
            recentMaxPainScore: 0.5,
          },
        },
      ], null, 2),
      'utf8'
    );

    try {
      EvolutionWorkerService.start({
        workspaceDir,
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        config: {},
      } as any);

      await vi.advanceTimersByTimeAsync(6000);

      const queue = readQueue(stateDir);
      expect(queue[0].status).toBe('failed');
      expect(queue[0].resolution).toBe('failed_max_retries');
      expect(queue[0].lastError).toContain('gateway request');
    } finally {
      EvolutionWorkerService.stop({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });
});
