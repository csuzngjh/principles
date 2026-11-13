import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '@principles/core/runtime';

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
vi.mock('../../src/utils/trace-id.js', () => ({
  createTraceId: vi.fn(() => 'trace-mock'),
}));

import { SignalCollectorHost, DEFAULT_SIGNAL_CONFIG, buildDefaultKeywordStore } from '../../src/core/signal-collector-host.js';
import { readSignalHealth } from '../../src/core/signal-health.js';
import { safeRmDir } from '../test-utils.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import { trackFriction } from '../../src/core/session-tracker.js';
import { SystemLogger } from '../../src/core/system-logger.js';

// ── 测试用统一词库 (与 core 测试对齐) ────────────────────────────────────────

const testStore: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '搞什么': { term: '搞什么', weight: 0.5, precision: 'ambiguous', source: 'seed' },
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
    // PRI-642: emitters no longer assemble provenance/hostKind — the shared
    // ingress in the pain funnel derives them (automatic hook →
    // automatic_hook, hostKind openclaw). The emitter payload carries only
    // correlation facts + inline evidence.
    expect(callArg.data.provenance).toBeUndefined();
    expect(callArg.data.hostKind).toBeUndefined();
  });

  // ══ P1-3 (review round): correction OCCURRENCE identity ═══════════════════
  // Same real occurrence retry → SAME canonical pain; same text in a later
  // real turn → NEW pain occurrence (the "principle didn't take" signal must
  // not be swallowed by permanent dedup).

  it('same-run retry after user_turn persistence failure reuses Stage1 and the pending LLM decision', async () => {
    const wctx = makeMockWctx();
    const recordUserTurn = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(42);
    const markUserTurnCorrection = vi.fn().mockReturnValue(true);
    wctx.trajectory.recordUserTurn = recordUserTurn;
    (wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>).markUserTurnCorrection = markUserTurnCorrection;

    let resolveClassifier: ((value: {
      is_feedback: boolean; type: 'correction' | 'none'; confidence: number; reason: string;
    } | null) => void) | undefined;
    const llmClassifier = vi.fn(() => new Promise<{
      is_feedback: boolean; type: 'correction' | 'none'; confidence: number; reason: string;
    } | null>((resolve) => { resolveClassifier = resolve; }));
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig, llmClassifier });
    const options = { turnIndex: 10, idempotencyKey: 'sess-retry\u0000run-1' };

    const first = host.detectSync('这个不对', 'sess-retry', 'user', options);
    expect(first.status).toBe('user_turn_persist_failed');
    expect(llmClassifier).toHaveBeenCalledTimes(1);

    const retry = host.detectSync('这个不对', 'sess-retry', 'user', options);
    expect(retry).toEqual({ status: 'user_turn_persisted', userTurnRowid: 42 });
    expect(recordUserTurn).toHaveBeenCalledTimes(2);
    expect(llmClassifier).toHaveBeenCalledTimes(1);

    resolveClassifier?.({ is_feedback: true, type: 'correction', confidence: 0.9, reason: 'confirmed correction' });
    await flushAsync();

    // The in-flight Stage2 verdict is rebound to the row created by the retry.
    expect(markUserTurnCorrection).toHaveBeenCalledWith(42, '不对');
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);

    // A later duplicate callback reuses the successful persistence result too.
    const replay = host.detectSync('这个不对', 'sess-retry', 'user', options);
    expect(replay).toEqual({ status: 'user_turn_persisted', userTurnRowid: 42 });
    expect(recordUserTurn).toHaveBeenCalledTimes(2);
    expect(llmClassifier).toHaveBeenCalledTimes(1);
  });

  it('same-run retry after a failed user_turn write does not route a STRONG signal twice', async () => {
    const wctx = makeMockWctx();
    const recordUserTurn = vi.fn().mockReturnValueOnce(undefined).mockReturnValueOnce(77);
    wctx.trajectory.recordUserTurn = recordUserTurn;
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    const options = { turnIndex: 4, idempotencyKey: 'sess-strong\u0000run-strong' };

    const first = host.detectSync('这是错的', 'sess-strong', 'user', options);
    expect(first.status).toBe('user_turn_persist_failed');
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);

    const retry = host.detectSync('这是错的', 'sess-strong', 'user', options);
    expect(retry).toEqual({ status: 'user_turn_persisted', userTurnRowid: 77 });
    await flushAsync();

    expect(recordUserTurn).toHaveBeenCalledTimes(2);
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('P1-3 same occurrence retry (same session, same turnIndex) → same canonical pain id', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess-occ', 'user', { turnIndex: 10 });
    await flushAsync();
    const firstId = (vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { painId: string } }).data.painId;
    expect(firstId).toMatch(/^pain_host_[0-9a-f]{64}$/);
    // Retry of the same occurrence (same turnIndex) → identical id.
    vi.clearAllMocks();
    host.detectSync('这是错的', 'sess-occ', 'user', { turnIndex: 10 });
    await flushAsync();
    const retryId = (vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { painId: string } }).data.painId;
    expect(retryId).toBe(firstId);
  });

  it('P1-3 same text in a LATER real turn → NEW pain occurrence', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });
    host.detectSync('这是错的', 'sess-occ2', 'user', { turnIndex: 10 });
    await flushAsync();
    const firstId = (vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { painId: string } }).data.painId;
    // The owner corrects the SAME mistake again at turn 37 — a real recurrence,
    // not a retry: must produce a DIFFERENT canonical pain.
    vi.clearAllMocks();
    host.detectSync('这是错的', 'sess-occ2', 'user', { turnIndex: 37 });
    await flushAsync();
    const secondId = (vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { painId: string } }).data.painId;
    expect(secondId).not.toBe(firstId);
  });

  it('P1-3 async LLM-confirmed path preserves the occurrence identity', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({ is_feedback: true, type: 'correction', confidence: 0.9, reason: '明确纠错' }),
    });
    host.detectSync('这个不对', 'sess-async-occ', 'user', { turnIndex: 21 });
    await flushAsync();
    const confirmedId = (vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { painId: string } }).data.painId;
    // Same occurrence through the async path again → same id.
    vi.clearAllMocks();
    host.detectSync('这个不对', 'sess-async-occ', 'user', { turnIndex: 21 });
    await flushAsync();
    const retryId = (vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { painId: string } }).data.painId;
    expect(retryId).toBe(confirmedId);
    // A different turn of the same text → different id.
    vi.clearAllMocks();
    host.detectSync('这个不对', 'sess-async-occ', 'user', { turnIndex: 22 });
    await flushAsync();
    const laterId = (vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { painId: string } }).data.painId;
    expect(laterId).not.toBe(confirmedId);
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

  it('PRI-812 C characterization: earned-high learned term → deterministic STRONG fast path, Stage2 skipped, no realtime cue feedback', async () => {
    // 复现 PRI-807 R-21#3 的真实形态：llm 学习词经 earned precision（TP≥3 且
    // FP=0）升 high 后，realtime 命中走确定性 STRONG 快速路径——不经 Stage2、
    // 不产生 TP/FP 反馈。本测试固化该快速路径契约（§5 禁止为降级而每次重跑
    // Stage2），反证只能来自异步 CorrectionObserver → applyResult 链（该链的
    // FP-only 裁决投递由 keyword-optimization-service / correction-observer-
    // service 测试与 earned-high-demotion-roundtrip 测试覆盖）。
    const wctx = makeMockWctx();
    const llmClassifier = vi.fn();
    const cueFeedbackRecorder = vi.fn();
    // 与 createSharedCorrectionKeywordStore 对 llm+TP≥3+FP=0 的投影一致
    const earnedHighStore: UnifiedKeywordStore = {
      version: 2,
      terms: {
        '先确认再改': { term: '先确认再改', weight: 0.5, precision: 'high', source: 'llm_learned' },
      },
    };
    const host = makeHost(wctx, { keywordStore: earnedHighStore, config: testConfig, llmClassifier, cueFeedbackRecorder });

    host.detectSync('请你先确认再改，刚才的方案不对', 'sess-earned-high', 'user', { turnIndex: 3 });
    await flushAsync();

    // 确定性快速路径：不重跑 Stage2 LLM
    expect(llmClassifier).not.toHaveBeenCalled();
    // realtime 路径不产生关键词 TP/FP 反馈（升 high 后 realtime 零反馈是现状）
    expect(cueFeedbackRecorder).not.toHaveBeenCalled();
    // 但 STRONG 分流与证据写入照常：pain 事件 + user_turns 标记 + 命中词留痕
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledWith(expect.objectContaining({
      correctionDetected: true,
      correctionCue: '先确认再改',
    }));
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

  it('keyword store with only correction terms → correction ambiguous dropped when LLM unavailable', async () => {
    const correctionOnlyStore: UnifiedKeywordStore = {
      version: 1,
      terms: {
        '不对': { term: '不对', weight: 0.5, precision: 'ambiguous', source: 'seed' },
        '这是错的': { term: '这是错的', weight: 0.9, precision: 'high', source: 'seed' },
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

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-788 G1 — Stage2 确认回写 correction_detected
// ═══════════════════════════════════════════════════════════════════════════════

describe('PRI-788 G1: Stage2 确认回写 correction_detected', () => {
  beforeEach(() => vi.clearAllMocks());

  type MockTrajectory = {
    recordUserTurn: ReturnType<typeof vi.fn>;
    markUserTurnCorrection: ReturnType<typeof vi.fn>;
  };

  function makeWctxWithRowid(rowid: number | undefined, markResult: boolean | undefined) {
    const wctx = makeMockWctx();
    const trajectory = wctx.trajectory as unknown as MockTrajectory;
    trajectory.recordUserTurn = vi.fn().mockReturnValue(rowid);
    trajectory.markUserTurnCorrection = vi.fn().mockReturnValue(markResult);
    return { ...wctx, trajectory };
  }

  it('LLM confirms ambiguous correction → markUserTurnCorrection called with captured rowid + llm cue', async () => {
    const wctx = makeWctxWithRowid(42, true);
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.9, reason: '明确指出改错了文件',
      }),
    });

    host.detectSync('这个不对', 'sess-g1', 'user');
    await flushAsync();

    expect(wctx.trajectory.markUserTurnCorrection).toHaveBeenCalledTimes(1);
    // correction_cue 的语义是"哪个词命中的"：Stage1 命中了 '不对'，回写就必须保留
    // 这个词，不能被 LLM 判词覆盖（判词曾把 54/58 行的词位写成散文，喂给词库优化器
    // 后整句被当成关键词入库）。
    expect(wctx.trajectory.markUserTurnCorrection).toHaveBeenCalledWith(42, '不对');
    // 回写独立于 pain 事件——事件照常发出
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('rowid no longer exists (mark returns false) → SIGNAL_WRITEBACK_MISS logged, pain still emitted', async () => {
    const wctx = makeWctxWithRowid(42, false);
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.9, reason: 'cue',
      }),
    });

    host.detectSync('这个不对', 'sess-g1-miss', 'user');
    await flushAsync();

    expect(SystemLogger.log).toHaveBeenCalledWith(
      '/tmp/test-ws', 'SIGNAL_WRITEBACK_MISS', expect.stringContaining('42'),
    );
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('markUserTurnCorrection throws → SIGNAL_WRITEBACK_FAIL logged, pain still emitted (rc-9 no silent swallow)', async () => {
    const wctx = makeWctxWithRowid(42, true);
    (wctx.trajectory.markUserTurnCorrection as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('db locked');
    });
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.9, reason: 'cue',
      }),
    });

    host.detectSync('这个不对', 'sess-g1-fail', 'user');
    await flushAsync();

    expect(SystemLogger.log).toHaveBeenCalledWith(
      '/tmp/test-ws', 'SIGNAL_WRITEBACK_FAIL', expect.stringContaining('db locked'),
    );
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('recordUserTurn unavailable (no rowid) → write-back skipped entirely', async () => {
    const wctx = makeWctxWithRowid(undefined, true);
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.9, reason: 'cue',
      }),
    });

    host.detectSync('这个不对', 'sess-g1-norow', 'user');
    await flushAsync();

    expect(wctx.trajectory.markUserTurnCorrection).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('LLM says none → no write-back', async () => {
    const wctx = makeWctxWithRowid(42, true);
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: false, type: 'none', confidence: 1, reason: '普通指令',
      }),
    });

    host.detectSync('这个不对', 'sess-g1-none', 'user');
    await flushAsync();

    expect(wctx.trajectory.markUserTurnCorrection).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-788 G2 — LLM 不可用 → 候选持久化入队（不再丢弃）
