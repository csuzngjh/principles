/**
 * signal-keywords-types — 信号关键词前端类型定义
 *
 * 镜像后端 UnifiedKeyword / PendingTerm 等类型，供控制台 UI 消费。
 *
 * ERR entries:
 * - rc-1: 纯静态类型定义，无 untrusted 输入
 * - rc-2: 无 `as` bypass
 */

// ── 词库关键词 ────────────────────────────────────────────────────────────────

export type KeywordCategory = 'correction' | 'empathy';

/** 词库来源 — 词库中已有的审定点 */
export type TermSource = 'seed' | 'migrated' | 'owner_promoted';

export interface UnifiedKeyword {
  term: string;
  category: KeywordCategory;
  /** 权重 0-1 */
  weight: number;
  /** 高精度 vs 歧义词 */
  precision: 'high' | 'ambiguous';
  source: TermSource;
}

export interface UnifiedKeywordStore {
  version: number;
  /** key = term */
  terms: Record<string, UnifiedKeyword>;
}

// ── LLM 候选池 ─────────────────────────────────────────────────────────────────

/** 候选来源 — LLM 新发现的词（待 owner 审批） */
export type PendingTermSource = 'llm_candidate';

export interface PendingTerm {
  term: string;
  suggestedCategory: KeywordCategory;
  suggestedPrecision: 'high' | 'ambiguous';
  /** LLM 给出的发现理由 */
  reason: string;
  /** ISO 时间戳 */
  discoveredAt: string;
  source: PendingTermSource;
}

export interface PendingTermStore {
  version: number;
  terms: PendingTerm[];
}

// ── API 请求 / 响应 ───────────────────────────────────────────────────────────

/** 更新词库的请求体 */
export interface UpdateKeywordStoreRequest {
  version: number;
  terms: Record<string, Omit<UnifiedKeyword, 'term'>>;
}

/** 审批一个 PendingTerm 的请求体 */
export interface AdmitPendingTermRequest {
  term: string;
  category: KeywordCategory;
  precision: 'high' | 'ambiguous';
}

// ── Consumer-facing 类型别名 ───────────────────────────────────────────────
// SignalKeywordsPage 使用这些别名，与 api.ts 导出名一致。

/** SignalKeywordsPage 使用的关键词类型（UnifiedKeyword 的别名） */
export type SignalKeyword = UnifiedKeyword;

/** SignalKeywordsPage 使用的待确认信号词类型（PendingTerm 的别名） */
export type PendingSignalTerm = PendingTerm;
