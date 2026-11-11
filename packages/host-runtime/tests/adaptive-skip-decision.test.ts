/**
 * PRI-1181 — deterministic pre-selection gate.
 *
 * These cases are the contract for "spend nothing when nothing can be gained".
 * They run before any candidate read, so they must never depend on workspace
 * state.
 */
import { describe, expect, it } from 'vitest';
import {
  ADAPTIVE_SKIP_LIMITS,
  decideAdaptiveSkip,
  isTrivialConfirmation,
} from '../src/adaptive-skip-decision.js';

const base = {
  kind: 'before_prompt_build',
  sessionId: 's-1',
  turnId: 't-1',
  prompt: '请交付验收：这次改动已经全部完成了吗？',
} as const;

describe('decideAdaptiveSkip', () => {
  it('keeps a substantive natural-language instruction on the fast path', () => {
    expect(decideAdaptiveSkip(base)).toEqual({ skip: false });
  });

  it('skips a turn without host-bound identity', () => {
    expect(decideAdaptiveSkip({ ...base, turnId: undefined })).toEqual({ skip: true, reason: 'missing_identity' });
    expect(decideAdaptiveSkip({ ...base, sessionId: '' })).toEqual({ skip: true, reason: 'missing_identity' });
    expect(decideAdaptiveSkip({ ...base, kind: 'before_tool_call' })).toEqual({ skip: true, reason: 'missing_identity' });
  });

  it('skips a blank prompt', () => {
    expect(decideAdaptiveSkip({ ...base, prompt: '   \n\t ' })).toEqual({ skip: true, reason: 'empty_prompt' });
  });

  it('skips only when the remaining budget is below the request\'s executable floor', () => {
    expect(decideAdaptiveSkip({ ...base, remainingBudgetMs: ADAPTIVE_SKIP_LIMITS.minExecutableBudgetMs - 1 }))
      .toEqual({ skip: true, reason: 'budget_insufficient' });
    expect(decideAdaptiveSkip({ ...base, remainingBudgetMs: ADAPTIVE_SKIP_LIMITS.minExecutableBudgetMs }))
      .toEqual({ skip: false });
    // No outer deadline (direct/lab call) never budget-skips.
    expect(decideAdaptiveSkip({ ...base, remainingBudgetMs: undefined })).toEqual({ skip: false });
  });

  it('does not use the old 1500 ms slow-path line: an executable fast request is not skipped', () => {
    // PRI-1181 measured 789–1426 ms time-to-first-byte on the slow path and
    // skipped anything under 1500 ms. A Decisions request that answers in a
    // few hundred ms is executable in a 1400 ms window and must be sent.
    expect(decideAdaptiveSkip({ ...base, remainingBudgetMs: 1400 })).toEqual({ skip: false });
    expect(decideAdaptiveSkip({ ...base, remainingBudgetMs: 1200 })).toEqual({ skip: false });
    expect(ADAPTIVE_SKIP_LIMITS.minExecutableBudgetMs).toBeLessThan(1500);
  });

  it('skips pure social acknowledgements', () => {
    for (const prompt of ['收到', '嗯嗯', 'Thanks', '辛苦了', '明白了。', '收到啦', '谢谢！', '了解', 'got it']) {
      expect(decideAdaptiveSkip({ ...base, prompt }), prompt).toEqual({ skip: true, reason: 'trivial_confirmation' });
    }
  });

  it('never treats an approval as pure social: it can answer a pending question', () => {
    // The counterexample: "要不要提交最终版？" → "确认". A bare approval is a
    // stage change, not social noise, so it must reach the decision endpoint.
    for (const prompt of ['确认', '好的', '可以', 'ok', 'OK', 'yes', '行', '没问题', '好嘞', 'yep']) {
      expect(decideAdaptiveSkip({ ...base, prompt }), prompt).toEqual({ skip: false });
    }
  });

  it('never treats a short real instruction or a continuation as social', () => {
    for (const prompt of ['继续', '开始', '执行一下', '改这个', '可以帮我修复这个 bug 吗', '行不行', '确认一下这个方案']) {
      expect(decideAdaptiveSkip({ ...base, prompt }), prompt).toEqual({ skip: false });
    }
  });

  it('a longer sentence containing an acknowledgement is not social', () => {
    expect(isTrivialConfirmation('好的，现在把 selector 的超时改成 4200ms')).toBe(false);
  });
});