// ═══════════════════════════════════════════════════════════════════════════════

describe('PRI-788 G2: LLM 不可用时候选持久化入队', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeWctxForQueue(withRowid = true) {
    const wctx = makeMockWctx();
    const trajectory = wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>;
    trajectory.recordUserTurn = vi.fn().mockReturnValue(withRowid ? 77 : undefined);
    trajectory.enqueueSignalConfirmation = vi.fn();
    trajectory.markUserTurnCorrection = vi.fn();
    return { ...wctx, trajectory };
  }

  it('LLM unavailable + correction-ambiguous → enqueueSignalConfirmation called with correction suggestedType', async () => {
    const wctx = makeWctxForQueue();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null, // 通道死 → 走降级分支
    });

    host.detectSync('这个不对', 'sess-g2', 'user');
    await flushAsync();

    expect(wctx.trajectory.enqueueSignalConfirmation).toHaveBeenCalledTimes(1);
    const arg = wctx.trajectory.enqueueSignalConfirmation.mock.calls[0][0];
    expect(arg).toMatchObject({ sessionId: 'sess-g2', userTurnRowid: 77, suggestedType: 'correction' });
    expect(arg.terms).toContain('不对');
    expect(SystemLogger.log).toHaveBeenCalledWith(
      '/tmp/test-ws', 'SIGNAL_CONFIRMATION_QUEUED', expect.stringContaining('llm_unavailable'),
    );
  });

  it('zero keyword match → no enqueue (体量与噪声不可控)', async () => {
    const wctx = makeWctxForQueue();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null,
    });

    host.detectSync('帮我看看这个函数的命名', 'sess-g2-nomatch', 'user');
    await flushAsync();

    expect(wctx.trajectory.enqueueSignalConfirmation).not.toHaveBeenCalled();
  });

  it('recordUserTurn returned no rowid → no enqueue (无行可回写)', async () => {
    const wctx = makeWctxForQueue(false);
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null,
    });

    host.detectSync('这个不对', 'sess-g2-norow', 'user');
    await flushAsync();

    expect(wctx.trajectory.enqueueSignalConfirmation).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-788 G2 — confirmPendingSignal 批量确认分流
