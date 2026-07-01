/**
 * signal-keywords-validators — 信号关键词 API 响应运行时校验
 *
 * 遵循 rc-1 ~ rc-5 运行时契约规则：
 * - rc-1: 将 parsed JSON 作 unknown 处理
 * - rc-2: 不用 as bypass，用 typeof / Array.isArray / type guard
 * - rc-3: 必填字段缺失时 loud fail（返回 null）
 * - rc-4: 校验数组元素类型
 * - rc-5: 用 Object.hasOwn 而非 in
 *
 * ERR entries:
 * - ERR-001: unknown 输入 -> runtime validation
 * - ERR-005: 数组元素逐项校验
 * - ERR-007: 拒绝非数组 payload
 * - ERR-009: 必填字段 loud fail
 * - ERR-013: 用 Object.hasOwn 替代 in
 */

import type {
  UnifiedKeywordStore,
  PendingTermStore,
} from './signal-keywords-types.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── UnifiedKeywordStore ───────────────────────────────────────────────────────

export function validateUnifiedKeywordStore(
  raw: unknown,
): UnifiedKeywordStore | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, 'version') || !Object.hasOwn(raw, 'terms')) {
    return null;
  }
  const {version} = raw;
  const {terms} = raw;
  if (typeof version !== 'number') return null;
  if (!isRecord(terms)) return null;

  // rc-4: 校验每个 term 条目
  const validatedTerms: Record<string, UnifiedKeywordStore['terms'][string]> = {};
  for (const [termKey, termRaw] of Object.entries(terms)) {
    if (!isRecord(termRaw)) return null;
    if (
      !Object.hasOwn(termRaw, 'term') ||
      !Object.hasOwn(termRaw, 'category') ||
      !Object.hasOwn(termRaw, 'weight') ||
      !Object.hasOwn(termRaw, 'precision') ||
      !Object.hasOwn(termRaw, 'source')
    ) {
      return null;
    }
    const t = termRaw;
    if (
      typeof t.term !== 'string' ||
      t.term.length === 0 ||
      (t.category !== 'correction' && t.category !== 'empathy') ||
      typeof t.weight !== 'number' ||
      Number.isNaN(t.weight) ||
      t.weight < 0 ||
      t.weight > 1 ||
      (t.precision !== 'high' && t.precision !== 'ambiguous') ||
      (t.source !== 'seed' && t.source !== 'migrated' && t.source !== 'owner_promoted')
    ) {
      return null;
    }
    validatedTerms[termKey] = {
      term: t.term,
      category: t.category,
      weight: t.weight,
      precision: t.precision,
      source: t.source,
    };
  }

  return { version, terms: validatedTerms };
}

// ── PendingTermStore ──────────────────────────────────────────────────────────

export function validatePendingTermStore(
  raw: unknown,
): PendingTermStore | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, 'version') || !Object.hasOwn(raw, 'terms')) {
    return null;
  }
  const {version} = raw;
  const {terms} = raw;
  if (typeof version !== 'number') return null;
  if (!Array.isArray(terms)) return null;

  // rc-4: 校验每个 pending term
  const validatedTerms: PendingTermStore['terms'] = [];
  for (const itemRaw of terms) {
    if (!isRecord(itemRaw)) return null;
    if (
      !Object.hasOwn(itemRaw, 'term') ||
      !Object.hasOwn(itemRaw, 'suggestedCategory') ||
      !Object.hasOwn(itemRaw, 'suggestedPrecision') ||
      !Object.hasOwn(itemRaw, 'reason') ||
      !Object.hasOwn(itemRaw, 'discoveredAt')
    ) {
      return null;
    }
    const t = itemRaw;
    if (
      typeof t.term !== 'string' ||
      t.term.length === 0 ||
      (t.suggestedCategory !== 'correction' && t.suggestedCategory !== 'empathy') ||
      (t.suggestedPrecision !== 'high' && t.suggestedPrecision !== 'ambiguous') ||
      typeof t.reason !== 'string' ||
      typeof t.discoveredAt !== 'string'
    ) {
      return null;
    }
    validatedTerms.push({
      term: t.term,
      suggestedCategory: t.suggestedCategory,
      suggestedPrecision: t.suggestedPrecision,
      reason: t.reason,
      discoveredAt: t.discoveredAt,
      // source 总是 'llm_candidate'
      source: 'llm_candidate',
    });
  }

  return { version, terms: validatedTerms };
}
