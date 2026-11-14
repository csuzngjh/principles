import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runConsumerCycle,
  InternalizationAutoConsumerService,
} from '../../src/service/internalization-auto-consumer-service.js';
import { loadFeatureFlagFromConfig } from '../../src/core/pd-config-loader.js';
import { SystemLogger } from '../../src/core/system-logger.js';
import { runInternalizationConsumerCycle, runPendingDiagnosticianOnce } from '@principles/host-runtime';
import type { InternalizationConsumerCycleOutcome } from '@principles/host-runtime';
import type { OpenClawPluginServiceContext } from '../../src/openclaw-sdk.js';

vi.mock('../../src/core/pd-config-loader.js');
vi.mock('../../src/core/system-logger.js');

// PRI-655: the timer-chain tests below need to inject a cycle rejection.
// Spread-mock host-runtime (ERR-115: full-module replacement breaks on new
// exports) — runInternalizationConsumerCycle defaults to delegating to the
// REAL implementation so the cycle contract tests above keep driving real
// .pd/config.yaml; individual tests override with mockRejectedValueOnce.
vi.mock('@principles/host-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@principles/host-runtime')>();
  return {
    ...actual,
    runInternalizationConsumerCycle: vi.fn(async (...args: Parameters<typeof actual.runInternalizationConsumerCycle>) => actual.runInternalizationConsumerCycle(...args)),
    // SPEC v0.8 §8.4 (L3): default to "nothing to diagnose" so every existing
    // cycle test exercises the L3 tick without producing a log line.
    runPendingDiagnosticianOnce: vi.fn(async () => ({ served: false, reason: 'no_candidate' as const })),
    saveHostToolDeclaration: vi.fn(() => ({ ok: true })),
  };
});