// ═══════════════════════════════════════════════════════════════════════════════

describe('PRI-788 G2: confirmPendingSignal', () => {
  beforeEach(() => vi.clearAllMocks());

  const item = { sessionId: 'sess-c', userTurnRowid: 55, occurrenceId: 'occ-55', excerpt: '这个不对' };

  function makeWctx() {
    const wctx = makeMockWctx();
    const trajectory = wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>;
    trajectory.recordUserTurn = vi.fn();
    trajectory.markUserTurnCorrection = vi.fn().mockReturnValue(true);
    return { ...wctx, trajectory };
  }

  it('classified correction → write-back + pain emit, disposition confirmed', async () => {
    const wctx = makeWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });

    const result = await host.confirmPendingSignal(item, async () => ({
      is_feedback: true, type: 'correction', confidence: 0.9, reason: '确认是纠正',
    }));

    expect(result.disposition).toBe('confirmed');
    // 队列项未带命中词（item.terms 缺失）→ 回退到判词，保留可追溯的 why。
    expect(wctx.trajectory.markUserTurnCorrection).toHaveBeenCalledWith(55, 'llm:确认是纠正');
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('classified none → rejected, no write-back no emit', async () => {
    const wctx = makeWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });

    const result = await host.confirmPendingSignal(item, async () => ({
      is_feedback: false, type: 'none', confidence: 1, reason: '普通聊天',
    }));

    expect(result.disposition).toBe('rejected');
    expect(wctx.trajectory.markUserTurnCorrection).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('classifier returns null / throws → disposition failed (调用方 attempts++)', async () => {
    const wctx = makeWctx();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig });

    const unavailable = await host.confirmPendingSignal(item, async () => null);
    const threw = await host.confirmPendingSignal(item, async () => {
      throw new Error('timeout');
    });

    expect(unavailable.disposition).toBe('failed');
    expect(threw.disposition).toBe('failed');
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-788 G3 — cueFeedbackRecorder（earned precision 证据源）
// ═══════════════════════════════════════════════════════════════════════════════

describe('PRI-788 G3: cueFeedbackRecorder TP/FP 反馈', () => {
  beforeEach(() => vi.clearAllMocks());

  it('LLM confirms STRONG → recorder called with matched terms + true', async () => {
    const wctx = makeMockWctx();
    (wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>).recordUserTurn =
      vi.fn().mockReturnValue(1);
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({ is_feedback: true, type: 'correction', confidence: 0.9, reason: 'cue' }),
      cueFeedbackRecorder: recorder,
    });

    host.detectSync('这个不对', 'sess-g3-tp', 'user');
    await flushAsync();

    expect(recorder).toHaveBeenCalledWith(['不对'], true);
  });

  it('LLM says none → recorder called with false; degraded (no verdict) → recorder NOT called', async () => {
    const wctx = makeMockWctx();
    (wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>).recordUserTurn =
      vi.fn().mockReturnValue(1);
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({ is_feedback: false, type: 'none', confidence: 1, reason: '普通' }),
      cueFeedbackRecorder: recorder,
    });

    host.detectSync('这个不对', 'sess-g3-fp', 'user');
    await flushAsync();
    expect(recorder).toHaveBeenCalledWith(['不对'], false);

    // 无 verdict 的降级分支不算 FP（通道死≠词错）
    const host2 = makeHost(wctx, { keywordStore: testStore, config: testConfig, cueFeedbackRecorder: recorder });
    host2.detectSync('这个不对', 'sess-g3-degraded', 'user');
    await flushAsync();
    expect(recorder).toHaveBeenCalledTimes(1);
  });

  it('confirmPendingSignal forwards terms feedback: confirmed→true, rejected→false', async () => {
    const wctx = makeMockWctx();
    const recorder = vi.fn();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig, cueFeedbackRecorder: recorder });
    // PRI-2053: terms 携带归因验证标志；未验证的旧队列行会保守降级为无关键词证据。
    const batchItem = { sessionId: 's', userTurnRowid: 9, occurrenceId: 'occ-9', excerpt: '这个不对', terms: ['不对'], termsVerified: true };

    await host.confirmPendingSignal(batchItem, async () => ({
      is_feedback: true, type: 'correction', confidence: 0.9, reason: 'cue',
    }));
    expect(recorder).toHaveBeenLastCalledWith(['不对'], true);

    await host.confirmPendingSignal(batchItem, async () => ({
      is_feedback: false, type: 'none', confidence: 1, reason: 'none',
    }));
    expect(recorder).toHaveBeenLastCalledWith(['不对'], false);
  });

  it('recorder throwing does not block routing (SIGNAL_CUE_FEEDBACK_FAIL)', async () => {
    const wctx = makeMockWctx();
    (wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>).recordUserTurn =
      vi.fn().mockReturnValue(1);
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({ is_feedback: true, type: 'correction', confidence: 0.9, reason: 'cue' }),
      cueFeedbackRecorder: () => { throw new Error('learner broke'); },
    });

    host.detectSync('这个不对', 'sess-g3-throw', 'user');
    await flushAsync();

    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    expect(SystemLogger.log).toHaveBeenCalledWith('/tmp/test-ws', 'SIGNAL_CUE_FEEDBACK_FAIL', expect.stringContaining('learner broke'));
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-2053 — Stage2 归因不变量
//
// Stage2 确认「整条消息是纠正」只证明消息级事实，归因词集必须取 Stage1 检测
// 当时的命中词快照：不补词、不伪造、不落 llm: 判词；Stage2 判非 correction 时
// 命中词只记 FP。GFI 移除后词库已不存在 empathy 类别（seed 只含纠正词，学习
// 投影也只会产出纠正词），因此「empathy 词混入纠正证据」在词表层面不可达。
// ═══════════════════════════════════════════════════════════════════════════════

