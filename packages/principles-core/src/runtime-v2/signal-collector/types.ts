import { Type, type Static } from '@sinclair/typebox';

// ── Unified Keyword Store (合并后的统一词库,纯数据) ──

export type KeywordCategory = 'correction' | 'empathy';
export type TermSource = 'seed' | 'migrated' | 'owner_promoted' | 'llm_learned';

export interface UnifiedKeyword {
  term: string;
  category: KeywordCategory;
  weight: number;       // 0-1
  precision: 'high' | 'ambiguous';   // 评审意见4: 高精度 vs 歧义词
  source: TermSource;
}

export interface UnifiedKeywordStore {
  version: number;
  terms: Record<string, UnifiedKeyword>;  // key = term
}

// ── Pending Terms (LLM 发现词候选池, owner-governed, 评审意见3) ──

export interface PendingTerm {
  term: string;
  suggestedCategory: KeywordCategory;
  suggestedPrecision: 'high' | 'ambiguous';
  reason: string;          // LLM 给出的理由
  discoveredAt: string;    // ISO
  source: 'llm_candidate';
}

export interface PendingTermStore {
  version: number;
  terms: PendingTerm[];
}

// ── SignalCollector Input / Output ──

export interface SignalCollectorConfig {
  enableLlmStage: boolean;
  llmTimeoutMs: number;          // 异步超时,默认 30000
  promptTemplate: string;
  strongPainScore: number;       // STRONG 信号的 pain score,默认 70
  strongRateLimitPerHour: number; // 单 session 每小时 STRONG 上限,默认 5
}

export type SignalStrength = 'STRONG' | 'WEAK';
export type DetectionSource = 'keyword' | 'llm' | 'none';
export type MatchedPrecision = 'high' | 'ambiguous' | null;

export interface SignalEvidence {
  excerpt: string;
  detectedAt: string;
}

export interface SignalCollectorOutput {
  isSignal: boolean;
  type: 'correction' | 'empathy' | null;
  strength: SignalStrength | null;
  matchedTerms: string[];
  matchedPrecision: MatchedPrecision;
  detectionSource: DetectionSource;
  needsLlmConfirmation: boolean;
  llmReason?: string;
  evidence: SignalEvidence;
}

// ── TypeBox Schema (用于校验, ERR-001 防御) ──

export const SignalCollectorOutputSchema = {
  validate(value: unknown): value is SignalCollectorOutput {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    if (typeof v.isSignal !== 'boolean') return false;
    if (v.type !== null && v.type !== 'correction' && v.type !== 'empathy') return false;
    if (v.strength !== null && v.strength !== 'STRONG' && v.strength !== 'WEAK') return false;
    if (!Array.isArray(v.matchedTerms)) return false;
    if (v.matchedPrecision !== null && v.matchedPrecision !== 'high' && v.matchedPrecision !== 'ambiguous') return false;
    if (v.detectionSource !== 'keyword' && v.detectionSource !== 'llm' && v.detectionSource !== 'none') return false;
    if (typeof v.needsLlmConfirmation !== 'boolean') return false;
    const ev = v.evidence;
    if (typeof ev !== 'object' || ev === null) return false;
    const e = ev as Record<string, unknown>;
    if (typeof e.excerpt !== 'string' || typeof e.detectedAt !== 'string') return false;
    return true;
  },
};

// ── LLM 输出 schema (Stage2 fetchOutput 后校验) ──

export interface LlmClassificationResult {
  is_feedback: boolean;
  type: 'correction' | 'empathy' | 'none';
  confidence: number;   // 0-1
  reason: string;
}

export function validateLlmClassification(value: unknown): value is LlmClassificationResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.is_feedback !== 'boolean') return false;
  if (v.type !== 'correction' && v.type !== 'empathy' && v.type !== 'none') return false;
  if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) return false;
  if (typeof v.reason !== 'string') return false;
  return true;
}

// ── Stage2 structured-output contract (signal-classification-output-v1) ──
//
// RuntimeAdapter 的 canonical 输出契约: 分类器以 outputSchemaRef 引用本 schema,
// adapter 负责 JSON extraction + schema validation (+ bounded repair),分类器直接
// 消费 validated structured payload (MVP_CORE_LOOP_CONTRACT INV-01)。
// 字段名与 LlmClassificationResult 保持一致(snake_case 即 prompt 中的字面格式)。

export const SignalClassificationOutputV1Schema = Type.Object({
  is_feedback: Type.Boolean(),
  type: Type.Union([Type.Literal('correction'), Type.Literal('empathy'), Type.Literal('none')]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  reason: Type.String(),
});
export type SignalClassificationOutputV1 = Static<typeof SignalClassificationOutputV1Schema>;
