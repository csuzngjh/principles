import type { UnifiedKeywordStore, KeywordCategory, MatchedPrecision } from './types.js';

export interface KeywordScanResult {
  matched: boolean;
  matchedTerms: string[];
  matchedPrecision: MatchedPrecision;
  needsLlmConfirmation: boolean;
  suggestedType: KeywordCategory | null;
}

/**
 * Stage 1: 同步关键词快扫。零成本,纯函数。
 *
 * 精度分级(评审意见4):
 * - 命中 high 精度词 → 直接判定,不走 LLM(needsLlmConfirmation=false)
 * - 命中 ambiguous 词 → 仅作候选,强制过 LLM(needsLlmConfirmation=true)
 * - 全未命中 → 走 LLM 发现
 *
 * 多词命中时:high 优先于 ambiguous。
 */
export function scanKeywords(text: string, store: UnifiedKeywordStore): KeywordScanResult {
  const normalized = text.trim().toLowerCase();

  let highHit: { term: string; category: KeywordCategory } | null = null;
  const ambiguousHits: { term: string; category: KeywordCategory }[] = [];

  for (const term of Object.keys(store.terms)) {
    if (!Object.hasOwn(store.terms, term)) continue;  // rc-5
    const kw = store.terms[term];
    if (!kw) continue;
    if (normalized.includes(term.toLowerCase())) {
      if (kw.precision === 'high') {
        highHit = { term, category: kw.category };
        break;  // high 优先,找到即停
      }
      ambiguousHits.push({ term, category: kw.category });
    }
  }

  if (highHit) {
    return {
      matched: true,
      matchedTerms: [highHit.term],
      matchedPrecision: 'high',
      needsLlmConfirmation: false,
      suggestedType: highHit.category,
    };
  }

  if (ambiguousHits.length > 0) {
    const [first] = ambiguousHits;
    return {
      matched: true,
      matchedTerms: ambiguousHits.map((h) => h.term),
      matchedPrecision: 'ambiguous',
      needsLlmConfirmation: true,
      suggestedType: first ? first.category : null,
    };
  }

  return {
    matched: false,
    matchedTerms: [],
    matchedPrecision: null,
    needsLlmConfirmation: true,
    suggestedType: null,
  };
}