describe('PRI-2053: Stage2 归因不变量', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeWctxForAttribution(rowid = 11) {
    const wctx = makeMockWctx();
    const trajectory = wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>;
    trajectory.recordUserTurn = vi.fn().mockReturnValue(rowid);
    trajectory.markUserTurnCorrection = vi.fn().mockReturnValue(true);
    return { wctx, trajectory };
  }

  const correctionVerdict = async () => ({
    is_feedback: true, type: 'correction' as const, confidence: 0.9, reason: '用户不满',
  });

  it('Stage2 判 correction + 只命中 ambiguous 词 → 消息确认，纠正词证据 = Stage1 命中词（不伪造）', async () => {
    const { wctx, trajectory } = makeWctxForAttribution();
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: correctionVerdict,
      cueFeedbackRecorder: recorder,
    });

    host.detectSync('这个不对', 'sess-p13-ambiguous-only', 'user');
    await flushAsync();

    // 消息级纠正事实必须保留（这是真实发生的事件，不能因关键词过滤被丢）
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    // stage2 corrected：归因词集只取 Stage1 检测当时的命中词，不补词、不落 llm: 判词
    expect(trajectory.markUserTurnCorrection).toHaveBeenCalledWith(11, '不对');
    expect(recorder).toHaveBeenCalledWith(['不对'], true);
  });

  it('两个 ambiguous 词同时命中 → 两个命中词都参与纠正词归因（按命中顺序）', async () => {
    const { wctx, trajectory } = makeWctxForAttribution();
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: correctionVerdict,
      cueFeedbackRecorder: recorder,
    });

    // '不对' 与 '搞什么' 同为 ambiguous 命中；刻意不用 high 精度词：
    // high 会短路同步 STRONG 路径，证明不了异步确认路径的归因。
    host.detectSync('这个不对，你搞什么啊', 'sess-p13-multi', 'user');
    await flushAsync();

    expect(recorder).toHaveBeenCalledWith(['不对', '搞什么'], true);
    expect(trajectory.markUserTurnCorrection).toHaveBeenCalledWith(11, '不对, 搞什么');
  });

  it('仅命中 correction ambiguous 词 → 原有归因不变', async () => {
    const { wctx, trajectory } = makeWctxForAttribution();
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: correctionVerdict,
      cueFeedbackRecorder: recorder,
    });

    host.detectSync('这个不对', 'sess-p13-correction-only', 'user');
    await flushAsync();

    expect(recorder).toHaveBeenCalledWith(['不对'], true);
    expect(trajectory.markUserTurnCorrection).toHaveBeenCalledWith(11, '不对');
  });

  it('Stage2 判非 correction → 命中词只记 FP，不产生纠正词证据', async () => {
    const { wctx } = makeWctxForAttribution();
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: false, type: 'none' as const, confidence: 1, reason: '普通消息',
      }),
      cueFeedbackRecorder: recorder,
    });

    host.detectSync('你搞什么啊', 'sess-p13-none', 'user');
    await flushAsync();

    // 命中词只作为 FP（wasCorrection=false）反馈，不升级为纠正词证据
    expect(recorder).toHaveBeenCalledWith(['搞什么'], false);
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('批量恢复路径与实时路径归因一致；旧格式行保守降级（不伪造证据）', async () => {
    const { wctx, trajectory } = makeWctxForAttribution();
    const recorder = vi.fn();
    const host = makeHost(wctx, { keywordStore: testStore, config: testConfig, cueFeedbackRecorder: recorder });

    // 新格式队列行（enqueue 时已按 Stage1 快照筛过）→ 与实时路径一致
    const confirmed = await host.confirmPendingSignal(
      {
        sessionId: 's', userTurnRowid: 20, occurrenceId: '20',
        excerpt: '你搞什么啊，这个不对', terms: ['不对'], termsVerified: true,
      },
      correctionVerdict,
    );
    expect(confirmed.disposition).toBe('confirmed');
    expect(recorder).toHaveBeenLastCalledWith(['不对'], true);

    // 旧格式队列行（只存了原始命中词，无当时的类别快照）→ 保守降级：
    // 不得把其中任何词当作纠正词证据，但消息级纠正事实仍保留。
    const legacy = await host.confirmPendingSignal(
      {
        sessionId: 's', userTurnRowid: 21, occurrenceId: '21',
        excerpt: '你搞什么啊', terms: ['搞什么'],
      },
      correctionVerdict,
    );
    expect(legacy.disposition).toBe('confirmed');
    expect(recorder).toHaveBeenCalledTimes(1); // 未新增
    expect(trajectory.markUserTurnCorrection).toHaveBeenCalledWith(21, 'llm:用户不满');
    expect(SystemLogger.log).toHaveBeenCalledWith(
      '/tmp/test-ws', 'SIGNAL_CONFIRMATION_ATTRIBUTION_UNVERIFIED', expect.any(String),
    );
  });

  it('LLM 抛错入队时持久化 Stage1 命中词（恢复侧无需历史快照）', async () => {
    const { wctx, trajectory } = makeWctxForAttribution();
    trajectory.enqueueSignalConfirmation = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: testConfig,
      // LLM 存在但抛错：入队分支把 Stage1 检测当时的命中词原样落库 ——
      // 归因必须在入队时完成，否则恢复侧只能拿到未分类的词。
      llmClassifier: async () => { throw new Error('channel dead'); },
    });

    host.detectSync('你搞什么啊，这个不对', 'sess-p13-queue', 'user');
    await flushAsync();

    expect(trajectory.enqueueSignalConfirmation).toHaveBeenCalledTimes(1);
    const arg = trajectory.enqueueSignalConfirmation.mock.calls[0][0];
    expect(arg.terms).toEqual(['不对', '搞什么']); // Stage1 命中词快照，不依赖恢复时词库
    expect(arg.suggestedType).toBe('correction');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRI-687 回归 — 强烈 Owner 纠正不再漏检；纯宣泄不误报
