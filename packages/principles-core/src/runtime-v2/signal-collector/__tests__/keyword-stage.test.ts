import { describe, it, expect } from 'vitest';
import { scanKeywords } from '../keyword-stage.js';
import type { UnifiedKeywordStore } from '../types.js';

const store: UnifiedKeywordStore = {
  version: 1,
  terms: {
    '这是错的': { term: '这是错的', category: 'correction', weight: 0.9, precision: 'high', source: 'seed' },
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
