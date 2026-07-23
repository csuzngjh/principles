/**
 * SignalCollectorHost edge case tests
 *
 * Tests rate limiting, error handling, and edge cases not fully covered
 * by the main test suite.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '@principles/core/runtime-v2';

// Mock dependencies
vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/core/session-tracker.js', () => ({
  trackFriction: vi.fn(),
  getSession: vi.fn(() => ({ currentGfi: 0 })),
}));

vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: { log: vi.fn() },
}));

vi.mock('../../src/core/evolution-logger.js', () => ({
  createTraceId: vi.fn(() => 'trace-mock'),
  getEvolutionLogger: vi.fn(() => ({ logPainDetected: vi.fn() })),
}));

import { SignalCollectorHost, isUserInteractionTrigger } from '../../src/core/signal-collector-host.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import { trackFriction } from '../../src/core/session-tracker.js';
import { SystemLogger } from '../../src/core/system-logger.js';

const testStore: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '搞什么': { term: '搞什么', category: 'empathy', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  },
};

const testConfig: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30_000,
  promptTemplate: '',
  strongPainScore: 70,
  strongRateLimitPerHour: 5,
};

function makeMockWctx() {
  return {
    workspaceDir: '/tmp/test-ws',
    stateDir: '/tmp/test-ws/.state',
    trajectory: { recordUserTurn: vi.fn() },
  };
}

function makeHost(wctx: ReturnType<typeof makeMockWctx>, opts?: ConstructorParameters<typeof SignalCollectorHost>[1]) {
  return new SignalCollectorHost(wctx as unknown as ConstructorParameters<typeof SignalCollectorHost>[0], opts);
}

function flushAsync(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('isUserInteractionTrigger', () => {
  it('returns true for user trigger', () => {
    expect(isUserInteractionTrigger('user')).toBe(true);
  });

  it('returns true for api trigger', () => {
    expect(isUserInteractionTrigger('api')).toBe(true);
  });

  it('returns true for undefined trigger', () => {
    expect(isUserInteractionTrigger(undefined)).toBe(true);
  });

  it('returns false for heartbeat trigger', () => {
    expect(isUserInteractionTrigger('heartbeat')).toBe(false);
  });

  it('returns false for cron trigger', () => {
    expect(isUserInteractionTrigger('cron')).toBe(false);
  });

  it('returns false for subagent trigger', () => {
    expect(isUserInteractionTrigger('subagent')).toBe(false);
  });

  it('returns false for any other system trigger', () => {
    expect(isUserInteractionTrigger('system')).toBe(false);
    expect(isUserInteractionTrigger('background')).toBe(false);
    expect(isUserInteractionTrigger('automated')).toBe(false);
  });
});

describe('SignalCollectorHost trigger gating', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips processing for cron trigger', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'cron');

    expect(wctx.trajectory.recordUserTurn).not.toHaveBeenCalled();
  });

  it('skips processing for subagent trigger', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'subagent');

    expect(wctx.trajectory.recordUserTurn).not.toHaveBeenCalled();
  });

  it('accepts undefined trigger as user interaction', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess-undefined', undefined);

    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: true,
    }));
  });
});

describe('SignalCollectorHost rate limiting', () => {
  beforeEach(() => vi.clearAllMocks());

  it('enforces rate limit for STRONG signals within the same session', async () => {
    // ERR-088 fix (CodeRabbit): previously called detectSync 3× with no assertion
    // — the test passed whether or not rate limiting worked. Now assert the
    // exact emission count: with strongRateLimitPerHour=2, only the first two
    // STRONG signals emit pain; the third is suppressed.
    const wctx = makeMockWctx();
    const configWithLowLimit: SignalCollectorConfig = {
      ...testConfig,
      strongRateLimitPerHour: 2,
    };
    const host = makeHost(wctx, { keywordStore: testStore, config: configWithLowLimit });

    // First STRONG signal - should emit
    host.detectSync('这是错的', 'sess-rate-limit', 'user');
    await flushAsync();

    // Second STRONG signal - should emit
    host.detectSync('这是错的', 'sess-rate-limit', 'user');
    await flushAsync();

    // Third STRONG signal - should be rate limited (no new emission)
    host.detectSync('这是错的', 'sess-rate-limit', 'user');
    await flushAsync();

    // Exactly 2 emissions: the rate limit suppressed the 3rd STRONG signal.
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(2);
    // recordUserTurn is called for ALL signals (rate limit only gates the
    // STRONG emit path, not the trajectory write) — verify it still wrote 3.
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledTimes(3);
    // The suppressed signal must be observable (rc-9-no-silent-fallback):
    // SystemLogger.log is called with SIGNAL_STRONG_RATE_LIMITED.
    expect(SystemLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      'SIGNAL_STRONG_RATE_LIMITED',
      expect.any(String),
    );
  });

  it('resets rate limit after the 1-hour window expires', async () => {
    // ERR-088 fix (CodeRabbit): previously did NOT mock time, so it only
    // verified a single normal emission — it could not prove the window
    // resets. Now mock Date.now (not full fake timers, which would freeze
    // flushAsync's setTimeout) to advance past the window and verify a
    // suppressed signal becomes eligible again.
    const realNow = Date.now();
    const dateSpy = vi.spyOn(Date, 'now');
    let mockedTime = realNow;
    dateSpy.mockImplementation(() => mockedTime);
    try {
      const wctx = makeMockWctx();
      const host = makeHost(wctx, {
        keywordStore: testStore,
        config: { ...testConfig, strongRateLimitPerHour: 1 },
      });

      // First STRONG signal consumes the only slot → emits.
      host.detectSync('这是错的', 'sess-reset', 'user');
      await flushAsync();
      expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);

      // Second STRONG signal within the window → suppressed.
      host.detectSync('这是错的', 'sess-reset', 'user');
      await flushAsync();
      expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1); // still 1

      // Advance past the 1-hour window → bucket resets.
      mockedTime = realNow + 60 * 60 * 1000 + 1000;

      // Third STRONG signal after window reset → emits again.
      host.detectSync('这是错的', 'sess-reset', 'user');
      await flushAsync();
      expect(emitPainDetectedEvent).toHaveBeenCalledTimes(2);
    } finally {
      dateSpy.mockRestore();
    }
  });
});

describe('SignalCollectorHost trajectory write error handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('continues processing when trajectory write fails', async () => {
    const wctx = makeMockWctx();
    wctx.trajectory.recordUserTurn = vi.fn().mockImplementation(() => {
      throw new Error('Trajectory write failed');
    });

    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });

    // Should not throw even when trajectory write fails
    expect(() => {
      host.detectSync('这是错的', 'sess-traj-err', 'user');
    }).not.toThrow();

    await flushAsync();

    // SystemLogger should have logged the error
    expect(SystemLogger.log).toHaveBeenCalled();
  });

  it('logs trajectory write errors with correct category', async () => {
    const wctx = makeMockWctx();
    wctx.trajectory.recordUserTurn = vi.fn().mockImplementation(() => {
      throw new Error('DB connection lost');
    });

    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess-log-err', 'user');

    await flushAsync();

    expect(SystemLogger.log).toHaveBeenCalledWith(
      expect.any(String),
      'SIGNAL_TRAJECTORY_FAIL',
      expect.stringContaining('DB connection lost'),
    );
  });
});

describe('SignalCollectorHost ambiguous keyword handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('processes ambiguous correction keywords through LLM confirmation path', async () => {
    const wctx = makeMockWctx();
    const mockClassifier = vi.fn().mockResolvedValue({
      is_feedback: true,
      type: 'correction',
      confidence: 0.8,
      reason: 'User expressed disagreement',
    });

    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: mockClassifier,
    });

    host.detectSync('不对', 'sess-ambiguous', 'user');
    await flushAsync(100);

    // Should have called LLM classifier for ambiguous keyword
    expect(mockClassifier).toHaveBeenCalled();
  });
});

describe('SignalCollectorHost empathy keyword routing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records empathy keyword in trajectory but does NOT route to STRONG or WEAK when LLM is disabled', async () => {
    // Verified behavior (probe): with enableLlmStage=false + llmClassifier=null,
    // an ambiguous empathy keyword ('搞什么') is recorded in user_turns but is
    // NOT routed to either STRONG (emitPainDetectedEvent) or WEAK
    // (trackFriction) — the ambiguous candidate is silently dropped because
    // collectSync sets needsLlmConfirmation=false when no LLM is configured.
    // This documents a real product gap (empathy signals are inert in the
    // default no-LLM config), NOT a test bug. Asserting trackFriction here
    // (as CodeRabbit suggested) would be wrong — it is never called in this
    // config. Assert the actual observed behavior honestly.
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, enableLlmStage: false },
      llmClassifier: null,
    });

    host.detectSync('搞什么', 'sess-empathy', 'user');
    await flushAsync(100);

    // The turn IS recorded (empathy detection is not entirely dead).
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledTimes(1);
    // But correctionDetected is false (empathy is not a correction).
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: false,
    }));
    // And neither downstream routing fires — the ambiguous candidate is dropped.
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(trackFriction).not.toHaveBeenCalled();
  });
});

describe('SignalCollectorHost concurrent signal detection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('handles multiple concurrent signals in same session', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });

    // Simulate concurrent signals
    host.detectSync('这是错的', 'sess-concurrent', 'user');
    host.detectSync('不对', 'sess-concurrent', 'user');
    host.detectSync('这是错的', 'sess-concurrent', 'user');

    await flushAsync(100);

    // All signals should be processed (not blocked by concurrent access)
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledTimes(3);
  });

  it('maintains separate rate limits for different sessions', async () => {
    const wctx = makeMockWctx();
    const configWithLowLimit: SignalCollectorConfig = {
      ...testConfig,
      strongRateLimitPerHour: 1,
    };
    const host = makeHost(wctx, { keywordStore: testStore, config: configWithLowLimit });

    // Session 1
    host.detectSync('这是错的', 'sess-separate-1', 'user');

    // Session 2
    host.detectSync('这是错的', 'sess-separate-2', 'user');

    await flushAsync(100);

    // Both should be processed (different sessions have separate rate limits)
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(2);
  });
});