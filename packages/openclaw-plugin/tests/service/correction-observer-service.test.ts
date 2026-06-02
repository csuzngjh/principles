import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceContext } from '../../src/core/workspace-context.js';

const mockLearner = {
  getStore: vi.fn(() => ({ keywords: [{ term: 'wrong', weight: 0.5, hitCount: 3, truePositiveCount: 1, falsePositiveCount: 2 }] })),
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

import { CorrectionObserverService, runCorrectionObserverCycle } from '../../src/service/correction-observer-service.js';
import { safeRmDir } from '../test-utils.js';

describe('CorrectionObserverService — Independent Service (PRI-293)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    CorrectionObserverService.stop?.({} as any);
  });

  it('has correct service id', () => {
    expect(CorrectionObserverService.id).toBe('principles-correction-observer');
  });

  it('starts and schedules periodic cycles', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-obs-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    try {
      CorrectionObserverService.start({
        workspaceDir,
        stateDir,
        logger,
        config: { get: () => undefined },
      } as any);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[PD:CorrectionObserver] Starting')
      );

      await vi.advanceTimersByTimeAsync(10_000);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }

      expect(mockRegister).toHaveBeenCalled();
      expect(mockDispatch).toHaveBeenCalledWith('correction-observer', expect.objectContaining({
        parentSessionId: 'correction-observer-service',
        workspaceDir,
        recentMessages: ['User said wrong input'],
      }));

      expect(mockOptimizationService.applyResult).toHaveBeenCalledWith(expect.objectContaining({
        updated: true,
        summary: 'Keyword store optimized',
      }));
    } finally {
      CorrectionObserverService.stop?.({} as any);
      safeRmDir(workspaceDir);
    }
  });

  it('stops cleanly and cancels pending timer', () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-obs-stop-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    try {
      CorrectionObserverService.start({
        workspaceDir,
        stateDir,
        logger,
        config: { get: () => undefined },
      } as any);

      CorrectionObserverService.stop?.({} as any);

      vi.advanceTimersByTime(30_000);

      expect(mockDispatch).not.toHaveBeenCalled();
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  it('does not reschedule after stop during active cycle (P2 fix)', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-obs-race-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    let cycleResolve: () => void;
    const cyclePromise = new Promise<void>(r => { cycleResolve = r; });
    mockDispatch.mockImplementationOnce(async () => {
      cycleResolve!();
      return { updated: false, summary: 'in-flight' };
    });

    try {
      CorrectionObserverService.start({
        workspaceDir,
        stateDir,
        logger,
        config: { get: () => undefined },
      } as any);

      await vi.advanceTimersByTimeAsync(10_000);
      await cyclePromise;

      CorrectionObserverService.stop?.({} as any);

      vi.advanceTimersByTime(15 * 60 * 1000 * 2);

      expect(mockDispatch).toHaveBeenCalledTimes(1);
    } finally {
      CorrectionObserverService.stop?.({} as any);
      safeRmDir(workspaceDir);
    }
  });

  it('logs structured reason when workspaceDir is missing (ERR-002)', () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    CorrectionObserverService.start({
      workspaceDir: undefined as any,
      logger,
      config: { get: () => undefined },
    } as any);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('workspaceDir not found')
    );
  });
});

describe('runCorrectionObserverCycle — Independent Execution', () => {
  it('skips cycle when no recent sessions exist', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-cycle-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    mockDb.listRecentSessions.mockReturnValueOnce([]);

    try {
      await runCorrectionObserverCycle(wctx, logger as any);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('No recent sessions found')
      );
      expect(mockDispatch).not.toHaveBeenCalled();
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  it('logs structured error on cycle failure (ERR-002)', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-err-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    mockDb.listRecentSessions.mockImplementationOnce(() => {
      throw new Error('DB connection failed');
    });

    try {
      await runCorrectionObserverCycle(wctx, logger as any);

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Correction observer cycle failed')
      );
    } finally {
      safeRmDir(workspaceDir);
    }
  });
});