//
// Live 原文（2026-09-05，ticket 实例）：当时 correction_detected=0，原因链=
// 学习词命中但恒 ambiguous + Stage2 确认不回写。修复来源：PRI-788（G1 回写 /
// G2 持久队列 / G3 earned precision）。以下两条钉住 ticket 的验收证据。
// ═══════════════════════════════════════════════════════════════════════════════

const LIVE_TURN_TEXT = '什么狗屎，这个根本不是我们讨论的第二集的内容，第二集说的是PD内置的10个原则，你说的信任这个狗屁主题是哪里冒出来的';

// live 词库投影：这几个词已被 CorrectionObserver 学入 correction_keywords.json（source=llm→ambiguous）
const pri687LearnedStore: UnifiedKeywordStore = {
  version: 2,
  terms: {
    '什么狗屎': { term: '什么狗屎', weight: 0.9, precision: 'ambiguous', source: 'llm_learned' },
    '根本不是': { term: '根本不是', weight: 0.8, precision: 'ambiguous', source: 'llm_learned' },
    '狗屁': { term: '狗屁', weight: 0.85, precision: 'ambiguous', source: 'llm_learned' },
    '哪里冒出来的': { term: '哪里冒出来的', weight: 0.6, precision: 'ambiguous', source: 'llm_learned' },
  },
};

