import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';
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

// PRI-307: Mock the pd-config-loader instead of @principles/core/runtime-v2
// The service now reads .pd/config.yaml via resolveObserverConfig
vi.mock('../../src/core/pd-config-loader.js', () => {
  return {
    loadPdConfigForPlugin: vi.fn(() => ({
      ok: true,
      effective: {
        config: {
          version: 1,
          features: {
            prompt: { category: 'core', enabled: true },
            code_tool_hook: { category: 'core', enabled: true },
            defer_archive: { category: 'core', enabled: true },
            correction_observer: { category: 'quiet', enabled: true },
            empathy_observer: { category: 'quiet', enabled: false },
          },
          runtimeProfiles: {
            'openclaw.default': { type: 'openclaw', source: 'default' },
            'pd.anthropic-sonnet': { type: 'pi-ai', provider: 'anthropic', model: 'claude-3-5-sonnet', apiKeyEnv: 'ANTHROPIC_API_KEY', timeoutMs: 30000 },
          },
          internalAgents: {
            defaultRuntime: 'openclaw.default',
            agents: {
              diagnostician: { enabled: true },
              dreamer: { enabled: true },
              scribe: { enabled: true },
              artificer: { enabled: true },
              philosopher: { enabled: false },
              evaluator: { enabled: false },
              rolloutReviewer: { enabled: false },
              trainer: { enabled: false },
              correctionObserver: { enabled: true, runtimeProfile: 'pd.anthropic-sonnet' },
              empathyObserver: { enabled: false },
            },
          },
        },
        warnings: [],
      },
      source: 'defaults',
      configPath: '.pd/config.yaml',
      warnings: [],
      errors: [],
    })),
    loadFeatureFlagFromConfig: vi.fn(() => ({ enabled: true, source: 'defaults' })),
    resolveObserverConfig: vi.fn((_workspaceDir: string, flagId: string, _agentName: string) => {
      // Default: return disabled for correction_observer (no config file in test tmp dirs)
      if (flagId === 'correction_observer') {
        return {
          enabled: true,
          readiness: 'not_ready',
          source: 'defaults',
          reason: 'pi-ai profile configured with apiKeyEnv',
          nextAction: 'Run pd runtime probe',
          runtimeProfileId: 'pd.anthropic-sonnet',
          runtimeProfileType: 'pi-ai',
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          apiKeyPresent: !!process.env.ANTHROPIC_API_KEY,
          provider: 'anthropic',
          model: 'claude-3-5-sonnet',
          timeoutMs: 30000,
          baseUrl: null,
        };
      }
      return {
        enabled: false,
        readiness: 'disabled',
        source: 'defaults',
        reason: `${flagId} is disabled`,
        nextAction: `Set features.${flagId}.enabled=true in .pd/config.yaml`,
        runtimeProfileId: null,
        runtimeProfileType: null,
        apiKeyEnv: null,
        apiKeyPresent: false,
        provider: null,
        model: null,
        timeoutMs: null,
        baseUrl: null,
      };
    }),
    getPdConfigPath: vi.fn((workspaceDir: string) => path.join(workspaceDir, '.pd', 'config.yaml')),
  };
});

const mockDispatch = vi.fn().mockResolvedValue({
  updated: true,
  summary: 'Keyword store optimized',
  updates: { wrong: { action: 'update', weight: 0.4, reasoning: 'slightly high FP' } }
});

const mockRegister = vi.fn();

vi.mock('@principles/core/runtime-v2', () => {
  return {
    PiAiRuntimeAdapter: class {},
    CorrectionObserver: class {},
    AgentScheduler: class {
      register = mockRegister;
      dispatch = mockDispatch;
    },
  };
});

