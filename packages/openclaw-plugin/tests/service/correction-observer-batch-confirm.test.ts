/**
 * PRI-788 G2 — batchConfirmPendingSignals 编排测试。
 *
 * host 路由与 store 语义各有自己的套件；这里只验证编排契约：
 * 分类器不可用整批跳过（不计失败）、失败 attempts++ 达上限转 abandoned、
 * 单条异常不中断整批。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContext } from '../../src/core/workspace-context.js';

const mockClassifier = vi.fn();
const mockConfirmPendingSignal = vi.fn();

// classifier 实例可按测试替换（null = 通道不可用）；vi.hoisted 规避提升时序。
const classifierSlot = vi.hoisted(() => ({
  instance: null as null | ((...args: unknown[]) => unknown),
}));

vi.mock('../../src/hooks/prompt.js', () => ({
  getSignalCollectorHost: vi.fn(() => ({ confirmPendingSignal: mockConfirmPendingSignal })),
}));

vi.mock('../../src/core/signal-collector-host.js', () => ({
  createSignalLlmClassifierFromConfig: vi.fn(() => classifierSlot.instance),
}));

vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: { log: vi.fn() },
}));

import { batchConfirmPendingSignals } from '../../src/service/correction-observer-service.js';

beforeEach(() => {
  classifierSlot.instance = mockClassifier;
});

function makePendingRow(overrides?: Partial<{ id: string; attempts: number }>) {
  return {
    id: overrides?.id ?? 'sq_abc123',
    sessionId: 's1',
    userTurnRowid: 42,
    occurrenceId: 'occ-42',
    excerpt: '这个不对',
    terms: ['不对'],
    suggestedType: 'correction',
    status: 'pending' as const,
    attempts: overrides?.attempts ?? 0,
    createdAt: '2026-09-14T00:00:00Z',
    resolvedAt: null,
    resolution: null,
  };
}

function makeWctx(pendingRows: ReturnType<typeof makePendingRow>[]) {
  const trajectory = {
    listPendingSignalConfirmations: vi.fn(() => pendingRows),
    bumpSignalConfirmationAttempt: vi.fn(() => 1),
    markSignalConfirmationResult: vi.fn(() => true),
  };
  const wctx = {
    workspaceDir: '/tmp/test-ws',
    trajectory,
  } as unknown as WorkspaceContext;
  return { wctx, trajectory };
}

afterEach(() => vi.clearAllMocks());

describe('batchConfirmPendingSignals (PRI-788 G2)', () => {
  it('empty queue → 0 resolved, classifier never resolved', async () => {
    const { wctx, trajectory } = makeWctx([]);
    const resolved = await batchConfirmPendingSignals(wctx, console);
    expect(resolved).toBe(0);
    expect(trajectory.bumpSignalConfirmationAttempt).not.toHaveBeenCalled();
    expect(mockClassifier).not.toHaveBeenCalled();
  });

  it('classifier unavailable → whole batch skipped, attempts NOT bumped (通道死≠候选失败)', async () => {
    classifierSlot.instance = null;
    const { wctx, trajectory } = makeWctx([makePendingRow()]);
    const resolved = await batchConfirmPendingSignals(wctx, console);
    expect(resolved).toBe(0);
    expect(trajectory.bumpSignalConfirmationAttempt).not.toHaveBeenCalled();
    expect(trajectory.markSignalConfirmationResult).not.toHaveBeenCalled();
    expect(mockConfirmPendingSignal).not.toHaveBeenCalled();
  });

  it('host dispositions forwarded: confirmed/rejected are persisted as terminal states', async () => {
    mockConfirmPendingSignal
      .mockResolvedValueOnce({ disposition: 'confirmed', detail: '确认纠正' })
      .mockResolvedValueOnce({ disposition: 'rejected', detail: 'classified none' });
    const { wctx, trajectory } = makeWctx([makePendingRow({ id: 'sq_a' }), makePendingRow({ id: 'sq_b' })]);

    const resolved = await batchConfirmPendingSignals(wctx, console);

    expect(resolved).toBe(2);
    expect(trajectory.markSignalConfirmationResult).toHaveBeenCalledWith('sq_a', 'confirmed', '确认纠正');
    expect(trajectory.markSignalConfirmationResult).toHaveBeenCalledWith('sq_b', 'rejected', 'classified none');
  });

  it('failed confirmation bumps attempts; reaching the cap transitions to abandoned', async () => {
    mockConfirmPendingSignal.mockResolvedValue({ disposition: 'failed', detail: 'classifier threw' });
    const { wctx, trajectory } = makeWctx([makePendingRow({ id: 'sq_cap', attempts: 4 })]);
    (trajectory.bumpSignalConfirmationAttempt as ReturnType<typeof vi.fn>).mockReturnValue(5); // 4+1=5 → 上限

    const resolved = await batchConfirmPendingSignals(wctx, console);

    expect(resolved).toBe(1);
    expect(trajectory.bumpSignalConfirmationAttempt).toHaveBeenCalledWith('sq_cap');
    expect(trajectory.markSignalConfirmationResult).toHaveBeenCalledWith(
      'sq_cap', 'abandoned', expect.stringContaining('attempts exhausted (5)'),
    );
  });

  it('failed confirmation below the cap stays pending (仍可下周期重试)', async () => {
    mockConfirmPendingSignal.mockResolvedValue({ disposition: 'failed', detail: 'timeout' });
    const { wctx, trajectory } = makeWctx([makePendingRow({ id: 'sq_retry', attempts: 0 })]);
    (trajectory.bumpSignalConfirmationAttempt as ReturnType<typeof vi.fn>).mockReturnValue(1);

    const resolved = await batchConfirmPendingSignals(wctx, console);

    expect(resolved).toBe(0);
    expect(trajectory.markSignalConfirmationResult).not.toHaveBeenCalled();
  });

  it('single item throwing does not abort the batch (rc-9, 其余条目继续)', async () => {
    mockConfirmPendingSignal
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValueOnce({ disposition: 'confirmed', detail: 'ok' });
    const { wctx, trajectory } = makeWctx([makePendingRow({ id: 'sq_x' }), makePendingRow({ id: 'sq_y' })]);

    const resolved = await batchConfirmPendingSignals(wctx, console);

    expect(resolved).toBe(1);
    expect(trajectory.markSignalConfirmationResult).toHaveBeenCalledWith('sq_y', 'confirmed', 'ok');
  });
});
