import { scanKeywords } from './keyword-stage.js';
import type {
  UnifiedKeywordStore, SignalCollectorConfig, SignalCollectorOutput,
  LlmClassificationResult, SignalEvidence,
} from './types.js';

const MAX_EXCERPT = 200;

export function buildEvidence(text: string): SignalEvidence {
  const excerpt = text.length > MAX_EXCERPT ? text.slice(0, MAX_EXCERPT) : text;
  return { excerpt, detectedAt: new Date().toISOString() };
}

/**
 * 同步阶段(prompt hook 内调用,绝不阻塞):Stage1 关键词快扫。
 * - high 精度命中 → 直接返回 final output(needsLlmConfirmation=false)
 * - ambiguous / 未命中 → 返回 pending output(needsLlmConfirmation=true, isSignal=false)
 *   由 plugin 层异步调 mapLlmResultToOutput 完成 Stage2。
 *
 * 注意:这个函数不调 LLM。LLM 在 plugin 层。
 */
// eslint-disable-next-line @typescript-eslint/max-params -- positional API for plugin-layer call sites (text, sessionId, store, config)
export function collectSync(
  text: string,
  sessionId: string,
  store: UnifiedKeywordStore,
  _config: SignalCollectorConfig,
): SignalCollectorOutput {
  void sessionId;
  void _config;
  const scan = scanKeywords(text, store);
  const evidence = buildEvidence(text);

  if (scan.matched && scan.matchedPrecision === 'high' && scan.suggestedType) {
    return {
      isSignal: true,
      type: scan.suggestedType,
      strength: scan.suggestedType === 'correction' ? 'STRONG' : 'WEAK',
      matchedTerms: scan.matchedTerms,
      matchedPrecision: 'high',
      detectionSource: 'keyword',
      needsLlmConfirmation: false,
      evidence,
    };
  }

  return {
    isSignal: false,
    type: null,
    strength: null,
    matchedTerms: scan.matchedTerms,
    matchedPrecision: scan.matchedPrecision,
    detectionSource: 'none',
    needsLlmConfirmation: true,
    evidence,
  };
}

/**
 * Stage2(异步,plugin 层拿到 LLM 结果后调用):把 LLM 分类映射成 final output。
 */
// eslint-disable-next-line @typescript-eslint/max-params -- positional API: (llm, text, sessionId, config)
export function mapLlmResultToOutput(
  llm: LlmClassificationResult,
  text: string,
  _sessionId: string,
  config: SignalCollectorConfig,
): SignalCollectorOutput {
  void _sessionId;
  void config;
  const evidence = buildEvidence(text);

  if (!llm.is_feedback || llm.type === 'none') {
    return {
      isSignal: false, type: null, strength: null, matchedTerms: [],
      matchedPrecision: null, detectionSource: 'llm', needsLlmConfirmation: false,
      llmReason: llm.reason, evidence,
    };
  }

  return {
    isSignal: true,
    type: llm.type,
    strength: llm.type === 'correction' ? 'STRONG' : 'WEAK',
    matchedTerms: [],
    matchedPrecision: null,
    detectionSource: 'llm',
    needsLlmConfirmation: false,
    llmReason: llm.reason,
    evidence,
  };
}
