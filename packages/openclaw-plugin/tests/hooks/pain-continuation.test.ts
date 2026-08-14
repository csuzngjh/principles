import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemLogger } from '../../src/core/system-logger.js';
import { drainPainContinuationsForTest, schedulePainContinuation } from '../../src/hooks/pain.js';

describe('OpenClaw pain continuation scheduling', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('returns after durable shared persistence while making a deferred rejection observable and drainable', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(SystemLogger, 'log').mockImplementation(() => undefined);
    let rejectContinuation: ((reason: Error) => void) | undefined;
    const continuation = new Promise<void>((_resolve, reject) => { rejectContinuation = reject; });

    schedulePainContinuation('D:/isolated-workspace', continuation);
    expect(log).not.toHaveBeenCalled();

    rejectContinuation?.(new Error('diagnosis unavailable'));
    await drainPainContinuationsForTest();

    expect(log).toHaveBeenCalledWith(
      'D:/isolated-workspace',
      'PAIN_CONTINUATION_FAILED',
      expect.stringContaining('diagnosis unavailable'),
    );
    expect(log).toHaveBeenCalledWith(
      'D:/isolated-workspace',
      'PAIN_CONTINUATION_FAILED',
      expect.stringContaining('retry diagnosis from the persisted canonical pain ID'),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a never-settling continuation so the lifecycle drain completes observably', async () => {
    vi.useFakeTimers();
    const log = vi.spyOn(SystemLogger, 'log').mockImplementation(() => undefined);
    schedulePainContinuation('D:/isolated-workspace', new Promise<void>(() => undefined));
    let drained = false;
    const draining = drainPainContinuationsForTest().then(() => { drained = true; });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(drained).toBe(true);
    expect(log).toHaveBeenCalledWith(
      'D:/isolated-workspace',
      'PAIN_CONTINUATION_FAILED',
      expect.stringContaining('pain_continuation_timeout'),
    );
    expect(log).toHaveBeenCalledWith(
      'D:/isolated-workspace',
      'PAIN_CONTINUATION_FAILED',
      expect.stringContaining('retry diagnosis from the persisted canonical pain ID'),
    );
    await draining;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the finite timeout when a continuation resolves normally', async () => {
    vi.useFakeTimers();
    schedulePainContinuation('D:/isolated-workspace', Promise.resolve());

    await drainPainContinuationsForTest();

    expect(vi.getTimerCount()).toBe(0);
  });
});