describe('PRI-687 回归：强烈 Owner 纠正端到端可检出', () => {
  beforeEach(() => vi.clearAllMocks());

  function makeWctxWithRowid(rowid: number | undefined) {
    const wctx = makeMockWctx();
    const trajectory = wctx.trajectory as unknown as Record<string, ReturnType<typeof vi.fn>>;
    trajectory.recordUserTurn = vi.fn().mockReturnValue(rowid);
    trajectory.markUserTurnCorrection = vi.fn().mockReturnValue(true);
    trajectory.enqueueSignalConfirmation = vi.fn();
    return { ...wctx, trajectory };
  }

  it('live 原文：Stage1 歧义命中学习词，LLM 确认 correction → 回写标志位 + pain 事件（owner_message 证据可生成）', async () => {
    const wctx = makeWctxWithRowid(14); // ticket 实例：turn 14
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: pri687LearnedStore,
      config: testConfig,
      llmClassifier: async () => ({
        is_feedback: true, type: 'correction', confidence: 0.95,
        reason: '用户否定了 AI 编造的主题并重述了正确内容',
      }),
      cueFeedbackRecorder: recorder,
    });

    host.detectSync(LIVE_TURN_TEXT, '82177127-db59-4d49-b4bd-8fe9301e050e', 'user');
    await flushAsync();

    // Stage1 确实命中了学习词（ticket 当时的漏检点）
    expect(recorder).toHaveBeenCalled();
    const [terms, wasCorrection] = recorder.mock.calls[0];
    expect(terms.length).toBeGreaterThan(0);
    expect(terms).toContain('什么狗屎');
    expect(wasCorrection).toBe(true);
    // G1 回写：标志位翻转，owner_message 证据通道恢复。
    // 词位保留 Stage1 命中的学习词，不再被 'llm:<判词>' 覆盖——命中词是
    // earned precision 与词库优化归因的唯一依据。
    expect(wctx.trajectory.markUserTurnCorrection).toHaveBeenCalledWith(
      14, expect.stringContaining('什么狗屎'),
    );
    expect(wctx.trajectory.markUserTurnCorrection).not.toHaveBeenCalledWith(
      14, expect.stringContaining('llm:'),
    );
    // pain 事件照发
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { data: { source: string } };
    expect(callArg.data.source).toBe('user_correction');
  });

  it('负向：纯宣泄脏话（无纠正语义）→ Stage2 判 none，不翻转标志位、不触发 pain', async () => {
    const wctx = makeWctxWithRowid(15);
    const recorder = vi.fn();
    const host = makeHost(wctx, {
      keywordStore: pri687LearnedStore,
      config: testConfig,
      // GFI 移除后 Stage2 只有 correction / none 两态：纯宣泄归 none。
      llmClassifier: async () => ({
        is_feedback: false, type: 'none', confidence: 0.8,
        reason: '纯宣泄情绪，未否定具体产出也未重述期望',
      }),
      cueFeedbackRecorder: recorder,
    });

    host.detectSync('什么狗屎，烦死了', 'sess-pri687-neg', 'user');
    await flushAsync();

    // 脏话 ≠ 纠正：不回写标志位、不发 pain
    expect(wctx.trajectory.markUserTurnCorrection).not.toHaveBeenCalled();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    // 命中词记 FP（earned 证据的反向积累）
    expect(recorder).toHaveBeenCalledWith(expect.arrayContaining(['什么狗屎']), false);
  });
});

// ── PRI-844: correctionEvidence as first-class pain evidence ────────────────

