import { describe, it, expect } from 'vitest';
import { scanKeywords } from '../keyword-stage.js';
import type { UnifiedKeywordStore } from '../types.js';

const store: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', weight: 0.9, precision: 'high', source: 'seed' },
    '不要自作主张': { term: '不要自作主张', weight: 0.9, precision: 'high', source: 'seed' },
    '不是让你': { term: '不是让你', weight: 0.85, precision: 'high', source: 'seed' },
    '我说的是': { term: '我说的是', weight: 0.9, precision: 'ambiguous', source: 'seed' },
    '都说了': { term: '都说了', weight: 0.8, precision: 'ambiguous', source: 'seed' },
    '不对': { term: '不对', weight: 0.5, precision: 'ambiguous', source: 'seed' },
    '垃圾': { term: '垃圾', weight: 0.6, precision: 'ambiguous', source: 'seed' },
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

  it('P2-1: ambiguous terms inside paired quotes alone produce no candidate', () => {
    for (const text of ['他说“我说的是另一个文件”', '他说“都说了”']) {
      const result = scanKeywords(text, store);
      expect(result.matched).toBe(false);
      expect(result.matchedTerms).toEqual([]);
    }
  });

  it('P2-1: an ambiguous term outside the quotes still hits when the same term is also quoted', () => {
    const result = scanKeywords('他说“都说了”，都说了别改', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('ambiguous');
    expect(result.matchedTerms).toContain('都说了');
  });

  it('P2-1: normal ambiguous speech outside quotes still enters Stage 2', () => {
    const result = scanKeywords('我说的是这个文件', store);
    expect(result.matched).toBe(true);
    expect(result.matchedPrecision).toBe('ambiguous');
  });

  it('ordinary requirement change / information addition produces no signal', () => {
    for (const text of ['请把按钮改成蓝色', '顺便补充一下测试用例', '这个需求我改主意了，用另一个方案']) {
      const result = scanKeywords(text, store);
      expect(result.matched).toBe(false);
      expect(result.matchedTerms).toEqual([]);
    }
  });
});

/**
 * SPEC P-5 的假阴性缺口：句首预过滤退役后，假设/条件语境也进入了高精度路径。
 * 「如果这是错的」是假设，不是 Owner 的事实断言 → 不得直达 STRONG。
 */
describe('conditional / hypothetical context is downgraded (P-1b)', () => {
  const directionalStore: UnifiedKeywordStore = {
    version: 1,
    terms: {
      ...store.terms,
      '方向反了': { term: '方向反了', weight: 0.9, precision: 'high', source: 'seed' },
      '方案有问题': { term: '方案有问题', weight: 0.9, precision: 'high', source: 'seed' },
      '不行': { term: '不行', weight: 0.8, precision: 'high', source: 'seed' },
    },
  };

  it('hypothetical markers downgrade a high-precision correction to ambiguous', () => {
    for (const text of ['如果这是错的，请告诉我', '要是这是错的呢', '假设这是错的', '万一这是错的']) {
      const result = scanKeywords(text, store);
      expect(result.matched).toBe(true);
      expect(result.matchedPrecision).toBe('ambiguous');
      expect(result.needsLlmConfirmation).toBe(true);
      expect(result.matchedTerms).toContain('这是错的');
    }
    const directional = scanKeywords('假如方向反了怎么办', directionalStore);
    expect(directional.matched).toBe(true);
    expect(directional.matchedPrecision).toBe('ambiguous');
    expect(directional.needsLlmConfirmation).toBe(true);
  });

  it('positive control: a real correction without a hypothetical marker still hits STRONG', () => {
    for (const text of ['这是错的，重新做', '这是错的，请按我说的改']) {
      const result = scanKeywords(text, store);
      expect(result.matched).toBe(true);
      expect(result.matchedPrecision).toBe('high');
      expect(result.needsLlmConfirmation).toBe(false);
    }
  });

  it('防回退的条件复句：条件约束整句，后置小句的高精度纠正词降级为 ambiguous', () => {
    // 中文条件复句里条件约束前后两个小句：前半句是假设，后半句就不是事实断言。
    for (const text of ['如果方向反了，这是错的', '假如方案有问题，这是错的', '万一不行，这是错的']) {
      const result = scanKeywords(text, directionalStore);
      expect(result.matched).toBe(true);
      expect(result.matchedTerms).toContain('这是错的');
      expect(result.matchedPrecision).toBe('ambiguous');
      expect(result.needsLlmConfirmation).toBe(true);
    }
  });

  it('条件语境只回溯到本句：句末标点之后仍判 STRONG', () => {
    const crossSentence = scanKeywords('如果方向反了。这是错的', directionalStore);
    expect(crossSentence.matchedPrecision).toBe('high');
    expect(crossSentence.needsLlmConfirmation).toBe(false);
  });

  it('语义边界：条件在后、或者高精度词本身在条件小句内，都不会被误判为 STRONG', () => {
    // 纠正在前、条件在后：不是条件语境，保持 STRONG（未做特殊处理，作为边界记录）。
    for (const text of ['这是错的，如果要改就改', '这是错的，如果是那样的话']) {
      const result = scanKeywords(text, store);
      expect(result.matchedPrecision).toBe('high');
      expect(result.needsLlmConfirmation).toBe(false);
    }
    // 高精度词本身位于条件小句内：只能降级，不可能是 STRONG。
    const insideCondition = scanKeywords('如果方向反了，请重做', directionalStore);
    expect(insideCondition.matchedTerms).toContain('方向反了');
    expect(insideCondition.matchedPrecision).toBe('ambiguous');
    expect(insideCondition.needsLlmConfirmation).toBe(true);
  });
});
