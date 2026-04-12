import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const { mockStartWorkflow, mockGetWorkflowDebugSummary } = vi.hoisted(() => ({
  mockStartWorkflow: vi.fn(),
  mockGetWorkflowDebugSummary: vi.fn(),
}));

vi.mock('../../src/service/subagent-workflow/nocturnal-workflow-manager.js', () => ({
  NocturnalWorkflowManager: class {
    startWorkflow = mockStartWorkflow;
    getWorkflowDebugSummary = mockGetWorkflowDebugSummary;
    dispose() {}
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

import { EvolutionTaskDispatcher } from '../../src/service/evolution-task-dispatcher.js';
import { EvolutionQueueStore } from '../../src/service/evolution-queue-store.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import { safeRmDir } from '../test-utils.js';

function readQueue(stateDir: string) {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'evolution_queue.json'), 'utf8'));
}

describe('EvolutionTaskDispatcher contract hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    WorkspaceContext.clearCache();
  });

  it('enqueueSleepReflection is atomic under concurrent calls', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-atomic-sleep-enqueue-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const dispatcher = new EvolutionTaskDispatcher(workspaceDir);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const wctx = WorkspaceContext.fromHookContext({ workspaceDir, stateDir, logger } as any);

    try {
      await Promise.all([
        dispatcher.enqueueSleepReflection(wctx, logger as any),
        dispatcher.enqueueSleepReflection(wctx, logger as any),
      ]);

      const queue = readQueue(stateDir);
      const sleepTasks = queue.filter((task: any) => task.taskKind === 'sleep_reflection');
      expect(sleepTasks).toHaveLength(1);
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  it('dispatchQueue avoids broad queue save on sleep-only async processing', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-fresh-writeback-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });

    mockGetNocturnalSessionSnapshot.mockReturnValue({
      sessionId: 'sleep-fresh',
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
        failureCount: 1,
      },
    });
    mockStartWorkflow.mockResolvedValue({ workflowId: 'wf-fresh', childSessionKey: 'child-fresh', state: 'active' });
    mockGetWorkflowDebugSummary.mockResolvedValue({ state: 'active', metadata: {} });

    fs.writeFileSync(
      path.join(stateDir, 'evolution_queue.json'),
      JSON.stringify([
        {
          id: 'sleep-fresh',
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
            mostRecent: { sessionId: 'sleep-fresh', score: 80, source: 'test', reason: 'r', timestamp: 't' },
            recentPainCount: 1,
            recentMaxPainScore: 80,
          },
        },
      ], null, 2),
      'utf8',
    );

    const dispatcher = new EvolutionTaskDispatcher(workspaceDir);
    const saveSpy = vi.spyOn(EvolutionQueueStore.prototype, 'save');
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const wctx = WorkspaceContext.fromHookContext({
      workspaceDir,
      stateDir,
      logger,
      config: { get: () => 15000 },
      trajectory: undefined,
    } as any);

    try {
      await dispatcher.dispatchQueue(
        wctx,
        logger as any,
        { append: vi.fn() } as any,
        {
          logger,
          runtime: {
            agent: { defaults: { provider: 'openai', model: 'gpt-5.4' } },
            subagent: {
              run: vi.fn(),
              waitForRun: vi.fn(),
              getSessionMessages: vi.fn(),
              deleteSession: vi.fn(),
            },
          },
        } as any,
      );

      expect(saveSpy).not.toHaveBeenCalled();
    } finally {
      saveSpy.mockRestore();
      safeRmDir(workspaceDir);
    }
  });
});