import { CorrectionObserverService, runCorrectionObserverCycle, resolveCorrectionObserver } from '../../src/service/correction-observer-service.js';
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

  it('double start same workspace only dispatches one loop (P1 fix)', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-dbl-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const logger1 = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const logger2 = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    try {
      CorrectionObserverService.start({
        workspaceDir,
        stateDir,
        logger: logger1,
        config: { get: () => undefined },
      } as any);

      CorrectionObserverService.start({
        workspaceDir,
        stateDir,
        logger: logger2,
        config: { get: () => undefined },
      } as any);

      expect(logger2.info).toHaveBeenCalledWith(
        expect.stringContaining('Already started')
      );

      await vi.advanceTimersByTimeAsync(10_000);
      for (let i = 0; i < 20; i++) {
        await Promise.resolve();
      }

      expect(mockDispatch).toHaveBeenCalledTimes(1);
    } finally {
      CorrectionObserverService.stop?.({} as any);
      safeRmDir(workspaceDir);
    }
  });

  it('stop after double start cancels all timers and allows clean restart', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-stopdbl-'));
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

      CorrectionObserverService.start({
        workspaceDir,
        stateDir,
        logger,
        config: { get: () => undefined },
      } as any);

      CorrectionObserverService.stop?.({} as any);

      vi.advanceTimersByTime(30_000);

      expect(mockDispatch).not.toHaveBeenCalled();

      CorrectionObserverService.start({
        workspaceDir,
        stateDir,
        logger,
        config: { get: () => undefined },
      } as any);

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('[PD:CorrectionObserver] Starting')
      );
    } finally {
      CorrectionObserverService.stop?.({} as any);
      safeRmDir(workspaceDir);
    }
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

describe('resolveCorrectionObserver — Configuration Resolution (PRI-307)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns observer when API key env is set with pi-ai profile', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-resolve-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    process.env.ANTHROPIC_API_KEY = 'test-key';

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    try {
      const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
      const result = resolveCorrectionObserver(wctx, logger as any);

      // With mocked resolveObserverConfig returning enabled + not_ready, should return observer
      expect(result).not.toBeNull();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      safeRmDir(workspaceDir);
    }
  });

  it('returns null when observer is disabled in config', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-disabled-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    // Override the mock to return disabled
    const { resolveObserverConfig } = await import('../../src/core/pd-config-loader.js');
    vi.mocked(resolveObserverConfig).mockReturnValueOnce({
      enabled: false,
      readiness: 'disabled',
      source: 'defaults',
      reason: 'correction_observer is disabled in .pd/config.yaml',
      nextAction: 'Set features.correction_observer.enabled=true in .pd/config.yaml to enable',
      runtimeProfileId: null,
      runtimeProfileType: null,
      apiKeyEnv: null,
      apiKeyPresent: false,
      provider: null,
      model: null,
      timeoutMs: null,
      baseUrl: null,
    });

    try {
      const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
      const result = resolveCorrectionObserver(wctx, logger as any);

      expect(result).toBeNull();
    } finally {
      safeRmDir(workspaceDir);
    }
  });

  it('returns null when observer needs setup (no API key)', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-corr-needs-setup-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    // Override the mock to return needs_setup
    const { resolveObserverConfig } = await import('../../src/core/pd-config-loader.js');
    vi.mocked(resolveObserverConfig).mockReturnValueOnce({
      enabled: true,
      readiness: 'needs_setup',
      source: 'defaults',
      reason: "Environment variable 'ANTHROPIC_API_KEY' is not set or empty",
      nextAction: 'Set the environment variable ANTHROPIC_API_KEY with a valid API key',
      runtimeProfileId: 'pd.anthropic-sonnet',
      runtimeProfileType: 'pi-ai',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      apiKeyPresent: false,
      provider: 'anthropic',
      model: 'claude-3-5-sonnet',
      timeoutMs: 30000,
      baseUrl: null,
    });

    try {
      const wctx = WorkspaceContext.fromHookContext({ workspaceDir });
      const result = resolveCorrectionObserver(wctx, logger as any);

      expect(result).toBeNull();
      // Should log the needs_setup reason, not noisy "no API key" cycling
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('ANTHROPIC_API_KEY')
      );
    } finally {
      safeRmDir(workspaceDir);
    }
  });
});
