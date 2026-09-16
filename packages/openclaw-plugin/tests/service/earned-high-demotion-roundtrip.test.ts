/**
 * PRI-812: earned-high 升/降级真实文件往返（生产路径验证）。
 *
 * 参与者全部为生产组件，无 helper 复制品：
 *   - 真实 CorrectionCueLearner（原子写 + flush + 模块级缓存）
 *   - 真实 <workspace>/.state/correction_keywords.json
 *   - 真实 createSharedCorrectionKeywordStore（mtime 重载 + precisionFor 投影）
 *   - 真实 KeywordOptimizationService.applyResult（observer FP-only 裁决的生产入口）
 *   - 真实 SignalCollectorHost.detectSync（high → STRONG 确定性快速路径）
 *
 * 仅 mock 与词库无关的副作用（pain 事件 / 摩擦累积 / 系统日志）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  createTraceId: vi.fn(() => 'trace-roundtrip'),
}));

import { SignalCollectorHost } from '../../src/core/signal-collector-host.js';
import {
  CorrectionCueLearner,
  _resetCorrectionCueCache,
  _resetCorrectionCueLearnerInstance,
} from '../../src/core/correction-cue-learner.js';
import { KeywordOptimizationService } from '../../src/service/keyword-optimization-service.js';
import { createLiveSignalKeywordStore } from '../../src/core/signal-keyword-store.js';
import { emitPainDetectedEvent } from '../../src/hooks/pain.js';
import type { CorrectionObserverResult } from '@principles/core/runtime-v2';

const LEARNED_TERM = '先确认再改';
const OWNER_TERM = '必须按我说的做';

function makeWorkspace(): string {
  // realpathSync: macOS/windows tmpdir 符号链接会造成 mtime 判断与路径不一致
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pd-earned-roundtrip-')));
}

/** 小睡确保共享 store 的 mtime 缓存判定稳定（两次磁盘写在同 ms 内不碰撞）。 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('PRI-812 earned-high promotion/demotion round-trip (real files)', () => {
  let workspaceDir: string;
  let stateDir: string;

  beforeEach(() => {
    _resetCorrectionCueCache();
    _resetCorrectionCueLearnerInstance();
    KeywordOptimizationService.reset();
    workspaceDir = makeWorkspace();
    stateDir = path.join(workspaceDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  it('llm term: TP 2→ambiguous, TP 3→high (promotion via real store file)', () => {
    const learner = CorrectionCueLearner.get(stateDir);
    learner.add({ term: LEARNED_TERM, weight: 0.5, source: 'llm' });

    learner.recordTruePositive(LEARNED_TERM);
    learner.recordTruePositive(LEARNED_TERM);

    const liveStore = createLiveSignalKeywordStore({ workspaceDir } as never);
    const tp2 = liveStore.resolve().terms[LEARNED_TERM];
    expect(tp2?.precision).toBe('ambiguous');

    learner.recordTruePositive(LEARNED_TERM); // TP = 3
    const tp3 = liveStore.resolve().terms[LEARNED_TERM];
    expect(tp3?.precision).toBe('high');
    expect(tp3?.source).toBe('llm_learned');
  });

  it('earned high → confirmed FP → store reload → ambiguous (demotion, §10)', async () => {
    // ── 升级：llm 词 TP=3, FP=0 → high ─────────────────────────────────────
    const learner = CorrectionCueLearner.get(stateDir);
    learner.add({ term: LEARNED_TERM, weight: 0.5, source: 'llm' });
    learner.recordTruePositive(LEARNED_TERM);
    learner.recordTruePositive(LEARNED_TERM);
    learner.recordTruePositive(LEARNED_TERM);

    const liveStore = createLiveSignalKeywordStore({ workspaceDir } as never);
    const storeProvider = () => liveStore.resolve();

    // 生产检测路径确认 high 投影真实生效：确定性 STRONG 快速路径
    const host = new SignalCollectorHost({ workspaceDir, stateDir } as never, {
      keywordStoreProvider: storeProvider,
      llmClassifier: vi.fn(),
      cueFeedbackRecorder: vi.fn(),
    });
    host.detectSync(`请${LEARNED_TERM}，不要直接上线`, 'sess-roundtrip', 'user', { turnIndex: 1 });
    await sleep(20);
    expect(emitPainDetectedEvent).toHaveBeenCalledTimes(1);

    const beforeEntry = liveStore.resolve().terms[LEARNED_TERM];
    const beforeKeyword = learner.getStore().keywords.find((k) => k.term === LEARNED_TERM);
    const before = {
      tp: beforeKeyword?.truePositiveCount ?? 0,
      fp: beforeKeyword?.falsePositiveCount ?? 0,
      precision: beforeEntry?.precision,
    };
    expect(before).toEqual({ tp: 3, fp: 0, precision: 'high' });

    // ── 反证：observer FP-only 裁决经生产入口 applyResult 进入 learner ──────
    await sleep(20);
    const optimizationService = KeywordOptimizationService.get(stateDir, workspaceDir, {
      info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    } as never);
    const fpOnlyVerdict = {
      updated: false,
      updates: {},
      fpTerms: [LEARNED_TERM],
      fpAnalysisStatus: 'completed',
      summary: 'term fired on a factual message, confirmed false positive',
    } as unknown as CorrectionObserverResult;
    optimizationService.applyResult(fpOnlyVerdict);

    // 持久化证据：文件里 FP=1
    const persisted = JSON.parse(fs.readFileSync(path.join(stateDir, 'correction_keywords.json'), 'utf-8')) as {
      keywords: { term: string; truePositiveCount?: number; falsePositiveCount?: number }[];
    };
    const persistedEntry = persisted.keywords.find((k) => k.term === LEARNED_TERM);
    expect(persistedEntry?.falsePositiveCount).toBe(1);
    expect(persistedEntry?.truePositiveCount).toBe(3);

    // 共享 store 按 mtime 重载 → precisionFor → ambiguous
    await sleep(20);
    const afterEntry = liveStore.resolve().terms[LEARNED_TERM];
    const after = {
      tp: persistedEntry?.truePositiveCount ?? 0,
      fp: persistedEntry?.falsePositiveCount ?? 0,
      precision: afterEntry?.precision,
    };
    expect(after).toEqual({ tp: 3, fp: 1, precision: 'ambiguous' });

    // 降级后的行为语义：同一 store 再次检测不再走确定性 STRONG，
    // 而是进入歧义候选（needsLlmConfirmation=true）
    vi.mocked(emitPainDetectedEvent).mockClear();
    host.detectSync(`请${LEARNED_TERM}，第二次出现`, 'sess-roundtrip-2', 'user', { turnIndex: 2 });
    await sleep(20);
    expect(emitPainDetectedEvent).not.toHaveBeenCalled();
  });

  it('seed high keywords and owner_promoted semantics unaffected by a learned-term FP', async () => {
    const learner = CorrectionCueLearner.get(stateDir);
    learner.add({ term: LEARNED_TERM, weight: 0.5, source: 'llm' });
    for (let i = 0; i < 3; i++) learner.recordTruePositive(LEARNED_TERM);
    // owner 显式晋升词：weight≥0.7 走 owner_promoted 高精度路径（不受 TP/FP 门槛约束）
    learner.add({ term: OWNER_TERM, weight: 0.9, source: 'user' });

    const liveStore = createLiveSignalKeywordStore({ workspaceDir } as never);
    expect(liveStore.resolve().terms[LEARNED_TERM]?.precision).toBe('high');
    expect(liveStore.resolve().terms[OWNER_TERM]?.precision).toBe('high');
    expect(liveStore.resolve().terms[OWNER_TERM]?.source).toBe('owner_promoted');

    // 对 learned 词记 FP：seed overlay 与 owner 词的高精度语义不受牵连
    await sleep(20);
    learner.recordFalsePositive(LEARNED_TERM);
    await sleep(20);
    expect(liveStore.resolve().terms[LEARNED_TERM]?.precision).toBe('ambiguous');
    // owner 词 0.9 → FP 权重衰减 ×0.8 = 0.72，仍 ≥ 0.7 → high 保持
    expect(liveStore.resolve().terms[OWNER_TERM]?.precision).toBe('high');
    // seed 高精度短语始终在 overlay 中（resolve 结果含 '这是错的'）
    expect(liveStore.resolve().terms['这是错的']?.precision).toBe('high');
  });

  it('legacy hitCount in an old store file is tolerated on read and ignored by precision', () => {
    // 旧版本文件可能带 hitCount/lastHitAt——继续容忍读取，runtime 不当权威信号
    fs.writeFileSync(
      path.join(stateDir, 'correction_keywords.json'),
      JSON.stringify({
        keywords: [
          { term: LEARNED_TERM, weight: 0.5, source: 'llm', addedAt: '2026-01-01T00:00:00Z', hitCount: 7, lastHitAt: '2026-01-01T00:00:00Z', truePositiveCount: 3, falsePositiveCount: 0 },
        ],
        version: 1,
        lastOptimizedAt: '2026-01-01T00:00:00Z',
      }),
      'utf-8',
    );
    const liveStore = createLiveSignalKeywordStore({ workspaceDir } as never);
    // earned precision 只看 TP/FP：hitCount=7 的陈旧值既不阻止升 high 也不参与决策
    expect(liveStore.resolve().terms[LEARNED_TERM]?.precision).toBe('high');
  });
});
