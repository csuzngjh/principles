import { describe, it, expect } from 'vitest';
import { scanKeywords } from '../keyword-stage.js';
import type { UnifiedKeywordStore } from '../types.js';

const store: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不要自作主张': { term: '不要自作主张', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
    '不是让你': { term: '不是让你', category: 'correction', weight: 0.85, precision: 'high', source: 'seed' },
    '我说的是': { term: '我说的是', category: 'correction', weight: 0.9, precision: 'ambiguous', source: 'seed' },
    '都说了': { term: '都说了', category: 'correction', weight: 0.8, precision: 'ambiguous', source: 'seed' },
    '不对': { term: '不对', category: 'correction', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '垃圾': { term: '垃圾', category: 'empathy', weight: 0.6, precision: 'ambiguous', source: 'seed' },
  },
};

describe('scanKeywords', () => {
  it('high-precision correction term → direct STRONG, no LLM needed', () => {
    const result = scanKeywords('你又自作主张了，这是错的！', store);
    expect(result.matched).toBe(true);
    expect(result.matchedTerms).toContain('这是错的');
    expect(result.matchedPrecision).toBe('high');
    expect(result.needsLlmConfirmation).toBe(false);
    expect(result.suggestedType).toBe('correction');
  });

  it('ambiguous correction term → needs LLM confirmation', () => {
    const result = scanKeywords('这个不对', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('ambiguous');
    expect(result.needsLlmConfirmation).toBe(true);
  });

  it('no keyword match → empty result, needs LLM', () => {
    const result = scanKeywords('请帮我修复 PR', store);
    expect(result.matched).toBe(false);
    expect(result.matchedTerms).toEqual([]);
    expect(result.needsLlmConfirmation).toBe(true);
  });

  it('high precision takes priority over ambiguous when both match', () => {
    // 一条消息同时含 high 和 ambiguous 词 → high 优先
    const result = scanKeywords('不对，这是错的', store);
    expect(result.matchedPrecision).toBe('high');
    expect(result.needsLlmConfirmation).toBe(false);
  });
});

/**
 * SPEC v0.3 §3.2.2 P-1 七类输入负向矩阵。这里的每一条都是语义契约，
 * 不是实现细节：命中位置/人称/否定决定候选能否直达 STRONG。
 */
describe('P-1 semantic guards (SPEC v0.3 §3.2.2)', () => {
  it('ordinary explicit correction outside quotes still hits high', () => {
    const result = scanKeywords('这是错的，请按我说的改', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('high');
    expect(result.needsLlmConfirmation).toBe(false);
  });

  it('pure third-party quotation alone does not hit (inside paired quotes)', () => {
    const result = scanKeywords('他说“这是错的”，但我不确定', store);
    expect(result.matched).toBe(false);
    expect(result.matchedTerms).toEqual([]);
  });

  it('quoted agent words + explicit correction outside quotes still hits the outside cue', () => {
    const result = scanKeywords('你写的“这是错的”，不要自作主张', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('high');
    expect(result.matchedTerms).toContain('不要自作主张');
  });

  it('quoted agent words + correction outside without a cue stay non-STRONG (discovery path)', () => {
    // 覆盖边界如实保留：引号外没有任何词表提示词时，高精度路径不命中。
    const result = scanKeywords('你写的“这是错的”，我觉得有问题', store);
    expect(result.matched).toBe(false);
    expect(result.matchedTerms).toEqual([]);
  });

  it('third-person reported correction is downgraded to ambiguous', () => {
    // SPEC 新增验收：Codex 子串路径不得把 `他说这是错的` 直接判为 STRONG。
    const result = scanKeywords('他说这是错的', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('ambiguous');
    expect(result.needsLlmConfirmation).toBe(true);
  });

  it('ordinary colloquial downgraded terms never hit high', () => {
    for (const text of ['我说的是这个文件', '都说了别改这个']) {
      const result = scanKeywords(text, store);
      expect(result.matched).toBe(true);
      expect(result.matchedPrecision).toBe('ambiguous');
      expect(result.needsLlmConfirmation).toBe(true);
    }
  });

  it('negated context is downgraded to ambiguous', () => {
    const result = scanKeywords('我不是让你改这里', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('ambiguous');
    expect(result.needsLlmConfirmation).toBe(true);
  });

  it('ordinary requirement change / information addition produces no signal', () => {
    for (const text of ['请把按钮改成蓝色', '顺便补充一下测试用例', '这个需求我改主意了，用另一个方案']) {
      const result = scanKeywords(text, store);
      expect(result.matched).toBe(false);
      expect(result.matchedTerms).toEqual([]);
    }
  });
});
