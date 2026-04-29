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

const { mockGetNocturnalSessionSnapshot, mockListRecentNocturnalCandidateSessions } = vi.hoisted(() => ({
  mockGetNocturnalSessionSnapshot: vi.fn(),
  mockListRecentNocturnalCandidateSessions: vi.fn(() => []),
}));

vi.mock('../../src/core/nocturnal-trajectory-extractor.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/nocturnal-trajectory-extractor.js')>(
    '../../src/core/nocturnal-trajectory-extractor.js'
  );
  return {
    ...actual,
    createNocturnalTrajectoryExtractor: vi.fn(() => ({
      getNocturnalSessionSnapshot: mockGetNocturnalSessionSnapshot,
      listRecentNocturnalCandidateSessions: mockListRecentNocturnalCandidateSessions,
    })),
  };
});

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

// Poll every 100ms for fast test execution
const fastPollConfig = { get: (k: string) => k === 'intervals.worker_poll_ms' ? 100 : undefined };

function readQueue(stateDir: string) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
}

describe('EvolutionWorkerService timeout mechanisms', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    EvolutionWorkerService.api = null;
  });

  afterEach(() => {
    vi.useRealTimers();
    EvolutionWorkerService.api = null;
  });

  // ── Pain diagnosis timeout (30 min) ──

          // TODO: Fix - task status not transitioning correctly in test
          it.skip('times out pain_diagnosis task after 30 minutes → resolution = diagnostician_timeout', async () => {    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-timeout-pain-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Create an in_progress pain_diagnosis task that started 31 minutes ago
    const startedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([
        {
          id: 'timeout-test-30min',
          taskKind: 'pain_diagnosis',
          priority: 'high',
          score: 90,
          source: 'tool_failure',
          reason: 'Test timeout mechanism',
          timestamp: startedAt,
          enqueued_at: startedAt,
          status: 'in_progress',
          session_id: 'test',
          agent_id: 'main',
          started_at: startedAt,
          assigned_session_key: 'heartbeat:diagnostician:timeout-test-30min',
          retryCount: 0,
          maxRetries: 3,
          task: 'Diagnose systemic pain [ID: timeout-test-30min]',
        },
      ], null, 2),
      'utf8'
    );

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

      // Wait for the worker to process
      await vi.advanceTimersByTimeAsync(5000);

      const queue = readQueue(stateDir);
      const task = queue.find((t: any) => t.id === 'timeout-test-30min');

      expect(task.status).toBe('completed');
      expect(task.resolution).toBe('diagnostician_timeout');
      expect(task.completed_at).toBeDefined();
    } finally {
      EvolutionWorkerService.stop!({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });

  it('drops legacy pain_diagnosis tasks instead of timing them out', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-no-timeout-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Runtime v2 owns pain diagnosis. EvolutionWorker should not keep or
    // timeout legacy pain_diagnosis queue items.
    const startedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([
        {
          id: 'no-timeout-10min',
          taskKind: 'pain_diagnosis',
          priority: 'high',
          score: 80,
          source: 'human_intervention',
          reason: 'Should not timeout yet',
          timestamp: startedAt,
          enqueued_at: startedAt,
          status: 'in_progress',
          session_id: 'test',
          agent_id: 'main',
          started_at: startedAt,
          assigned_session_key: 'heartbeat:diagnostician:no-timeout-10min',
          retryCount: 0,
          maxRetries: 3,
          task: 'Diagnose systemic pain [ID: no-timeout-10min]',
        },
      ], null, 2),
      'utf8'
    );

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

      await vi.advanceTimersByTimeAsync(5000);

      const queue = readQueue(stateDir);
      const task = queue.find((t: any) => t.id === 'no-timeout-10min');

      expect(task).toBeUndefined();
    } finally {
      EvolutionWorkerService.stop!({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });

  // ── Sleep reflection timeout (60 min default) ──

  it('times out sleep_reflection task after 60 minutes → resolution = failed_max_retries', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-timeout-sleep-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    // Create an in_progress sleep_reflection task that started 61 minutes ago
    const startedAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([
        {
          id: 'sleep-timeout-60min',
          taskKind: 'sleep_reflection',
          priority: 'medium',
          score: 50,
          source: 'nocturnal',
          reason: 'Test sleep reflection timeout',
          timestamp: startedAt,
          enqueued_at: startedAt,
          status: 'in_progress',
          session_id: 'test',
          agent_id: 'main',
          started_at: startedAt,
          resultRef: 'wf-sleep-timeout',
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

    mockStartWorkflow.mockResolvedValue({
      workflowId: 'wf-sleep-timeout',
      childSessionKey: 'child-sleep',
      state: 'terminal_error',
    });
    mockGetWorkflowDebugSummary.mockResolvedValue({
      state: 'terminal_error',
      metadata: {},
      recentEvents: [{ reason: 'Test: simulating stuck sleep reflection', payload: {} }],
    });

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

      await vi.advanceTimersByTimeAsync(5000);

      const queue = readQueue(stateDir);
      const task = queue.find((t: any) => t.id === 'sleep-timeout-60min');

      expect(task.status).toBe('failed');
      expect(task.resolution).toBe('failed_max_retries');
      expect(task.completed_at).toBeDefined();
    } finally {
      EvolutionWorkerService.stop!({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });

  // ── Report file cleanup on timeout ──

  // TODO: Fix - report file not being cleaned up in test
  it.skip('cleans up .diagnostician_report_*.json file on pain_diagnosis timeout', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-timeout-cleanup-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    // Create a stale diagnostician report file
    const reportPath = path.join(stateDir, '.diagnostician_report_timeout-cleanup.json');
    fs.writeFileSync(reportPath, JSON.stringify({ test: 'stale report' }), 'utf8');
    expect(fs.existsSync(reportPath)).toBe(true);

    // Create an in_progress pain_diagnosis task that started 31 minutes ago
    const startedAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([
        {
          id: 'timeout-cleanup',
          taskKind: 'pain_diagnosis',
          priority: 'high',
          score: 70,
          source: 'tool_failure',
          reason: 'Test report cleanup on timeout',
          timestamp: startedAt,
          enqueued_at: startedAt,
          status: 'in_progress',
          session_id: 'test',
          agent_id: 'main',
          started_at: startedAt,
          assigned_session_key: 'heartbeat:diagnostician:timeout-cleanup',
          retryCount: 0,
          maxRetries: 3,
          task: 'Diagnose systemic pain [ID: timeout-cleanup]',
        },
      ], null, 2),
      'utf8'
    );

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

      await vi.advanceTimersByTimeAsync(5000);

      // Verify the report file was cleaned up
      expect(fs.existsSync(reportPath)).toBe(false);

      // Verify the task was marked as completed with timeout resolution
      const queue = readQueue(stateDir);
      const task = queue.find((t: any) => t.id === 'timeout-cleanup');
      expect(task.status).toBe('completed');
      expect(task.resolution).toBe('diagnostician_timeout');
    } finally {
      EvolutionWorkerService.stop!({ workspaceDir, stateDir, logger: console } as any);
      safeRmDir(workspaceDir);
    }
  });
});
