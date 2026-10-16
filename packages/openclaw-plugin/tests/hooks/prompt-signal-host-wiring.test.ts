/**
 * P2-2 (PR #2053) — cueFeedbackRecorder 的真实 factory/wiring 回归。
 *
 * 背景：`correction-observer-batch-confirm.test.ts` 把 `getSignalCollectorHost`
 * 整块 mock 掉了，因此 prompt.ts 里真正构造 host 的那段 wiring（recorder 闭包 →
 * 真实 CorrectionCueLearner）没有任何测试覆盖。"recorder 被注入"是一个只能由
 * 真实接线证明的事实——mock 调用次数证明不了它。
 *
 * 本套件只 mock 与断言无关的落盘/遥测（pain hook、SystemLogger）。host 本身走
 * prompt.ts 的真实实现，词库与 learner 都是真实的文件系统实例，每个 workspace
 * 用自己的临时目录，因此"不跨 workspace 泄漏"也变成可验证的事实。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

vi.mock('../../src/hooks/pain.js', () => ({
  emitPainDetectedEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../src/core/system-logger.js', () => ({
  SystemLogger: { log: vi.fn() },
}));

import { getSignalCollectorHost, resetPromptStateForTest } from '../../src/hooks/prompt.js';
import { WorkspaceContext } from '../../src/core/workspace-context.js';
import {
  CorrectionCueLearner,
  _resetCorrectionCueLearnerInstance,
} from '../../src/core/correction-cue-learner.js';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const correctionVerdict = async () => ({
  is_feedback: true, type: 'correction' as const, confidence: 0.9, reason: '用户纠正',
});
const noneVerdict = async () => ({
  is_feedback: false, type: 'none' as const, confidence: 1, reason: '普通消息',
});

let dirs: string[] = [];

function makeWorkspace(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  const logger = makeLogger();
  const wctx = WorkspaceContext.fromHookContext({ workspaceDir: dir, logger });
  return { wctx, logger };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPromptStateForTest();
  _resetCorrectionCueLearnerInstance();
});

afterEach(() => {
  resetPromptStateForTest();
  _resetCorrectionCueLearnerInstance();
  for (const dir of dirs) {
    // Windows 上真实 SQLite/文件句柄可能仍被占用；清理失败不影响断言，
    // 由 vitest 的 temp-lifecycle 兜底。
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignored */
    }
  }
  dirs = [];
});

describe('P2-2: 真实 wiring — recorder 真的接到 learner', () => {
  it('STRONG 确认把 TP 记入该 workspace 的真实 learner', async () => {
    const { wctx, logger } = makeWorkspace('pd-wiring-tp-');
    const host = getSignalCollectorHost(wctx, logger as never);
    const learner = CorrectionCueLearner.get(wctx.stateDir);
    learner.add({ term: '搞砸了', weight: 0.6, source: 'llm' });

    const result = await host.confirmPendingSignal(
      {
        sessionId: 's1', userTurnRowid: 1, occurrenceId: 'occ-1',
        excerpt: '这次搞砸了', terms: ['搞砸了'], termsVerified: true,
      },
      correctionVerdict,
    );

    expect(result.disposition).toBe('confirmed');
    // recorder 未注入时这里会静默停在 0 —— 正是本测试要排除的"假成功"
    expect(learner.find('搞砸了')?.truePositiveCount).toBe(1);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('TP dropped'));
  });

  it('非纠正 verdict 把 FP（并降权）记入真实 learner', async () => {
    const { wctx, logger } = makeWorkspace('pd-wiring-fp-');
    const host = getSignalCollectorHost(wctx, logger as never);
    const learner = CorrectionCueLearner.get(wctx.stateDir);
    learner.add({ term: '风吹草动', weight: 0.6, source: 'llm' });

    const result = await host.confirmPendingSignal(
      {
        sessionId: 's1', userTurnRowid: 2, occurrenceId: 'occ-2',
        excerpt: '今天有点风吹草动', terms: ['风吹草动'], termsVerified: true,
      },
      noneVerdict,
    );

    expect(result.disposition).toBe('rejected');
    expect(learner.find('风吹草动')?.falsePositiveCount).toBe(1);
    expect(learner.find('风吹草动')?.weight).toBeLessThan(0.6);
  });

  it('词在 Stage1→Stage2 之间被淘汰时，报 "TP dropped" 而不是伪造成功', async () => {
    const { wctx, logger } = makeWorkspace('pd-wiring-evicted-');
    const host = getSignalCollectorHost(wctx, logger as never);
    const learner = CorrectionCueLearner.get(wctx.stateDir);
    learner.add({ term: '昙花一现', weight: 0.6, source: 'llm' });
    // 模拟检测与确认之间该词被容量淘汰挤走
    expect(learner.remove('昙花一现')).toBe(true);

    const result = await host.confirmPendingSignal(
      {
        sessionId: 's1', userTurnRowid: 3, occurrenceId: 'occ-3',
        excerpt: '又昙花一现了', terms: ['昙花一现'], termsVerified: true,
      },
      correctionVerdict,
    );

    // 消息级纠正事实仍然确认（词没了不等于纠正没发生）
    expect(result.disposition).toBe('confirmed');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('TP dropped: term="昙花一现" is no longer in the keyword store'),
    );
  });

  it('一个 workspace 的确认不会写进另一个 workspace 的词库', async () => {
    const a = makeWorkspace('pd-wiring-iso-a-');
    const b = makeWorkspace('pd-wiring-iso-b-');
    const hostA = getSignalCollectorHost(a.wctx, a.logger as never);
    const hostB = getSignalCollectorHost(b.wctx, b.logger as never);
    expect(hostB).not.toBe(hostA);

    const learnerA = CorrectionCueLearner.get(a.wctx.stateDir);
    const learnerB = CorrectionCueLearner.get(b.wctx.stateDir);
    learnerA.add({ term: '甲之词', weight: 0.6, source: 'llm' });
    learnerB.add({ term: '乙之词', weight: 0.6, source: 'llm' });

    await hostA.confirmPendingSignal(
      {
        sessionId: 's1', userTurnRowid: 4, occurrenceId: 'occ-4',
        excerpt: '甲之词', terms: ['甲之词'], termsVerified: true,
      },
      correctionVerdict,
    );

    expect(learnerA.find('甲之词')?.truePositiveCount).toBe(1);
    expect(learnerB.find('甲之词')).toBeUndefined();
    expect(learnerB.find('乙之词')?.truePositiveCount ?? 0).toBe(0);
    // B 的 logger 只允许出现既有的"无 pi-ai profile"配置告警，绝不允许出现 TP/FP 反馈
    expect(b.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('dropped'));
  });
});
