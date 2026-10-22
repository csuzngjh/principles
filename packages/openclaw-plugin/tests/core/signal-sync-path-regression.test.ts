/**
 * AUDIT-P2-01 / AUDIT-P2-02 (2026-10-21) — 同步路径健康度写入与 Stage2 计数回归。
 *
 * 背景（审计发现）：`detectAsyncAndRoute()` 在分类器不可用的降级分支里没有任何
 * `await`（async 函数体在首个 await 前同步执行），因此 `queueUnconfirmedForBatch`
 * 里的 `updateSignalHealth`（同步文件 read-modify-write）会留在
 * `detectSync()` → `before_prompt_build` 的同步调用栈上，每条歧义命中消息都让
 * prompt hook 承担一次磁盘读改写。
 *
 * 修复契约（与 countStage1Strong 既有惯例一致）：
 *  - 所有可从同步路径到达的健康计数写入（stage1Strong/stage2Queued/
 *    stage2Dropped/stage2Invocations）推迟到微任务执行；
 *  - `enqueueSignalConfirmation`（SQLite 持久化）保持同步——可靠性要求，
 *    整改明确禁止异步化队列记录；
 *  - 本文件用真实的 signal-health 模块 + 临时目录验证可观测的调用顺序：
 *    detectSync() 返回时健康文件尚未写入，微任务排空后计数正确。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '@principles/core/runtime-v2';

// mock 掉会触发真实副作用的模块；signal-health 与 io(utils) 保持真实实现，
// 这是本文件要验证的对象（文件何时被写）。
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
import { readSignalHealth } from '../../src/core/signal-health.js';

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

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-signal-sync-regression-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function makeWctx(stateDir: string) {
  return {
    workspaceDir: path.join(tmpRoot, 'ws'),
    stateDir,
    trajectory: {
      recordUserTurn: vi.fn(() => 101),
      enqueueSignalConfirmation: vi.fn(),
    },
  };
}

/** 排空微任务队列（queueMicrotask 的写入在这之后可见）。 */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AUDIT-P2-01: 分类器不可用降级分支的健康写入离开同步调用栈', () => {
  it('detectSync() 返回时健康文件尚未写入；微任务执行后 stage2Queued=1（核心回归：修复前此断言失败）', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null, // 分类器不可用 → 无 await 的降级分支
    });

    host.detectSync('这个不对', 'sess-degraded', 'user', { turnIndex: 1 });

    // 修复前：stage2Queued 在同步调用栈上写盘 → 文件此刻已存在（断言失败）。
    // 修复后：写入在微任务里 → detectSync 返回时文件尚未落盘。
    expect(fs.existsSync(path.join(stateDir, 'signal-health.json'))).toBe(false);
    expect(readSignalHealth(stateDir)).toBeNull();

    // 但 SQLite 队列记录保持同步：detectSync 返回前必须已完成（可靠性要求）。
    expect(wctx.trajectory.enqueueSignalConfirmation).toHaveBeenCalledTimes(1);

    await flushMicrotasks();
    const health = readSignalHealth(stateDir);
    expect(health).not.toBeNull();
    expect(health?.stage2Queued).toBe(1);
    // 分类器从未被调用 → 不计 stage2Invocations（AUDIT-P2-02）。
    expect(health?.stage2Invocations).toBe(0);
  });

  it('高精度命中：detectSync() 返回时 stage1Strong 未写盘，微任务后计数正确（既有惯例不回退）', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null,
    });

    host.detectSync('这是错的，重来', 'sess-high', 'user', { turnIndex: 2 });

    expect(fs.existsSync(path.join(stateDir, 'signal-health.json'))).toBe(false);
    await flushMicrotasks();
    expect(readSignalHealth(stateDir)?.stage1Strong).toBe(1);
  });

  it('分类器不可用且普通消息零命中：写盘推迟到微任务，不入队；计数为 stage2Dropped', async () => {
    // 零命中消息走「漏词检测」路径（collectSync 对未命中也返回
    // needsLlmConfirmation=true）——审计所指"每条普通消息一次同步文件读改写"
    // 正是这里：修复前 countStage2Dropped 在同步调用栈上写盘。
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null,
    });

    host.detectSync('今天天气不错', 'sess-zero', 'user', { turnIndex: 3 });

    // P2-01 核心：detectSync() 返回时，零命中降级路径同样不许已写盘。
    expect(fs.existsSync(path.join(stateDir, 'signal-health.json'))).toBe(false);
    // 零命中不入队（只有歧义命中才持久化等待批量确认）。
    expect(wctx.trajectory.enqueueSignalConfirmation).not.toHaveBeenCalled();

    await flushMicrotasks();
    const health = readSignalHealth(stateDir);
    expect(health?.stage2Dropped).toBe(1);
    expect(health?.stage2Queued).toBe(0);
  });

  it('recordUserTurn 无 rowid 的歧义候选：stage2Dropped 推迟到微任务', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    wctx.trajectory.recordUserTurn = vi.fn(() => undefined);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null,
    });

    host.detectSync('这个不对', 'sess-norowid', 'user', { turnIndex: 4 });

    expect(fs.existsSync(path.join(stateDir, 'signal-health.json'))).toBe(false);
    expect(wctx.trajectory.enqueueSignalConfirmation).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(readSignalHealth(stateDir)?.stage2Dropped).toBe(1);
  });

  it('健康文件写失败（stateDir 被同名文件占据）：检测与入队不受影响，不抛出', async () => {
    // stateDir 指向一个普通文件 → mkdirSync 失败 → updateSignalHealth 吞掉并记日志。
    const blockedDir = path.join(tmpRoot, 'blocked');
    fs.writeFileSync(blockedDir, 'not a directory');
    const wctx = makeWctx(blockedDir);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null,
    });

    expect(() => host.detectSync('这个不对', 'sess-broken', 'user', { turnIndex: 5 })).not.toThrow();
    await flushMicrotasks();
    // 队列记录（可靠性路径）必须已完成——健康度旁路失败不能拖垮它。
    expect(wctx.trajectory.enqueueSignalConfirmation).toHaveBeenCalledTimes(1);
  });
});

