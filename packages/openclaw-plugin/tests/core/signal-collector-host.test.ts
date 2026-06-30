import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '@principles/core/runtime-v2';

// mock 掉会触发真实副作用 (evolution reducer / pain service / trajectory DB) 的模块
vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/core/session-tracker.js', () => ({
  trackFriction: vi.fn(),
  getSession: vi.fn(() => ({ currentGfi: 0 })),
}));
// evolution-logger / system-logger 也 mock,避免落盘
vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: { log: vi.fn() },
}));
vi.mock('../../src/core/evolution-logger.js', () => ({
  createTraceId: vi.fn(() => 'trace-mock'),
  getEvolutionLogger: vi.fn(() => ({ logPainDetected: vi.fn() })),
}));

import { SignalCollectorHost } from '../../src/core/signal-collector-host.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import { trackFriction } from '../../src/core/session-tracker.js';

// ── 测试用统一词库 (与 core 测试对齐) ────────────────────────────────────────

const testStore: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  },
};

const testConfig: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30_000,
  promptTemplate: '',
  strongPainScore: 70,
  strongRateLimitPerHour: 5,
};

// 构造 mock wctx (最小化,只含 host 用到的属性)
function makeMockWctx() {
  return {
    workspaceDir: '/tmp/test-ws',
    stateDir: '/tmp/test-ws/.state',
    trajectory: { recordUserTurn: vi.fn() },
  };
}

function makeHost(wctx: ReturnType<typeof makeMockWctx>, opts?: ConstructorParameters<typeof SignalCollectorHost>[1]) {
  return new SignalCollectorHost(wctx as any, opts);
}

// 等待 host 的 fire-and-forget 异步路径 (routeStrong 的 void emit / detectAsyncAndRoute) 完成
function flushAsync(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// detectSync — 同步路径
// ═══════════════════════════════════════════════════════════════════════════════

describe('SignalCollectorHost.detectSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips when trigger !== user', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'heartbeat');
    expect(wctx.trajectory.recordUserTurn).not.toHaveBeenCalled();
  });

  it('high-precision correction → writes user_turns with correctionDetected=true', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: true,
    }));
  });

  it('high-precision correction → fires emitPainDetectedEvent (async, source=user_correction)', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'user');
    // 异步,等微任务
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalled();
    const callArg = vi.mocked(emitPainDetectedEvent).mock.calls[0][1];
    expect(callArg.type).toBe('pain_detected');
    expect((callArg as any).data.source).toBe('user_correction');
    expect((callArg as any).data.score).toBe(70);
  });

  it('ambiguous term → writes user_turns correctionDetected=false, no immediate STRONG emit', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这个不对', 'sess1', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: false,  // ambiguous 不立即标 detected
    }));
  });

  it('STRONG rate limit: 6th call in same hour suppressed', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    for (let i = 0; i < 5; i++) {
      host.detectSync('这是错的', 'sess-rate', 'user');
    }
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(5);
    vi.clearAllMocks();
    host.detectSync('这是错的', 'sess-rate', 'user');  // 第6次
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();  // 被 rate limit
  });

  it('non-user trigger does not enqueue async path', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'cron');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(wctx.trajectory.recordUserTurn).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// detectAsyncAndRoute — 异步路径 (通过 detectSync 入队触发)
// ═══════════════════════════════════════════════════════════════════════════════

describe('SignalCollectorHost async routing (LLM confirmation)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('LLM confirms ambiguous → STRONG → emitPainDetectedEvent', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.9, reason: '明确纠错',
      }),
    });
    host.detectSync('这个不对', 'sess-llm', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(emitPainDetectedEvent).mock.calls[0][1];
    expect((callArg as any).data.source).toBe('user_correction');
    expect((callArg as any).data.reason).toContain('明确纠错');
  });

  it('LLM says empathy → WEAK → trackFriction (no emit)', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'empathy', confidence: 0.7, reason: '挫败情绪',
      }),
    });
    host.detectSync('这个不对', 'sess-weak', 'user');
    await flushAsync();
    expect(trackFriction).toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('LLM says none → no emit, no friction', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: false, type: 'none', confidence: 0.95, reason: '正常指令',
      }),
    });
    host.detectSync('这个不对', 'sess-none', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(trackFriction).not.toHaveBeenCalled();
  });

  it('LLM unavailable (degraded) → drops ambiguous candidate, no STRONG trigger', async () => {
    const wctx = makeMockWctx();
    // llmClassifier = null → 降级纯关键词
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这个不对', 'sess-degrade', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(trackFriction).not.toHaveBeenCalled();
  });
});
