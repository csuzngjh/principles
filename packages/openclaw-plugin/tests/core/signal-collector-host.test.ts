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

// 构造 mock wctx (最小化,只含 host 用到的属性)
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

// 等待 host 的 fire-and-forget 异步路径 (routeStrong 的 void emit / detectAsyncAndRoute) 完成
function flushAsync(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// detectSync — 同步路径
// ═══════════════════════════════════════════════════════════════════════════════

describe('SignalCollectorHost.detectSync', () => {
  beforeEach(() => vi.clearAllMocks());

  it('skips when trigger is a non-user system trigger (heartbeat)', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'heartbeat');
    expect(wctx.trajectory.recordUserTurn).not.toHaveBeenCalled();
  });

  it('accepts api trigger as user interaction (regression: previously rejected by trigger !== user gate)', () => {
    // P1 regression: detectSync 内部曾用 `if (trigger !== 'user') return;` 静默丢弃
    // api/undefined 触发的纠正信号。现在改用 isUserInteractionTrigger,user/api/undefined
    // 均被视为用户交互。prompt.ts 调用时已将 undefined 转为 'api',所以这里测 'api'。
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess-api', 'api');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: true,
    }));
  });

  it('high-precision correction → writes user_turns with correctionDetected=true', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: true,
    }));
  });

  it('single detectSync call writes user_turns exactly once (no double-write regression)', () => {
    // 回归测试: 防止 prompt.ts 两处 detectSync 调用点导致同一消息双重写入。
    // 详见 PR review Phase 3 P1: empathy 段 + correction 段曾重复调用。
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess-once', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledTimes(1);
  });

  it('high-precision correction → fires emitPainDetectedEvent (async, source=user_correction)', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess1', 'user');
    // 异步,等微任务
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalled();
    const callArg = vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { type: string; data: { source: string; score?: number; reason?: string; painId?: string; provenance?: string; hostKind?: string } };
    expect(callArg.type).toBe('pain_detected');
    expect(callArg.data.source).toBe('user_correction');
    expect(callArg.data.score).toBe(70);
    // Codex Governance Closure Slice B convergence (ADR-0020 §11.4): the
    // correction pain id is the content-derived canonical id from the single
    // pain identity authority — never a random `correction_<traceId>`.
    expect(callArg.data.painId).toMatch(/^pain_host_[0-9a-f]{64}$/);
    expect(callArg.data.provenance).toBe('host_context_bound');
    expect(callArg.data.hostKind).toBe('openclaw');
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
    const callArg = vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { type: string; data: { source: string; reason?: string } };
    expect(callArg.data.source).toBe('user_correction');
    expect(callArg.data.reason).toContain('明确纠错');
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

  it('LLM unavailable (degraded) → drops correction ambiguous candidate, no STRONG trigger', async () => {
    const wctx = makeMockWctx();
    // llmClassifier = null → 降级纯关键词
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这个不对', 'sess-degrade', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(trackFriction).not.toHaveBeenCalled();
  });

  it('LLM unavailable (degraded) → empathy ambiguous routed as WEAK (GFI accumulation preserved)', async () => {
    // 回归测试: 旧版 prompt.ts 的 empathy keyword matcher 在关键词命中时直接
    // trackFriction 累积 GFI,不依赖 LLM。SignalCollectorHost 重构后,当 LLM
    // 不可用(默认配置)时,empathy ambiguous 候选必须降级为 WEAK 信号路由,
    // 保留 GFI 累积行为,避免 empathy 检测完全失效。
    const wctx = makeMockWctx();
    // llmClassifier = null → 降级纯关键词
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('你搞什么啊', 'sess-empathy-degrade', 'user');
    await flushAsync();
    expect(trackFriction).toHaveBeenCalledTimes(1);
    expect(trackFriction).toHaveBeenCalledWith(
      'sess-empathy-degrade',
      20,
      expect.any(String),
      '/tmp/test-ws',
      { source: 'user_empathy' },
    );
    // STRONG 不触发(降级不触发诊断,仅累积 GFI)
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('LLM classifier throws exception → gracefully degraded to none', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => {
        throw new Error('LLM service unavailable');
      },
    });
    host.detectSync('这个不对', 'sess-except', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(trackFriction).not.toHaveBeenCalled();
  });

  it('LLM classifier returns null → treated as none', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => null,
    });
    host.detectSync('这个不对', 'sess-null', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(trackFriction).not.toHaveBeenCalled();
  });

  it('emitPainDetectedEvent throws → does not crash host', async () => {
    vi.mocked(emitPainDetectedEvent).mockRejectedValue(new Error('emit failed'));
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess-emit-fail', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalled();
  });

  it('trackFriction throws → does not crash host', async () => {
    vi.mocked(trackFriction).mockImplementation(() => {
      throw new Error('trackFriction failed');
    });
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'empathy', confidence: 0.7, reason: 'frustration',
      }),
    });
    host.detectSync('这个不对', 'sess-friction-fail', 'user');
    await flushAsync();
    expect(trackFriction).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 边界条件和异常处理
// ═══════════════════════════════════════════════════════════════════════════════

