import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '@principles/core/runtime-v2';

// mock 掉 host 依赖的副作用模块(与 signal-collector-host.test.ts 一致)
vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/core/session-tracker.js', () => ({
  trackFriction: vi.fn(),
}));
vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: { log: vi.fn() },
}));
vi.mock('../../src/core/evolution-logger.js', () => ({
  createTraceId: vi.fn(() => 'trace-mock'),
}));

import { SignalCollectorHost } from '../../src/core/signal-collector-host.js';
import {
  createLiveSignalKeywordStore,
  HIGH_PRECISION_LEARNED_WEIGHT,
} from '../../src/core/signal-keyword-store.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import { trackFriction } from '../../src/core/session-tracker.js';
import { saveCorrectionKeywordStore, _resetCorrectionCueCache } from '../../src/core/correction-cue-learner.js';
import type { CorrectionKeywordStore } from '@principles/core/runtime-v2';

/**
 * P0-B: Learn→Detect 反馈闭环 (MVP_CORE_LOOP_CONTRACT INV-01 §3 / Gate A)。
 *
 * 审计背景 (ISSUE-003): optimizer 学到的词写入 correction_keywords.json,
 * 但检测用硬编码 6 词 store——学习永不回流检测。验收条件:
 * optimizer 写入的 correction term,下一次 production detection 真实可见,
 * 且无需重启(同一 host 实例)。
 */

function makeTempStateDir(): string {
  // Production layout: the keyword store lives at `{workspace}/.state/` (the
  // shared host-neutral store resolves the state dir from the workspace dir).
  // Keep the mock faithful to that layout so the delegation wrapper exercises
  // the real path derivation.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-signal-kw-'));
  const stateDir = path.join(workspace, '.state');
  fs.mkdirSync(stateDir, { recursive: true });
  return stateDir;
}

function makeStore(keywords: CorrectionKeywordStore['keywords']): CorrectionKeywordStore {
  return { keywords, version: 1, lastOptimizedAt: new Date().toISOString() };
}

function makeMockWctx(stateDir: string) {
  return {
    workspaceDir: path.dirname(stateDir),
    stateDir,
    trajectory: { recordUserTurn: vi.fn() },
  };
}

const noLlmConfig: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30_000,
  promptTemplate: '',
  strongPainScore: 70,
  strongRateLimitPerHour: 5,
};

