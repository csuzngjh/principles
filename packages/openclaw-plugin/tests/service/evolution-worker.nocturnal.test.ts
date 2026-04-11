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

import { EvolutionWorkerService, readRecentPainContext } from '../../src/service/evolution-worker.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
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
      runtime: {},
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

  it('extracts session_id from .pain_flag file correctly', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-session-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Write a pain flag WITH session_id
    fs.writeFileSync(
      path.join(stateDir, '.pain_flag'),
      `source: test_pain
score: 80
reason: test reason
time: 2026-04-10T00:00:00.000Z
session_id: explicit-session-from-pain
`,
      'utf8'
    );

    // Create a WorkspaceContext to test the function
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, stateDir, logger: console } as any);

    try {
      const context = readRecentPainContext(wctx);
      
      // Verify the session_id was extracted from the pain flag file
      expect(context.mostRecent).toBeDefined();
      expect(context.mostRecent.sessionId).toBe('explicit-session-from-pain');
      expect(context.mostRecent.score).toBe(80);
      expect(context.recentPainCount).toBe(1);
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  it('treats malformed pain flag data as unusable context', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-invalid-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    fs.writeFileSync(
      path.join(stateDir, '.pain_flag'),
      `source: test_pain
score: 80`,
      'utf8'
    );

    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, stateDir, logger: console } as any);

    try {
      const context = readRecentPainContext(wctx);
      expect(context.mostRecent).toBeNull();
      expect(context.recentPainCount).toBe(0);
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  it('prioritizes pain signal session ID for snapshot extraction', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-pain-priority-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Mock extractor to succeed ONLY for the pain session ID
    mockGetNocturnalSessionSnapshot.mockImplementation((sessionId: string) => {
      if (sessionId === 'pain-session-id') {
        return {
          sessionId: 'pain-session-id',
          startedAt: '2026-04-10T00:00:00.000Z',
          stats: { totalToolCalls: 10, totalAssistantTurns: 5, failureCount: 2 },
          painEvents: [],
          gateBlocks: [],
        };
      }
      return null;
    });

    mockStartWorkflow.mockResolvedValue({ workflowId: 'wf-1', childSessionKey: 'child-1', state: 'active' });
    mockGetWorkflowDebugSummary.mockResolvedValue({ state: 'active', metadata: {} });

    EvolutionWorkerService.api = {
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      runtime: {},
    } as any;

    // Create a queue with a task that HAS a pain session ID
    const taskWithPainSession = {
      id: 'task-with-pain',
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
        mostRecent: { sessionId: 'pain-session-id', score: 80, source: 'test', reason: 'r', timestamp: 't' },
        recentPainCount: 1,
        recentMaxPainScore: 80,
      },
    };

    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([taskWithPainSession]),
      'utf8'
    );

    try {
      EvolutionWorkerService.start({
        workspaceDir,
        stateDir,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        config: { get: () => 15000 },
      } as any);

      // Advance time to process the pending task
      await vi.advanceTimersByTimeAsync(6000);

      // Verify the extractor was called with the pain session ID first
      expect(mockGetNocturnalSessionSnapshot).toHaveBeenCalledWith('pain-session-id');
      
      // Verify workflow started (meaning snapshot was found via pain session ID)
      expect(mockStartWorkflow).toHaveBeenCalled();

      // Verify task status updated
      const queue = readQueue(stateDir);
      expect(queue[0].status).toBe('in_progress');
      expect(queue[0].resultRef).toBe('wf-1');

    } finally {
      EvolutionWorkerService.stop({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });
});
