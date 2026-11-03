import type { UnifiedKeywordStore, KeywordCategory, MatchedPrecision } from './types.js';

export interface KeywordScanResult {
  matched: boolean;
  matchedTerms: string[];
  matchedPrecision: MatchedPrecision;
  needsLlmConfirmation: boolean;
  suggestedType: KeywordCategory | null;
}

/**
 * SPEC v0.3 §3.2.2 P-1 位置/引用防护。
 *
 * 关键词匹配仍是「裸子串」语义（不引入 NLP 框架），但命中能否直达 STRONG
 * 由三个确定性条件共同决定：
 * - 引号内：不单独构成 STRONG，也不作为候选上报（零命中 discovery 保留）；
 * - 第三人称转述前缀（他说 / 据说 / 文档写着…）：降级 ambiguous；
 * - 否定前置（并不是 / 没让你 / 我不是让你…）：降级 ambiguous。
 *
 * 降级词表（我说的是 / 都说了）由词库 precision 负责（单一真理源），这里
 * 不重复判断。
 */
interface QuotedRange {
  start: number;
  end: number;
}

/** 成对引号：中文引号、书名式引号、反引号与 ASCII 双引号。 */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['“', '”'],
  ['「', '」'],
  ['『', '』'],
  ['`', '`'],
  ['"', '"'],
];

const CLAUSE_BOUNDARIES = new Set([
  '。', '！', '？', '；', '\n', '，', '、', '：', ':', ';', ',', '!', '?', '.',
]);

const THIRD_PERSON_PREFIX = /(?:他|她|它|有人|别人|旁人|同事|朋友|领导|客户|网友|用户)(?:说|说过|称|提到|认为|表示)|(?:文档|注释|日志|报错|错误信息|README)(?:里|上面|中)?(?:说|写着|写道|提到)|(?:据说|听说)/u;

const NEGATION_ENDING = /(?:并不是|不是|没有|没|别|不|非)$/u;
const PRONOUN_ENDING = /(?:我|你|他|她|我们|你们|他们|并|也|都|就|可|但|而|却|还|又)$/u;
const NEGATION_INITIAL_TERM = /^(?:不是|没|没有|别让)/u;

function findQuotedRanges(text: string): QuotedRange[] {
  const ranges: QuotedRange[] = [];
  for (const [open, close] of QUOTE_PAIRS) {
    let from = 0;
    while (from < text.length) {
      const openIndex = text.indexOf(open, from);
      if (openIndex < 0) break;
      const closeIndex = text.indexOf(close, openIndex + open.length);
      if (closeIndex < 0) break;
      ranges.push({ start: openIndex + open.length, end: closeIndex });
      from = closeIndex + close.length;
    }
  }
  return ranges;
}

function isInsideQuotes(start: number, end: number, ranges: readonly QuotedRange[]): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

/** 命中词所在的当前小句前缀（回溯到最近的标点/换行）。 */
function clausePrefix(text: string, index: number): string {
  let start = index;
  while (start > 0 && !CLAUSE_BOUNDARIES.has(text[start - 1] ?? '')) start -= 1;
  return text.slice(start, index);
}

function hasThirdPersonPrefix(prefix: string): boolean {
  return THIRD_PERSON_PREFIX.test(prefix);
}

function hasNegationPrefix(prefix: string, term: string): boolean {
  if (NEGATION_ENDING.test(prefix)) return true;
  // 「我不是让你」「我没让你」：否定词是命中词自身的一部分，前置人称/副词才构成否定语境。
  return PRONOUN_ENDING.test(prefix) && NEGATION_INITIAL_TERM.test(term);
}

function findOccurrences(haystack: string, needle: string): number[] {
  const positions: number[] = [];
  if (needle.length === 0) return positions;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    positions.push(index);
    from = index + needle.length;
  }
  return positions;
}

type HighHitDisposition = 'strong' | 'downgraded' | 'quoted';

function classifyHighOccurrence(
  normalizedText: string,
  term: string,
  occurrence: { index: number; quotedRanges: readonly QuotedRange[] },
): HighHitDisposition {
  const { index, quotedRanges } = occurrence;
  const end = index + term.length;
  if (isInsideQuotes(index, end, quotedRanges)) return 'quoted';
  const prefix = clausePrefix(normalizedText, index);
  if (hasThirdPersonPrefix(prefix)) return 'downgraded';
  if (hasNegationPrefix(prefix, term)) return 'downgraded';
  return 'strong';
}

/**
 * Stage 1: 同步关键词快扫。零成本,纯函数。
 *
 * 精度分级：
 * - 命中 high 精度词且通过 P-1 防护 → 直接判定,不走 LLM
 * - 命中 ambiguous 词 / 被 P-1 降级的 high 命中 → 仅作候选,强制过 LLM
 * - 引号内 high 命中 → 不产生候选（保留零命中 discovery 路径）
 */
export function scanKeywords(text: string, store: UnifiedKeywordStore): KeywordScanResult {
  const normalized = text.trim().toLowerCase();
  const quotedRanges = findQuotedRanges(normalized);

  let highHit: { term: string; category: KeywordCategory } | null = null;
  const ambiguousHits: { term: string; category: KeywordCategory }[] = [];

  for (const term of Object.keys(store.terms)) {
    if (!Object.hasOwn(store.terms, term)) continue;  // rc-5
    const kw = store.terms[term];
    if (!kw) continue;
    const lowered = term.toLowerCase();
    if (kw.precision === 'high') {
      const dispositions = findOccurrences(normalized, lowered)
        .map((index) => classifyHighOccurrence(normalized, lowered, { index, quotedRanges }));
      const strong = dispositions.includes('strong');
      if (strong) {
        // CodeRabbit #10: 不 break,遍历所有 high 命中,correction 优先于 empathy
        // (避免结果依赖 terms 对象的键插入顺序)
        if (!highHit || kw.category === 'correction') {
          highHit = { term, category: kw.category };
        }
      } else if (dispositions.includes('downgraded')) {
        // 第三人称/否定语境命中仍是候选，但必须经 Stage 2 确认。
        ambiguousHits.push({ term, category: kw.category });
      }
      // quoted-only: 不进入任何结果（引号内不单独构成信号，也不消耗候选）。
      continue;
    }
    // P2-1: quote protection applies to EVERY precision, not just high. A
    // phrase that only appears inside a quotation is not the Owner speaking;
    // at least one occurrence must be outside the paired quotes.
    const hasOutsideQuotes = findOccurrences(normalized, lowered)
      .some((index) => !isInsideQuotes(index, index + lowered.length, quotedRanges));
    if (hasOutsideQuotes) {
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