function flushAsync(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createLiveSignalKeywordStore (learned store projection)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempStateDir();
    _resetCorrectionCueCache();
  });

  it('learned term 投影为 correction term (P1-2: llm_learned 恒 ambiguous,与权重无关)', () => {
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '重大失误', weight: 0.8, source: 'llm', addedAt: new Date().toISOString() },
      { term: '不太对', weight: 0.35, source: 'llm', addedAt: new Date().toISOString() },
    ]));
    const wctx = makeMockWctx(stateDir);
    const live = createLiveSignalKeywordStore(wctx as never);
    const store = live.resolve();

    // LLM 自评权重不构成确定性触发依据 — 高/低权重 learned 词一律 ambiguous
    // (参与 Stage1 扫描 + Stage2 LLM 确认; deterministic STRONG 仅
    //  seed overlay 与 owner_promoted 可及)
    expect(store.terms['重大失误']).toMatchObject({
      category: 'correction', precision: 'ambiguous', source: 'llm_learned', weight: 0.8,
    });
    expect(store.terms['不太对']).toMatchObject({
      category: 'correction', precision: 'ambiguous', source: 'llm_learned', weight: 0.35,
    });
    // owner_promoted(用户显式加入)高权重 → 可确定性触发
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '别自作聪明', weight: 0.85, source: 'user', addedAt: new Date().toISOString() },
    ]));
    _resetCorrectionCueCache();
    const store2 = createLiveSignalKeywordStore(wctx as never).resolve();
    expect(store2.terms['别自作聪明']).toMatchObject({ precision: 'high', source: 'owner_promoted' });
  });

  it('高精度 overlay 与 empathy seed 恒保留(learner store 不含它们)', () => {
    saveCorrectionKeywordStore(stateDir, makeStore([]));
    const live = createLiveSignalKeywordStore(makeMockWctx(stateDir) as never);
    const store = live.resolve();

    expect(store.terms['这是错的']?.precision).toBe('high');
    expect(store.terms['不要自作主张']?.precision).toBe('high');
    expect(store.terms['不应该这么做']?.precision).toBe('high');
    expect(store.terms['搞什么']).toMatchObject({ category: 'empathy', precision: 'ambiguous' });
  });

  it('learner seed 词也进入检测面(之前 16 个 seed 词只活在死库里)', () => {
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '你理解错了', weight: 0.8, source: 'seed', addedAt: new Date().toISOString() },
    ]));
    const live = createLiveSignalKeywordStore(makeMockWctx(stateDir) as never);
    expect(live.resolve().terms['你理解错了']?.precision).toBe('high');
  });

  it('文件缺失/畸形 → seed-only 降级(不抛异常,rc-9 可观测由 SystemLogger 记录)', () => {
    const live = createLiveSignalKeywordStore(makeMockWctx(stateDir) as never);
    const store = live.resolve();
    expect(Object.keys(store.terms).length).toBeGreaterThan(0);
    expect(store.terms['这是错的']).toBeDefined();
  });

  it('畸形 keywords 元素被跳过,不进入词库 (rc-4)', () => {
    fs.writeFileSync(path.join(stateDir, 'correction_keywords.json'), JSON.stringify({
      keywords: [
        { term: 123, weight: 0.5, source: 'seed' },
        { term: 'valid-term', weight: 'high', source: 'seed' },
        { term: '好的词', weight: 0.6, source: 'seed', addedAt: '' },
      ],
      version: 1,
    }));
    const live = createLiveSignalKeywordStore(makeMockWctx(stateDir) as never);
    const store = live.resolve();
    expect(store.terms['好的词']).toBeDefined();
    expect(Object.keys(store.terms)).not.toContain('valid-term');
  });
});

