import { Type, type Static } from '@sinclair/typebox';

// ── Unified Keyword Store (合并后的统一词库,纯数据) ──

export type TermSource = 'seed' | 'migrated' | 'owner_promoted' | 'llm_learned';

export interface UnifiedKeyword {
  term: string;
  weight: number;       // 0-1
  precision: 'high' | 'ambiguous';   // 评审意见4: 高精度 vs 歧义词
  source: TermSource;
}

export interface UnifiedKeywordStore {
  version: number;
  terms: Record<string, UnifiedKeyword>;  // key = term
}

// ── Pending Terms ──
// (PendingTerm / PendingTermStore removed in PRI-819: the "LLM learns term →
// Owner approves from pending pool" design never got a production writer or
// server routes. The live learning path is correctionObserver → keyword store
// (source='llm_learned') → governance-signal-admission → earned precision.)

// ── SignalCollector Input / Output ──

export interface SignalCollectorConfig {
  enableLlmStage: boolean;
  llmTimeoutMs: number;          // 异步超时,默认 30000
  promptTemplate: string;
  strongPainScore: number;       // STRONG 信号的 pain score,默认 70
  strongRateLimitPerHour: number; // 单 session 每小时 STRONG 上限,默认 5
  /**
   * 零命中(= 无任何关键词候选)时发起 Stage2「发现新纠正词」调用的每小时上限。
   * 未命中不代表纠正,但它是学习通道的入口;真实语料里约九成(90–93%)的消息零命中,
   * 每条都发起一次发现调用会把端点额度烧在普通消息上。歧义命中(有候选词)是
   * 确认调用,不受此限。仅 host 层执行,core 只承载配置值。
   * 0 / 未设置 = 不限制(旧行为)。
   */
  discoveryRateLimitPerHour?: number;
  /**
   * 单个 session 每小时的零命中「发现」调用上限。发现预算必须对 session 公平：
   * 一个 session 的普通消息不能耗尽其它 session 的全部预算，否则它后面的明确
   * 纠正（仍需 LLM 确认）会被别的会话的闲聊挡住。0 / 未设置 = 不限制该维度。
   */
  discoveryRateLimitPerSessionPerHour?: number;
}

export type SignalStrength = 'STRONG';
export type DetectionSource = 'keyword' | 'llm' | 'none';
export type MatchedPrecision = 'high' | 'ambiguous' | null;

export interface SignalEvidence {
  excerpt: string;
  detectedAt: string;
}

export interface SignalCollectorOutput {
  isSignal: boolean;
  type: 'correction' | null;
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
    if (v.type !== null && v.type !== 'correction') return false;
    if (v.strength !== null && v.strength !== 'STRONG') return false;
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
  type: 'correction' | 'none';
  confidence: number;   // 0-1
  reason: string;
}

export function validateLlmClassification(value: unknown): value is LlmClassificationResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.is_feedback !== 'boolean') return false;
  if (v.type !== 'correction' && v.type !== 'none') return false;
  if (typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1) return false;
  if (typeof v.reason !== 'string') return false;
  return true;
}

// ── Stage2 structured-output contract (signal-classification-output-v2) ──
//
// RuntimeAdapter 的 canonical 输出契约: 分类器以 outputSchemaRef 引用本 schema,
// adapter 负责 JSON extraction + schema validation (+ bounded repair),分类器直接
// 消费 validated structured payload (MVP_CORE_LOOP_CONTRACT INV-01)。
// 字段名与 LlmClassificationResult 保持一致(snake_case 即 prompt 中的字面格式)。

export const SignalClassificationOutputV2Schema = Type.Object({
  is_feedback: Type.Boolean(),
  type: Type.Union([Type.Literal('correction'), Type.Literal('none')]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  reason: Type.String(),
});
export type SignalClassificationOutputV2 = Static<typeof SignalClassificationOutputV2Schema>;