describe('AUDIT-P2-02: stage2Invocations 计数语义', () => {
  it('realtime 路径：classifier 真实调用一次 → stage2Invocations=1', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    const classifier = vi.fn(async () => ({
      is_feedback: false, type: 'none' as const, confidence: 0.9, reason: 'not a correction',
    }));
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: classifier,
    });

    host.detectSync('这个不对', 'sess-invoked', 'user', { turnIndex: 6 });
    await flushMicrotasks();
    await new Promise((r) => setTimeout(r, 20));

    expect(classifier).toHaveBeenCalledTimes(1);
    const health = readSignalHealth(stateDir);
    expect(health?.stage2Invocations).toBe(1);
    // LLM 判 none → 不确认、不入队。
    expect(health?.stage2Queued).toBe(0);
    expect(health?.stage2Confirmed).toBe(0);
  });

  it('分类器不可用（llmClassifier=null）：不增加 stage2Invocations', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: null,
    });

    host.detectSync('这个不对', 'sess-null', 'user', { turnIndex: 7 });
    await flushMicrotasks();
    expect(readSignalHealth(stateDir)?.stage2Invocations).toBe(0);
  });

  it('enableLlmStage=false：配置关闭时不增加 stage2Invocations', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    const classifier = vi.fn(async () => null);
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: { ...testConfig, enableLlmStage: false },
      llmClassifier: classifier,
    });

    host.detectSync('这个不对', 'sess-disabled', 'user', { turnIndex: 8 });
    await flushMicrotasks();
    expect(classifier).not.toHaveBeenCalled();
    // enableLlmStage=false 时 collectSync 直接置 needsLlmConfirmation=false，
    // 异步路径不启动：既无调用计数，也无任何健康写入。
    expect(readSignalHealth(stateDir)).toBeNull();
  });

  it('批量确认路径：confirmPendingSignal 调用 classifier → stage2Invocations 同样 +1', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    const wctx = makeWctx(stateDir);
    const classifier = vi.fn(async () => null); // 通道仍死 → failed disposition
    const host = new SignalCollectorHost(wctx as never, {
      keywordStore: testStore,
      config: testConfig,
      llmClassifier: classifier,
    });

    const result = await host.confirmPendingSignal(
      {
        sessionId: 'sess-batch',
        userTurnRowid: 42,
        occurrenceId: '42',
        excerpt: '这个不对',
        terms: ['不对'],
        termsVerified: true,
      },
      classifier,
    );
    await flushMicrotasks();

    expect(classifier).toHaveBeenCalledTimes(1);
    expect(result.disposition).toBe('failed');
    expect(readSignalHealth(stateDir)?.stage2Invocations).toBe(1);
  });
});

describe('AUDIT-P2-02: signal-health 新字段向后兼容', () => {
  it('旧格式文件（无 stage2Invocations/stage2BatchSkipped）读作 0，不退化为 unknown', async () => {
    const stateDir = path.join(tmpRoot, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    // 升级前的真实文件形状：只有旧字段。
    const legacyShape = {
      stage1Strong: 3,
      stage2Confirmed: 2,
      stage2Queued: 5,
      stage2Dropped: 1,
      pendingCount: 4,
      lastStage2SuccessAt: null,
      observerLastSuccessAt: null,
      observerConsecutiveFailures: 0,
      day: new Date().toISOString().slice(0, 10),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(stateDir, 'signal-health.json'), JSON.stringify(legacyShape, null, 2));

    const health = readSignalHealth(stateDir);
    expect(health).not.toBeNull();
    expect(health?.stage2Invocations).toBe(0);
    expect(health?.stage2BatchSkipped).toBe(0);
    expect(health?.stage2Queued).toBe(5);

    // 跨日归零同时覆盖新字段：构造昨天的文件，写入后新计数归零。
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const staleShape = {
      ...legacyShape,
      stage2Invocations: 9,
      stage2BatchSkipped: 7,
      day: yesterday.toISOString().slice(0, 10),
    };
    fs.writeFileSync(path.join(stateDir, 'signal-health.json'), JSON.stringify(staleShape, null, 2));
    const { updateSignalHealth } = await import('../../src/core/signal-health.js');
    updateSignalHealth(stateDir, (s) => { s.stage1Strong += 1; });
    const rolled = readSignalHealth(stateDir);
    expect(rolled?.stage2Invocations).toBe(0);
    expect(rolled?.stage2BatchSkipped).toBe(0);
    expect(rolled?.observerConsecutiveFailures).toBe(0);
  });

  it('新字段存在但类型错误 → 文件按损坏处理（返回 null）', () => {
    const stateDir = path.join(tmpRoot, 'state2');
    fs.mkdirSync(stateDir, { recursive: true });
    const corrupt = {
      stage1Strong: 1, stage2Confirmed: 0, stage2Queued: 0, stage2Dropped: 0,
      pendingCount: 0, observerConsecutiveFailures: 0,
      stage2Invocations: 'many', // 篡改：非数值
      day: '2026-10-21', updatedAt: '2026-10-21T00:00:00Z',
    };
    fs.writeFileSync(path.join(stateDir, 'signal-health.json'), JSON.stringify(corrupt));
    expect(readSignalHealth(stateDir)).toBeNull();
  });
});
