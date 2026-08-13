import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemLogger } from '../../src/core/system-logger.js';
import { drainPainContinuationsForTest, schedulePainContinuation } from '../../src/hooks/pain.js';

describe('OpenClaw pain continuation scheduling', () => {
  afterEach(async () => {
    await drainPainContinuationsForTest();
    vi.restoreAllMocks();
  });

  it('returns after durable shared persistence while making a deferred rejection observable and drainable', async () => {
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
  });
});