describe('Learn→Detect live refresh (无需重启)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeTempStateDir();
    _resetCorrectionCueCache();
    vi.clearAllMocks();
  });

  it('Journey-3 核心: optimizer 写入新词 → 同一 host 实例下一次 detectSync 消费', () => {
    saveCorrectionKeywordStore(stateDir, makeStore([]));
    const wctx = makeMockWctx(stateDir);
    const live = createLiveSignalKeywordStore(wctx as never);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStoreProvider: () => live.resolve(),
      config: noLlmConfig,
      llmClassifier: null,
    });

    // 写入前: 不含 learned 词
    host.detectSync('这个做法有大问题吗', 'sess-j3', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ correctionDetected: false, correctionCue: null }),
    );

    // optimizer 学到一个新的高权重词(模拟 KeywordOptimizationService.applyResult 的产物)
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '大问题', weight: 0.85, source: 'llm', addedAt: new Date().toISOString() },
    ]));

    // 同一 host 实例(无重启/无重建): 下一次消息,production detector 消费该词
    host.detectSync('这个做法有大问题', 'sess-j3', 'user');
    expect(wctx.trajectory.recordUserTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ correctionCue: '大问题' }),
    );
  });

  it('P1-2 FP regression: LLM 关闭时高权重 learned 常见词不触发 STRONG(防误报泛滥)', async () => {
    // 场景: optimizer 给常见词 "大问题" 赋高权重 0.85 — 若按权重放行
    // deterministic STRONG,普通消息 "这里有个大问题需要讨论" 每次都会
    // 产生 pain 误报 (live 历史曾把 "try again" 误报)。P1-2 后: learned
    // 词仅记 cue,不触发 STRONG;STRONG 需 Stage2 LLM 确认或 owner promotion。
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '大问题', weight: 0.85, source: 'llm', addedAt: new Date().toISOString() },
    ]));
    const wctx = makeMockWctx(stateDir);
    const live = createLiveSignalKeywordStore(wctx as never);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStoreProvider: () => live.resolve(),
      config: noLlmConfig,
      llmClassifier: null,  // LLM 不可用 — 确定性面单独接受检验
    });

    host.detectSync('这里有个大问题需要讨论', 'sess-fp1', 'user');
    await flushAsync();

    expect(wctx.trajectory.recordUserTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ correctionDetected: false, correctionCue: '大问题' }),
    );
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('P1-2: LLM 可用时高权重 learned 词经 Stage2 确认触发 STRONG (learn→detect 闭环)', async () => {
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '完全弄反了', weight: 0.85, source: 'llm', addedAt: new Date().toISOString() },
    ]));
    const wctx = makeMockWctx(stateDir);
    const live = createLiveSignalKeywordStore(wctx as never);
    const classifier = async () => ({
      is_feedback: true, type: 'correction' as const, confidence: 0.92, reason: '明确纠正',
    });
    const host = new SignalCollectorHost(wctx as never, {
      keywordStoreProvider: () => live.resolve(),
      config: noLlmConfig,
      llmClassifier: classifier,
    });

    host.detectSync('你完全弄反了,停下来', 'sess-j3b', 'user');
    await flushAsync();

    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1); // LLM 确认后 STRONG
  });

  it('P1-2 对照: owner_promoted 高权重词 LLM 关闭时仍确定性 STRONG', async () => {
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '完全弄反了', weight: 0.85, source: 'user', addedAt: new Date().toISOString() },
    ]));
    const wctx = makeMockWctx(stateDir);
    const live = createLiveSignalKeywordStore(wctx as never);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStoreProvider: () => live.resolve(),
      config: noLlmConfig,
      llmClassifier: null,
    });

    host.detectSync('你完全弄反了,停下来', 'sess-j3c', 'user');
    await flushAsync();

    expect(wctx.trajectory.recordUserTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ correctionDetected: true, correctionCue: '完全弄反了' }),
    );
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);
  });

  it('LLM 关闭: 低权重 learned 词只记 cue 不触发 STRONG(防 FP 泛滥)', async () => {
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '不太对', weight: 0.35, source: 'llm', addedAt: new Date().toISOString() },
    ]));
    const wctx = makeMockWctx(stateDir);
    const live = createLiveSignalKeywordStore(wctx as never);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStoreProvider: () => live.resolve(),
      config: noLlmConfig,
      llmClassifier: null,
    });

    host.detectSync('可能不太对,但我说不好', 'sess-j3c', 'user');
    await flushAsync();

    expect(wctx.trajectory.recordUserTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({ correctionDetected: false, correctionCue: '不太对' }),
    );
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('FP 权重衰减 (×0.8) 后,词从高精度降回 ambiguous(自然降级机制)', () => {
    // weight 0.8 → FP 后 0.64 (< HIGH_PRECISION_LEARNED_WEIGHT 0.7)
    saveCorrectionKeywordStore(stateDir, makeStore([
      { term: '又搞砸了', weight: 0.8 * 0.8, source: 'llm', addedAt: new Date().toISOString() },
    ]));
    const live = createLiveSignalKeywordStore(makeMockWctx(stateDir) as never);
    expect(live.resolve().terms['又搞砸了']?.precision).toBe('ambiguous');
    expect(HIGH_PRECISION_LEARNED_WEIGHT).toBe(0.7);
  });

  it('empathy 降级路径不被破坏: LLM 关闭时 搞什么 仍路由 WEAK(GFI)', async () => {
    saveCorrectionKeywordStore(stateDir, makeStore([]));
    const wctx = makeMockWctx(stateDir);
    const live = createLiveSignalKeywordStore(wctx as never);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStoreProvider: () => live.resolve(),
      config: noLlmConfig,
      llmClassifier: null,
    });

    host.detectSync('搞什么啊', 'sess-j3d', 'user');
    await flushAsync();

    expect(trackFriction).toHaveBeenCalledTimes(1);
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('storeVersion 漂移防护: resolve() 返回的快照在同一消息处理内一致', () => {
    saveCorrectionKeywordStore(stateDir, makeStore([]));
    const live = createLiveSignalKeywordStore(makeMockWctx(stateDir) as never);
    const s1: UnifiedKeywordStore = live.resolve();
    const s2: UnifiedKeywordStore = live.resolve();
    expect(s1).toBe(s2);  // mtime 未变 → 同一引用(无抖动)
  });
});