describe('SignalCollectorHost — correctionEvidence (PRI-844)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('STRONG correction → emits correctionEvidence with the FULL user message (>200 chars, no excerpt cap)', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx);
    const longMessage = '这是错的，' + '部署脚本漏改了别只改眼前这一个文件'.repeat(15);
    host.detectSync(longMessage, 'sess-pri844', 'user', { turnIndex: 9, referencesAssistantTurnId: 8 });
    await flushAsync();
    expect(emitPainDetectedEvent).toHaveBeenCalled();
    const call = vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as {
      data: { correctionEvidence?: { text: string; sessionId?: string; turnIndex?: number; referencesAssistantTurnId?: number; occurredAt?: string } };
    };
    expect(call.data.correctionEvidence).toBeDefined();
    expect(call.data.correctionEvidence?.text).toBe(longMessage);
    expect((call.data.correctionEvidence?.text ?? '').length).toBeGreaterThan(200);
    expect(call.data.correctionEvidence?.turnIndex).toBe(9);
    expect(call.data.correctionEvidence?.referencesAssistantTurnId).toBe(8);
    expect(call.data.correctionEvidence?.sessionId).toBe('sess-pri844');
  });

  it('ambiguous empathy (WEAK) path emits no pain and no correctionEvidence (Case B)', async () => {
    const wctx = makeMockWctx();
    const host = makeHost(wctx);
    host.detectSync('搞什么呀这是', 'sess-pri844-b', 'user');
    await flushAsync();
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 零命中发现预算 (discoveryRateLimitPerHour)
//
// 真实语料里 93.5% 的 user 消息零命中关键词，旧行为是对每条这种消息都发起一次
// Stage2「发现新纠正词」调用。预算只封零命中发现，歧义命中（确认调用）不受影响。
// ═══════════════════════════════════════════════════════════════════════════════

describe('SignalCollectorHost discovery budget (P0-A)', () => {
  beforeEach(() => vi.clearAllMocks());

  let workspaceDir: string;
  let wctx: ReturnType<typeof makeMockWctx> & { stateDir: string };

  function setup(): void {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-disc-budget-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    wctx = {
      workspaceDir,
      stateDir,
      trajectory: { recordUserTurn: vi.fn() },
    } as unknown as ReturnType<typeof makeMockWctx> & { stateDir: string };
  }

  afterEach(() => {
    if (workspaceDir) safeRmDir(workspaceDir);
  });

  it('default config caps zero-match discovery at 6/hour', () => {
    expect(DEFAULT_SIGNAL_CONFIG.discoveryRateLimitPerHour).toBe(6);
  });

  it('zero-match discovery stops after the budget, and the skip is counted', async () => {
    setup();
    const llmClassifier = vi.fn(async () => ({ is_feedback: false, type: 'none', confidence: 1, reason: '普通' }));
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, discoveryRateLimitPerHour: 2 },
      llmClassifier,
    });

    for (let i = 0; i < 3; i++) {
      host.detectSync('今天想聊聊下周的计划', `sess-disc-${i}`, 'user', { turnIndex: i });
    }
    await flushAsync();

    expect(llmClassifier).toHaveBeenCalledTimes(2);
    expect(readSignalHealth(wctx.stateDir)?.stage2DiscoverySkipped).toBe(1);
    // 被配额挡下的消息仍然进入轨迹（检测降级不影响常规记录）
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledTimes(3);
  });

  it('ambiguous hits are confirmations, not discovery — the budget does not apply', async () => {
    setup();
    const llmClassifier = vi.fn(async () => ({ is_feedback: false, type: 'none', confidence: 1, reason: '普通' }));
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, discoveryRateLimitPerHour: 1 },
      llmClassifier,
    });

    for (let i = 0; i < 3; i++) {
      host.detectSync('这个不对', 'sess-amb-disc', 'user', { turnIndex: i });
    }
    await flushAsync();

    expect(llmClassifier).toHaveBeenCalledTimes(3);
    expect(readSignalHealth(wctx.stateDir)?.stage2DiscoverySkipped).toBe(0);
  });

  it('no classifier ⇒ no LLM call and no budget consumed (degraded path unchanged)', async () => {
    setup();
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, discoveryRateLimitPerHour: 1 },
      llmClassifier: null,
    });

    for (let i = 0; i < 3; i++) {
      host.detectSync('今天想聊聊下周的计划', 'sess-disc-degraded', 'user', { turnIndex: i });
    }
    await flushAsync();

    expect(readSignalHealth(wctx.stateDir)?.stage2DiscoverySkipped).toBe(0);
    expect(readSignalHealth(wctx.stateDir)?.stage2Invocations).toBe(0);
  });

  it('limit 0 / unset keeps the old unlimited behavior', async () => {
    setup();
    const llmClassifier = vi.fn(async () => ({ is_feedback: false, type: 'none', confidence: 1, reason: '普通' }));
    const host = makeHost(wctx, {
      keywordStore: testStore,
      config: { ...testConfig, discoveryRateLimitPerHour: 0 },
      llmClassifier,
    });

    for (let i = 0; i < 8; i++) {
      host.detectSync('今天想聊聊下周的计划', 'sess-disc-unlimited', 'user', { turnIndex: i });
    }
    await flushAsync();

    expect(llmClassifier).toHaveBeenCalledTimes(8);
    expect(readSignalHealth(wctx.stateDir)?.stage2DiscoverySkipped).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// P1-1 (2026-11-13 real-host E2E): the Owner sentence that was missed
//
// 「这种没有数据支撑的激进改动我不接受。以后改配置参数前，先说明依据和影响，
//  等我确认后再动手。」
// It was zero-match, so the zero-hit discovery budget swallowed it. The new
// candidates stay ambiguous: they enter Stage 2 and only become a Pain after
// the existing LLM confirmation.
// ═══════════════════════════════════════════════════════════════════════════════

const OWNER_REGRESSION_SENTENCE =
  '这种没有数据支撑的激进改动我不接受。以后改配置参数前，先说明依据和影响，等我确认后再动手。';

describe('SignalCollectorHost — Owner correction regression (P1-1)', () => {
  beforeEach(() => vi.clearAllMocks());

  let workspaceDir: string;
  let wctx: ReturnType<typeof makeMockWctx> & { stateDir: string };

  function setup(): void {
    workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-owner-correction-'));
    const stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    wctx = {
      workspaceDir,
      stateDir,
      trajectory: { recordUserTurn: vi.fn() },
    } as unknown as ReturnType<typeof makeMockWctx> & { stateDir: string };
  }

  afterEach(() => {
    if (workspaceDir) safeRmDir(workspaceDir);
  });

  function confirmedClassifier() {
    return vi.fn(async (text: string) => ({
      is_feedback: text.includes('不接受') || text.includes('未经确认'),
      type: text.includes('不接受') || text.includes('未经确认') ? ('correction' as const) : ('none' as const),
      confidence: 0.92,
      reason: 'Owner 明确拒绝未经确认的参数改动',
    }));
  }

  it('A · the Owner sentence enters candidate discovery (no longer zero-match)', async () => {
    setup();
    const llmClassifier = confirmedClassifier();
    const host = makeHost(wctx, {
      keywordStore: buildDefaultKeywordStore(),
      config: { ...testConfig, discoveryRateLimitPerHour: 6 },
      llmClassifier,
    });

    host.detectSync(OWNER_REGRESSION_SENTENCE, 'sess-owner-a', 'user', { turnIndex: 1 });
    await flushAsync();

    expect(llmClassifier).toHaveBeenCalledTimes(1);
    expect(llmClassifier.mock.calls[0][0]).toBe(OWNER_REGRESSION_SENTENCE);
  });

  it('B · confirmed candidate becomes a user_correction Pain', async () => {
    setup();
    const host = makeHost(wctx, {
      keywordStore: buildDefaultKeywordStore(),
      config: { ...testConfig, discoveryRateLimitPerHour: 6 },
      llmClassifier: confirmedClassifier(),
    });

    host.detectSync(OWNER_REGRESSION_SENTENCE, 'sess-owner-b', 'user', { turnIndex: 1 });
    await flushAsync();

    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    const callArg = vi.mocked(emitPainDetectedEvent).mock.calls[0][1] as { type: string; data: { source: string } };
    expect(callArg.type).toBe('pain_detected');
    expect(callArg.data.source).toBe('user_correction');
  });

  it('C · one session exhausting zero-hit discovery cannot starve another session\'s explicit correction', async () => {
    setup();
    const llmClassifier = confirmedClassifier();
    const host = makeHost(wctx, {
      keywordStore: buildDefaultKeywordStore(),
      config: { ...testConfig, discoveryRateLimitPerHour: 6, discoveryRateLimitPerSessionPerHour: 2 },
      llmClassifier,
    });

    // Session A burns/attempts its whole ordinary-conversation budget.
    for (let i = 0; i < 5; i++) {
      host.detectSync(`今天想聊聊下周的计划 ${i}`, 'sess-chatty', 'user', { turnIndex: i });
    }
    // Session B then sends an explicit correction candidate.
    host.detectSync(OWNER_REGRESSION_SENTENCE, 'sess-owner-c', 'user', { turnIndex: 1 });
    await flushAsync();

    const calledTexts = llmClassifier.mock.calls.map(([text]) => String(text));
    expect(calledTexts).toContain(OWNER_REGRESSION_SENTENCE);
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
    expect(readSignalHealth(wctx.stateDir)?.stage2DiscoverySkipped).toBe(3);
  });

  it('D · a bare "不对" without LLM confirmation never becomes a Pain', async () => {
    setup();
    const llmClassifier = vi.fn(async () => ({ is_feedback: false, type: 'none' as const, confidence: 0.9, reason: '普通讨论' }));
    const host = makeHost(wctx, {
      keywordStore: buildDefaultKeywordStore(),
      config: testConfig,
      llmClassifier,
    });

    host.detectSync('这个不对', 'sess-owner-d', 'user', { turnIndex: 1 });
    await flushAsync();

    expect(llmClassifier).toHaveBeenCalledTimes(1);
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('E · ordinary chat / technical discussion / normal negation produces no Pains', async () => {
    setup();
    const llmClassifier = vi.fn(async () => ({ is_feedback: false, type: 'none' as const, confidence: 0.9, reason: '普通讨论' }));
    const host = makeHost(wctx, {
      keywordStore: buildDefaultKeywordStore(),
      config: { ...testConfig, discoveryRateLimitPerHour: 20 },
      llmClassifier,
    });

    const ordinary = [
      '这个参数没有依据时也可以先做实验验证',
      '我不同意这个实现方向，但我们先讨论一下',
      '这里的数据不对，可能是我看错了表',
      '帮我看看这个函数为什么返回空',
      '下周的发布计划需要再确认一次',
    ];
    ordinary.forEach((text, index) => {
      host.detectSync(text, 'sess-owner-e', 'user', { turnIndex: index });
    });
    await flushAsync();

    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
    expect(wctx.trajectory.recordUserTurn).toHaveBeenCalledTimes(ordinary.length);
  });

  it('F · budget exhaustion records a structured reason (scope + limit)', async () => {
    setup();
    const llmClassifier = vi.fn(async () => ({ is_feedback: false, type: 'none' as const, confidence: 1, reason: '普通' }));
    const host = makeHost(wctx, {
      keywordStore: buildDefaultKeywordStore(),
      config: { ...testConfig, discoveryRateLimitPerHour: 6, discoveryRateLimitPerSessionPerHour: 1 },
      llmClassifier,
    });

    for (let i = 0; i < 3; i++) {
      host.detectSync(`普通消息 ${i}`, 'sess-owner-f', 'user', { turnIndex: i });
    }
    await flushAsync();

    const logCalls = vi.mocked(SystemLogger.log).mock.calls.filter(([, code]) => code === 'SIGNAL_DISCOVERY_BUDGET_EXHAUSTED');
    expect(logCalls).toHaveLength(1);
    const payload = JSON.parse(String(logCalls[0][2])) as { scope: string; limit: number; sessionDigest: string };
    expect(payload.scope).toBe('session');
    expect(payload.limit).toBe(1);
    expect(payload.sessionDigest).toMatch(/^[0-9a-f]{12}$/);
    expect(readSignalHealth(wctx.stateDir)?.stage2DiscoverySkipped).toBe(2);
  });

  it('G · a retried identical message produces one Pain, not duplicates', async () => {
    setup();
    const host = makeHost(wctx, {
      keywordStore: buildDefaultKeywordStore(),
      config: testConfig,
      llmClassifier: confirmedClassifier(),
    });

    host.detectSync(OWNER_REGRESSION_SENTENCE, 'sess-owner-g', 'user', { turnIndex: 1, idempotencyKey: 'run-owner-g' });
    host.detectSync(OWNER_REGRESSION_SENTENCE, 'sess-owner-g', 'user', { turnIndex: 1, idempotencyKey: 'run-owner-g' });
    await flushAsync();

    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });
});
