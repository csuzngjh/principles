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