describe('SignalCollectorHost edge cases and error handling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('empty user message → no signal, writes user_turns', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('', 'sess-empty', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalled();
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: false,
    }));
  });

  it('whitespace-only message → no signal', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('   \n\t  ', 'sess-whitespace', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalled();
  });

  it('recordUserTurn throws → does not crash detectSync', () => {
    const wctx = makeMockWctx();
    wctx.trajectory.recordUserTurn = vi.fn().mockImplementation(() => {
      throw new Error('DB error');
    });
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    expect(() => {
      host.detectSync('这是错的', 'sess-db-fail', 'user');
    }).not.toThrow();
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalled();
  });

  it('different sessions have independent rate limits', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    for (let i = 0; i < 5; i++) {
      host.detectSync('这是错的', 'sess-a', 'user');
      host.detectSync('这是错的', 'sess-b', 'user');
    }
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(10);
  });

  it('rate limit resets after one hour', async () => {
    vi.useFakeTimers();
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    for (let i = 0; i < 5; i++) {
      host.detectSync('这是错的', 'sess-reset', 'user');
    }
    vi.advanceTimersByTime(100);
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(5);
    vi.clearAllMocks();
    vi.advanceTimersByTime(60 * 60 * 1000 + 100);
    host.detectSync('这是错的', 'sess-reset', 'user');
    vi.advanceTimersByTime(100);
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('LLM disabled in config → no async enqueue even for ambiguous terms', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, enableLlmStage: false },
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.9, reason: 'test',
      }),
    });
    host.detectSync('这个不对', 'sess-no-llm', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalled();
  });

  it('no trajectory → detectSync continues without writing user_turns', () => {
    const wctx = {
      workspaceDir: '/tmp/test-ws',
      stateDir: '/tmp/test-ws/.state',
      trajectory: null,
    };
    const host = makeHost(
      wctx as unknown as ConstructorParameters<typeof SignalCollectorHost>[0],
      { keywordStore: testStore, config: testConfig },
    );
    expect(() => {
      host.detectSync('这是错的', 'sess-no-trajectory', 'user');
    }).not.toThrow();
  });

  it('empty keyword store → no signal detected', () => {
    const emptyStore: UnifiedKeywordStore = {
      version: 1,
      terms: {},
    };
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: emptyStore, config: testConfig });
    host.detectSync('这是错的', 'sess-empty-store', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalled();
  });

  it('keyword store with only empathy terms → empathy ambiguous routed as WEAK when LLM unavailable', async () => {
    const empathyOnlyStore: UnifiedKeywordStore = {
      version: 1,
      terms: {
        '搞什么': { term: '搞什么', category: 'empathy', weight: 0.5, precision: 'ambiguous', source: 'seed' },
        '气死我了': { term: '气死我了', category: 'empathy', weight: 0.7, precision: 'high', source: 'seed' },
      },
    };
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: empathyOnlyStore, config: testConfig });
    host.detectSync('你搞什么啊', 'sess-empathy-only', 'user');
    await flushAsync();
    expect(trackFriction).toHaveBeenCalledTimes(1);
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('keyword store with only correction terms → correction ambiguous dropped when LLM unavailable', async () => {
    const correctionOnlyStore: UnifiedKeywordStore = {
      version: 1,
      terms: {
        '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
        '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
      },
    };
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: correctionOnlyStore, config: testConfig });
    host.detectSync('这个不对', 'sess-correction-only', 'user');
    await flushAsync();
    expect(trackFriction).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('very long user message → handled without crash', () => {
    const longMessage = '这是错的'.repeat(1000);
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    expect(() => {
      host.detectSync(longMessage, 'sess-long', 'user');
    }).not.toThrow();
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalled();
  });

  it('message with special characters → handled without crash', () => {
    const specialMessage = '这是错的!@#$%^&*()_+-=[]{}|;:,.<>?~`';
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    expect(() => {
      host.detectSync(specialMessage, 'sess-special', 'user');
    }).not.toThrow();
  });

  it('message with emoji → handled without crash', () => {
    const emojiMessage = '这是错的 😡🔥';
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    expect(() => {
      host.detectSync(emojiMessage, 'sess-emoji', 'user');
    }).not.toThrow();
  });

  it('rate limit of 0 → all STRONG signals suppressed', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, strongRateLimitPerHour: 0 },
    });
    host.detectSync('这是错的', 'sess-zero-rate', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('rate limit of 1000 → no suppression for normal usage', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, strongRateLimitPerHour: 1000 },
    });
    for (let i = 0; i < 10; i++) {
      host.detectSync('这是错的', 'sess-high-rate', 'user');
    }
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(10);
  });

  it('empty sessionId → handled without crash', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    expect(() => {
      host.detectSync('这是错的', '', 'user');
    }).not.toThrow();
  });

  it('sessionId with special characters → handled without crash', () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    expect(() => {
      host.detectSync('这是错的', 'sess@#$%^&*()', 'user');
    }).not.toThrow();
  });

  it('mixed empathy and correction keywords in same message → correct routing', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.9, reason: 'mixed message',
      }),
    });
    host.detectSync('你搞什么啊，这是错的', 'sess-mixed', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalled();
  });
});