// PRI-624: the cycle body now lives in the shared host-runtime
// runInternalizationConsumerCycle, which reads the REAL workspace config —
// plugin-local loader mocks can no longer steer it. The cycle contract tests
// below therefore drive real .pd/config.yaml files (better than mocks: they
// exercise the production flag/config read path end to end).
describe('InternalizationAutoConsumerService', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const workspaceDir = '/mock/workspace';
  let realWorkspaceDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    realWorkspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-auto-consumer-cycle-'));
  });

  afterEach(() => {
    fs.rmSync(realWorkspaceDir, { recursive: true, force: true });
  });

  describe('runConsumerCycle', () => {
    it('should skip when feature flag is disabled', async () => {
      fs.mkdirSync(path.join(realWorkspaceDir, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(realWorkspaceDir, '.pd', 'config.yaml'), [
        'version: 1',
        'features:',
        '  internalization_auto_consumer:',
        '    category: quiet',
        '    enabled: false',
        'runtimeProfiles:',
        '  openclaw.default:',
        '    type: openclaw',
        '    source: default',
        'internalAgents:',
        '  defaultRuntime: openclaw.default',
        '  agents:',
        '    dreamer:',
        '      enabled: true',
        '',
      ].join('\n'));
      await runConsumerCycle(realWorkspaceDir, logger);
      expect(SystemLogger.log).toHaveBeenCalledWith(realWorkspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', expect.stringContaining('internalization_auto_consumer_disabled'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Cycle skipped: auto-consumer disabled'));
    });

    it('should skip when config is malformed', async () => {
      fs.mkdirSync(path.join(realWorkspaceDir, '.pd'), { recursive: true });
      fs.writeFileSync(path.join(realWorkspaceDir, '.pd', 'config.yaml'), 'features: [broken\n');
      await runConsumerCycle(realWorkspaceDir, logger);
      expect(SystemLogger.log).toHaveBeenCalledWith(realWorkspaceDir, 'INTERNALIZATION_CONSUMER_SKIP', expect.stringContaining('config_malformed'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Config malformed, skipping cycle'));
    });

    // SPEC v0.8 §8.4 (L3): the consumer tick hosts one bounded diagnosis. The
    // tick must stay observable on every outcome and must never be able to
    // break the internalization cycle that owns the timer.
    describe('L3 diagnostician tick', () => {
      function l3Log(event: string): unknown[] | undefined {
        return vi.mocked(SystemLogger.log).mock.calls.find((call) => call[1] === event);
      }

      it('records the served task on DIAGNOSTICIAN_AUTO_RUN', async () => {
        vi.mocked(runInternalizationConsumerCycle).mockResolvedValueOnce(undefined);
        vi.mocked(runPendingDiagnosticianOnce).mockResolvedValueOnce({ served: true, taskId: 'diagnosis_pain-1' });

        await runConsumerCycle(realWorkspaceDir, logger);

        expect(runPendingDiagnosticianOnce).toHaveBeenCalledWith({ workspaceDir: realWorkspaceDir });
        expect(l3Log('DIAGNOSTICIAN_AUTO_RUN')).toEqual([
          realWorkspaceDir,
          'DIAGNOSTICIAN_AUTO_RUN',
          JSON.stringify({ served: true, taskId: 'diagnosis_pain-1' }),
        ]);
      });

      it('records every skip except no_candidate with reason, task, message and next action', async () => {
        vi.mocked(runInternalizationConsumerCycle).mockResolvedValueOnce(undefined);
        vi.mocked(runPendingDiagnosticianOnce).mockResolvedValueOnce({
          served: false,
          reason: 'capability_disabled',
          taskId: 'diagnosis_pain-1',
          message: 'diagnostician capability is disabled',
          nextAction: 'enable the diagnostician capability',
        });

        await runConsumerCycle(realWorkspaceDir, logger);

        const call = l3Log('DIAGNOSTICIAN_AUTO_RUN_SKIPPED');
        expect(call).toBeDefined();
        expect(JSON.parse(call?.[2] as string)).toEqual({
          reason: 'capability_disabled',
          taskId: 'diagnosis_pain-1',
          message: 'diagnostician capability is disabled',
          nextAction: 'enable the diagnostician capability',
        });
      });

      it('stays silent when there is simply no candidate', async () => {
        vi.mocked(runInternalizationConsumerCycle).mockResolvedValueOnce(undefined);
        // Factory default is { served: false, reason: 'no_candidate' }.

        await runConsumerCycle(realWorkspaceDir, logger);

        expect(vi.mocked(SystemLogger.log).mock.calls.filter((call) => String(call[1]).startsWith('DIAGNOSTICIAN_AUTO_RUN'))).toHaveLength(0);
      });

      it('never lets a diagnosis failure break the cycle, and bounds the message', async () => {
        vi.mocked(runInternalizationConsumerCycle).mockResolvedValueOnce(undefined);
        vi.mocked(runPendingDiagnosticianOnce).mockRejectedValueOnce(new Error('x'.repeat(300)));

        await expect(runConsumerCycle(realWorkspaceDir, logger)).resolves.toBeUndefined();

        const call = l3Log('DIAGNOSTICIAN_AUTO_RUN_FAILED');
        expect(call).toBeDefined();
        const payload = JSON.parse(call?.[2] as string) as { message: string };
        expect(payload.message).toHaveLength(200);
      });
    });
  });

  describe('start / stop', () => {
    it('should log warning when workspaceDir is missing', () => {
      const ctx = { logger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);
      expect(logger.warn).toHaveBeenCalledWith('[PD:AutoConsumer] No workspace directory, not starting.');
    });

    it('should skip start when feature flag is disabled', () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: false, source: 'default' });
      const ctx = { workspaceDir, logger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);
      expect(SystemLogger.log).toHaveBeenCalledWith(workspaceDir, 'INTERNALIZATION_CONSUMER_DISABLED', expect.any(String));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('NOT started for workspace'));
    });

    it('should stop gracefully without workspaceDir', () => {
      const ctx = {} as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.stop(ctx);
    });

    it('should stop gracefully with workspaceDir', () => {
      const ctx = { workspaceDir, logger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.stop(ctx);
    });
  });

  describe('timer chain resilience (PRI-655)', () => {
    const timerWorkspaceDir = '/mock/workspace-timer';
    const INITIAL_DELAY_MS = 30_000;
    const INTERVAL_MS = 120_000;
    const timerLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      InternalizationAutoConsumerService.stop({ workspaceDir: timerWorkspaceDir, logger: timerLogger } as OpenClawPluginServiceContext);
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('a rejected cycle logs the failure on both channels and the chain SURVIVES to the next round', async () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'default' });
      vi.mocked(runInternalizationConsumerCycle)
        .mockRejectedValue(new Error('boom: transients happen'));

      const ctx = { workspaceDir: timerWorkspaceDir, logger: timerLogger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);

      // Round one (after the initial delay): the cycle rejects...
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
      // ...the failure is OBSERVABLE on both channels (rc-9, not silent)...
      expect(timerLogger.error).toHaveBeenCalledWith(expect.stringContaining('boom: transients happen'));
      expect(SystemLogger.log).toHaveBeenCalledWith(
        timerWorkspaceDir,
        'INTERNALIZATION_CONSUMER_CYCLE_FAILED',
        expect.stringContaining('boom: transients happen'),
      );

      // ...and round two STILL RUNS — the chain did not die (the bug: it did).
      // SPEC §4: a failed cycle now cools down with the shared retry policy
      // (30s base ±10% jitter) instead of the old fixed 120s interval, so the
      // next wake-up is bounded by that backoff, not by INTERVAL_MS.
      await vi.advanceTimersByTimeAsync(32_000);
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(2);
      // The reason for the next delay is observable (not just "it woke up").
      const scheduleCall = vi.mocked(SystemLogger.log).mock.calls
        .filter((call) => call[1] === 'INTERNALIZATION_CONSUMER_SCHEDULE')
        .at(-1);
      expect(scheduleCall).toBeDefined();
      expect(JSON.parse(String(scheduleCall?.[2]))).toMatchObject({ state: 'provider_cooling' });

      // Round three keeps going — the chain is self-sustaining again.
      await vi.advanceTimersByTimeAsync(70_000);
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(3);
    });

    it('stop() during or after a failed cycle still ends the chain (no revival)', async () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'default' });
      vi.mocked(runInternalizationConsumerCycle).mockRejectedValue(new Error('persistent failure'));

      const ctx = { workspaceDir: timerWorkspaceDir, logger: timerLogger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);

      InternalizationAutoConsumerService.stop({ workspaceDir: timerWorkspaceDir, logger: timerLogger } as OpenClawPluginServiceContext);
      await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3);
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(1);
    });

    it('derives the failure/empty counters from the cycle outcome it actually observed', async () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'default' });
      const signals = { readyQueueDepth: 0, retryQueueDepth: 0, oldestReadyAgeMs: null, recovered: 0 };
      const outcomes: InternalizationConsumerCycleOutcome[] = [
        { ran: true, runStatus: 'succeeded', signals },
        { ran: false, skipReason: 'nothing_ready', signals },
        { ran: true, runStatus: 'retried', signals },
        { ran: true, runStatus: 'failed', errorCategory: 'rate_limit', signals },
      ];
      for (const outcome of outcomes) {
        vi.mocked(runInternalizationConsumerCycle).mockResolvedValueOnce(outcome);
      }

      const ctx = { workspaceDir: timerWorkspaceDir, logger: timerLogger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);

      const lastSchedule = () => JSON.parse(String(
        vi.mocked(SystemLogger.log).mock.calls.filter((call) => call[1] === 'INTERNALIZATION_CONSUMER_SCHEDULE').at(-1)?.[2],
      )) as Record<string, unknown>;

      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
      expect(lastSchedule()).toMatchObject({ consecutiveFailures: 0, consecutiveEmptyCycles: 0 });

      // Advance exactly the delay the scheduler just announced, so each step
      // observes one cycle instead of a burst of fallback rounds.
      await vi.advanceTimersByTimeAsync(Number(lastSchedule().delayMs));
      // A cycle that never reached the queue is an EMPTY cycle, not a failure.
      expect(lastSchedule()).toMatchObject({ consecutiveFailures: 0, consecutiveEmptyCycles: 1 });

      await vi.advanceTimersByTimeAsync(Number(lastSchedule().delayMs));
      // A retried task is a failed attempt, so the counter does not drop back.
      expect(lastSchedule()).toMatchObject({ consecutiveFailures: 1, consecutiveEmptyCycles: 0 });

      await vi.advanceTimersByTimeAsync(Number(lastSchedule().delayMs));
      expect(lastSchedule()).toMatchObject({
        consecutiveFailures: 2,
        consecutiveEmptyCycles: 0,
        providerLimited: true,
      });
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(4);
    });

    it('logs and revives the chain when the scheduling tail itself throws', async () => {
      vi.mocked(loadFeatureFlagFromConfig).mockReturnValue({ enabled: true, source: 'default' });
      vi.mocked(runInternalizationConsumerCycle).mockResolvedValue(undefined);
      // First call is INTERNALIZATION_CONSUMER_STARTED; the scheduling log is
      // the only call that fails, so the cycle itself is otherwise clean.
      vi.mocked(SystemLogger.log).mockImplementationOnce(() => undefined);
      vi.mocked(SystemLogger.log).mockImplementationOnce(() => { throw new Error('log sink down'); });

      const ctx = { workspaceDir: timerWorkspaceDir, logger: timerLogger } as OpenClawPluginServiceContext;
      InternalizationAutoConsumerService.start(ctx);
      await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS);

      expect(timerLogger.error).toHaveBeenCalledWith(expect.stringContaining('Startup cycle failed'));

      // The startup fallback reschedules, so the chain survives the tail fault.
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
      expect(runInternalizationConsumerCycle).toHaveBeenCalledTimes(2);
    });
  });
});
