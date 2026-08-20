import { validateLlmClassification, type LlmClassificationResult } from './types.js';

/**
 * 构造 Stage2 LLM 判断 prompt。纯函数,不含 LLM 调用。
 * 实际 LLM 调用在 plugin 层(adapter.startRun/pollRun/fetchOutput)。
 */
export function buildLlmPrompt(userMessage: string): string {
  return `你是一个用户反馈分类器。判断下面这条用户消息是否表达对 AI 助手行为的不满或纠正。

只输出 JSON，格式：{"is_feedback": bool, "type": "correction"|"empathy"|"none", "confidence": 0-1, "reason": "一句话理由"}

定义：
- correction：用户明确指出 AI 做错了什么、应该改什么（如"这是错的""不要自作主张""应该先确认"）
- empathy：用户表达挫败/不满情绪，但没明确指出 AI 错在哪（如"搞什么啊""又来了""算了"）
- none：正常任务指令或闲聊

用户消息：${userMessage}`;
}

export interface ParseResult {
  valid: boolean;
  value: LlmClassificationResult | null;
}

/**
 * 解析并校验 LLM 返回的 JSON。rc-2: 不用 as,用类型守卫。
 * 校验失败返回 {valid: false, value: null},由调用方降级处理(rc-9)。
 */
export function parseLlmClassification(raw: string): ParseResult {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (validateLlmClassification(parsed)) {
      return { valid: true, value: parsed };
    }
    return { valid: false, value: null };
  } catch {
    return { valid: false, value: null };
  }
}

// ── RuntimeAdapter payload → classification (typed contract, INV-01) ──

export type ClassifierPayloadPath =
  | 'structured'        // canonical: adapter 经 outputSchemaRef 校验的结构化对象
  | 'legacy_string'     // 兼容: 未实现 schema ref 的 adapter 返回 raw string
  | 'legacy_envelope'   // 兼容: {output: string} 信封
  | 'invalid';          // 不可用 → 调用方降级 (rc-9 必须留观测痕迹)

export interface PayloadResolveResult {
  path: ClassifierPayloadPath;
  value: LlmClassificationResult | null;
}

/**
 * 解析 RuntimeAdapter fetchOutput 的 payload 为分类结果。
 *
 * Canonical path 是 structured object(分类器以 outputSchemaRef 请求
 * signal-classification-output-v1,adapter 完成 JSON extraction + schema
 * validation + bounded repair)。string / {output: string} 仅是未实现 schema
 * ref 的 adapter 的 compatibility fallback——消费侧仍对 unknown payload 做
 * 类型守卫(rc-1/rc-2,纵深防御: producer contract 不替代 consumer 校验)。
 */
export function resolveLlmClassificationPayload(payload: unknown): PayloadResolveResult {
  if (validateLlmClassification(payload)) {
    return { path: 'structured', value: payload };
  }
  if (typeof payload === 'string') {
    const parsed = parseLlmClassification(payload);
    if (parsed.valid && parsed.value) return { path: 'legacy_string', value: parsed.value };
  } else if (typeof payload === 'object' && payload !== null && Object.hasOwn(payload, 'output')) {
    const maybeOutput = (payload as { output?: unknown }).output;
    if (typeof maybeOutput === 'string') {
      const parsed = parseLlmClassification(maybeOutput);
      if (parsed.valid && parsed.value) return { path: 'legacy_envelope', value: parsed.value };
    }
  }
  return { path: 'invalid', value: null };
}
