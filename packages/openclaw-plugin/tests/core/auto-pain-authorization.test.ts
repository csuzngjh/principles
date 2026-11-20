/**
 * B-class automatic Pain submission authorization (Pain Ingress SPEC §9.6).
 *
 * SignalCollectorHost gates every automatic route on the injected
 * `isAutoPainAuthorized` probe:
 *   - STRONG hits never reach emitPainDetectedEvent while unauthorized;
 *   - no Stage-2 LLM classification call or queued candidate while
 *     unauthorized (detectSync skip + confirmPendingSignal fail);
 *   - plain interaction recording (user_turns) is never affected.
 * Authorization IS NOT signal_collector / internalization_auto_consumer —
 * it is the separate `automatic_pain_submission` flag.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '@principles/core/runtime';

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
vi.mock('../../src/utils/trace-id.js', () => ({
  createTraceId: vi.fn(() => 'trace-mock'),
}));

import { SignalCollectorHost } from '../../src/core/signal-collector-host.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';

const testStore: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  },
};

const testConfig: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30_000,
  promptTemplate: '',
  strongPainScore: 70,
  strongRateLimitPerHour: 5,
};

function makeWctx() {
  return {
    workspaceDir: '/tmp/test-ws',
    stateDir: '/tmp/test-ws/.state',
    trajectory: { recordUserTurn: vi.fn().mockReturnValue(1) },
  };
}

function makeHost(authorized: boolean, extra?: { llmClassifier?: unknown }) {
  const wctx = makeWctx();
  const host = new SignalCollectorHost(wctx as never, {
    keywordStore: testStore,
    config: testConfig,
    isAutoPainAuthorized: () => authorized,
    ...(extra?.llmClassifier !== undefined ? { llmClassifier: extra.llmClassifier as never } : {}),
  });
  return { host, wctx };
}

function flushAsync(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('B-class auto-pain authorization (SPEC §9.6)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('default option (no probe injected) is unauthorized: STRONG never submits', async () => {
    const wctx = makeWctx();
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
    });
    host.detectSync('这是错的', 'sess', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('unauthorized: STRONG high-precision hit does not emit a Pain', async () => {
    const { host } = makeHost(false);
    host.detectSync('这是错的', 'sess', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('authorized: STRONG high-precision hit follows the SPEC submission path', async () => {
    const { host } = makeHost(true);
    host.detectSync('这是错的', 'sess', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('unauthorized: ambiguous hit does NOT trigger the Stage-2 LLM call', async () => {
    const classifier = vi.fn().mockResolvedValue({ strength: 'strong' });
    const { host } = makeHost(false, { llmClassifier: classifier });
    host.detectSync('不对', 'sess', 'user');
    await flushAsync();
    expect(classifier).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('authorized: ambiguous hit invokes Stage-2 and routes a confirmed STRONG', async () => {
    const classifier = vi.fn().mockResolvedValue({ strength: 'strong', painType: 'user_frustration', confidence: 0.9 });
    const { host } = makeHost(true, { llmClassifier: classifier });
    host.detectSync('不对', 'sess', 'user');
    await flushAsync();
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it('unauthorized: batch confirmation fails fast without calling the classifier', async () => {
    const classifier = vi.fn().mockResolvedValue({ strength: 'strong' });
    const { host } = makeHost(false, { llmClassifier: classifier });
    const result = await host.confirmPendingSignal(
      { sessionId: 'sess', userTurnRowid: 1, occurrenceId: '1', excerpt: '不对' },
      classifier as never,
    );
    expect(result.disposition).toBe('failed');
    expect(result.detail).toBe('auto_pain_unauthorized');
    expect(classifier).not.toHaveBeenCalled();
  });

  it('user_turns interaction recording is unaffected by the gate', () => {
    const { host, wctx } = makeHost(false);
    host.detectSync('这是错的', 'sess', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalled();
  });

  it('revocation is live: toggling the probe mid-life blocks the next signal', async () => {
    let authorized = true;
    const wctx = makeWctx();
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      isAutoPainAuthorized: () => authorized,
    });
    host.detectSync('这是错的', 'sess', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    vi.clearAllMocks();
    authorized = false;
    host.detectSync('这是错的', 'sess2', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });
});
