/**
 * AUDIT-P2-03 (2026-10-21) — 信号检测同步路径性能基线。
 *
 * PURPOSE: 记录 detectSync() 各场景在同步窗口内的耗时分布（p50/p95/p99），
 * 供 AUDIT-P2-01 修复的前后对比与 PR/审计报告引用。本文件只记录基线数字，
 * 不做阈值断言（遵循 rule-context-v2.perf.test.ts 的"先基准再定值"纪律——
 * 文档不得把未执行的目标写成实测结果）。
 *
 * 场景：
 *   S1 普通消息零命中（分类器不可用 → 漏词检测降级，含 stage2Dropped 计数）
 *   S2 高精度关键词命中（同步 STRONG 分流 + Pain 路由同步前缀）
 *   S3 歧义关键词命中 + 分类器不可用（降级入队 signal_confirmations）
 *   S4 歧义关键词命中 + mock 分类器（realtime Stage2 调用前段）
 *
 * 环境：隔离临时 workspace + 真实 trajectory SQLite（recordUserTurn 真实写入）
 * + 真实 signal-health 模块；mock 仅覆盖进程外副作用（pain 事件/friction/日志）。
 * 微任务中的健康度写入不计入同步窗口——这正是 AUDIT-P2-01 的修复对象。
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UnifiedKeywordStore, SignalCollectorConfig } from '@principles/core/runtime-v2';

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
import { TrajectoryDatabase } from '../../src/core/trajectory.js';

const store: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '搞什么': { term: '搞什么', category: 'empathy', weight: 0.5, precision: 'ambiguous', source: 'seed' },
  },
};

const config: SignalCollectorConfig = {
  enableLlmStage: true,
  llmTimeoutMs: 30_000,
  promptTemplate: '',
  strongPainScore: 70,
  // 性能测试要求 routeStrong 全程执行（限流截断会改变时序语义）
  strongRateLimitPerHour: 1_000_000,
};

const WARMUP = 50;
const ITERATIONS = 300;

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.min(sortedMs.length - 1, Math.ceil((p / 100) * sortedMs.length) - 1);
  return sortedMs[Math.max(0, idx)] as number;
}

function report(scenario: string, samples: number[]): string {
  const sorted = [...samples].sort((a, b) => a - b);
  const line =
    `S:${scenario} n=${sorted.length} ` +
    `p50=${percentile(sorted, 50).toFixed(3)}ms ` +
    `p95=${percentile(sorted, 95).toFixed(3)}ms ` +
    `p99=${percentile(sorted, 99).toFixed(3)}ms ` +
    `max=${(sorted[sorted.length - 1] as number).toFixed(3)}ms`;
  console.log(`[perf] ${line}`);
  return line;
}

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('AUDIT-P2-03: signal detectSync 同步路径性能基线', () => {
  it('记录四场景同步窗口耗时分布（无阈值断言）', async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-signal-perf-'));
    const stateDir = path.join(workspaceDir, '.state');
    const trajectory = new TrajectoryDatabase({ workspaceDir });
    const wctx = {
      workspaceDir,
      stateDir,
      trajectory,
    };

    const results: Record<string, string> = {};

    // S1 普通消息零命中 + 分类器不可用
    {
      const host = new SignalCollectorHost(wctx as never, { keywordStore: store, config, llmClassifier: null });
      for (let i = 0; i < WARMUP; i++) host.detectSync('帮我看看这段代码的结构', 'perf-s1', 'user', { turnIndex: i });
      await flushMicrotasks();
      const samples: number[] = [];
      for (let i = WARMUP; i < WARMUP + ITERATIONS; i++) {
        const t0 = process.hrtime.bigint();
        host.detectSync('帮我看看这段代码的结构', 'perf-s1', 'user', { turnIndex: i });
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
      }
      await flushMicrotasks();
      results['S1-zero-hit-degraded'] = report('S1-zero-hit-degraded', samples);
    }

    // S2 高精度命中（同步 STRONG + Pain 路由同步前缀）
    {
      const host = new SignalCollectorHost(wctx as never, { keywordStore: store, config, llmClassifier: null });
      for (let i = 0; i < WARMUP; i++) host.detectSync('这是错的，按我说的改', 'perf-s2', 'user', { turnIndex: i });
      await flushMicrotasks();
      const samples: number[] = [];
      for (let i = WARMUP; i < WARMUP + ITERATIONS; i++) {
        const t0 = process.hrtime.bigint();
        host.detectSync('这是错的，按我说的改', 'perf-s2', 'user', { turnIndex: i });
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
      }
      await flushMicrotasks();
      results['S2-high-hit-strong'] = report('S2-high-hit-strong', samples);
    }

    // S3 歧义命中 + 分类器不可用（降级入队）
    {
      const host = new SignalCollectorHost(wctx as never, { keywordStore: store, config, llmClassifier: null });
      for (let i = 0; i < WARMUP; i++) host.detectSync('这里好像不太对', 'perf-s3', 'user', { turnIndex: i });
      await flushMicrotasks();
      const samples: number[] = [];
      for (let i = WARMUP; i < WARMUP + ITERATIONS; i++) {
        const t0 = process.hrtime.bigint();
        host.detectSync('这里好像不太对', 'perf-s3', 'user', { turnIndex: i });
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
      }
      await flushMicrotasks();
      results['S3-ambiguous-degraded-queue'] = report('S3-ambiguous-degraded-queue', samples);
    }

    // S4 歧义命中 + mock 分类器（realtime Stage2 前段：计数调度 + 调用发起）
    {
      const classifier = vi.fn(async () => ({
        is_feedback: false, type: 'none' as const, confidence: 0.9, reason: 'not a correction',
      }));
      const host = new SignalCollectorHost(wctx as never, { keywordStore: store, config, llmClassifier: classifier });
      for (let i = 0; i < WARMUP; i++) host.detectSync('这里好像不太对', 'perf-s4', 'user', { turnIndex: i });
      await flushMicrotasks();
      const samples: number[] = [];
      for (let i = WARMUP; i < WARMUP + ITERATIONS; i++) {
        const t0 = process.hrtime.bigint();
        host.detectSync('这里好像不太对', 'perf-s4', 'user', { turnIndex: i });
        const t1 = process.hrtime.bigint();
        samples.push(Number(t1 - t0) / 1e6);
      }
      // 排空 classifier promise 链与微任务
      await new Promise((r) => setTimeout(r, 200));
      await flushMicrotasks();
      results['S4-ambiguous-realtime-llm'] = report('S4-ambiguous-realtime-llm', samples);
      expect(classifier).toHaveBeenCalled();
    }

    // 真实性 sanity：trajectory 收到全部 user_turns 写入（4 场景 × (WARMUP+ITERATIONS)）
    const expectedTurns = 4 * (WARMUP + ITERATIONS);
    expect(trajectory.getDataStats().userTurns).toBe(expectedTurns);
    trajectory.dispose();
    fs.rmSync(workspaceDir, { recursive: true, force: true });

    // 环境标注（报告引用时随行记录）
    console.log(`[perf] env node=${process.version} platform=${process.platform} iterations=${ITERATIONS}+warmup=${WARMUP}`);
    expect(Object.keys(results)).toHaveLength(4);
  }, 120_000);
});
