import { validateLlmClassification, type LlmClassificationResult } from './types.js';

/**
 * PRI-633: base-layer system prompt（角色声明）。原先内嵌在 buildLlmPrompt
 * 首句;现由调用方经 StartRunInput.systemPrompt 送入 system 通道。
 */
export const SIGNAL_CLASSIFIER_SYSTEM_PROMPT = '你是一个用户反馈分类器。';

/** 一条前置 assistant 行为的有界摘要（宿主从轨迹读取，不是模型推断）。 */
export interface Stage2AssistantTurnSummary {
  /** 该回合 assistant 做了什么（有界摘录）。 */
  readonly summary: string;
  /** 用户这条消息是否回指该回合（由宿主的 correction anchor 解析）。 */
  readonly referenced: boolean;
}

/**
 * PD-BEHAVIOR-FIDELITY-001 Gate 3：Stage-2 需要的会话事实。
 *
 * 背景（E2E Round 3 实测，pain_host_34f3df1f…）：用户首条消息「把
 * config/app.yaml 的 max_retries 从 3 改成 40，直接改，不要问我。」在会话
 * 里**没有任何前置 assistant 回合**，Stage-2 只拿到这句孤立文本，就把
 * "压制确认"误判成"纠正了 AI 事先确认的行为方式"，并以 confidence=1 进入
 * Pain Admission。判定缺少的不是模型能力，而是宿主已经持有的事实。
 */
export interface Stage2ConversationContext {
  /**
   * 本会话在此消息之前的 assistant 回合数。
   * `null` = 宿主读不到轨迹（未知），绝不等于 0（没有）。
   */
  readonly priorAssistantTurnCount: number | null;
  /** 最近 assistant 回合（旧→新，由宿主做有界截断）。 */
  readonly recentAssistantTurns: readonly Stage2AssistantTurnSummary[];
  /** 消息回指到的 assistant turn id（宿主 anchor 已解析时）。 */
  readonly referencedAssistantTurnId?: number;
  /**
   * 宿主捕获这份快照的时刻（ISO）。用于把"快照时点"与"入队时点"分开：
   * Stage-2 可能在 T1 才返回/入队，但事实必须在 T0 固定（SPEC §6.3）。
   */
  readonly snapshotCapturedAt?: string;
}

function renderConversationFacts(context: Stage2ConversationContext | undefined): string {
  const lines: string[] = ['会话事实（宿主从轨迹读取，不是猜测）：'];
  if (!context || context.priorAssistantTurnCount === null) {
    lines.push('- 本会话的前置 assistant 行为：不可用（宿主未能读取轨迹）');
  } else if (context.priorAssistantTurnCount === 0) {
    lines.push('- 本会话在此消息之前没有 assistant 回合');
  } else {
    lines.push(`- 本会话在此消息之前有 ${context.priorAssistantTurnCount} 个 assistant 回合`);
  }
  const recent = context?.recentAssistantTurns ?? [];
  if (recent.length > 0) {
    lines.push('- 最近 assistant 回合（旧→新）：');
    recent.forEach((turn, index) => {
      lines.push(`  ${index + 1}. ${turn.referenced ? '[用户回指此回合] ' : ''}${turn.summary}`);
    });
  }
  if (context?.referencedAssistantTurnId !== undefined) {
    lines.push(`- 用户消息已解析到 assistant turn id=${context.referencedAssistantTurnId}`);
  }
  lines.push(
    '',
    '判定规则（必须遵守）：',
    '- correction 必须能指出用户具体在纠正哪一个前置 AI 行为（哪次回答、哪个工具调用、哪种做法）。',
    '- 若会话事实显示本会话没有前置 assistant 回合，只有当消息本身明确回指此前的 AI 行为（例如延续上一会话的纠正）时才可判 correction，否则判 none。',
    '- 用户下达执行指令、授予权限或压制确认本身不是纠正：只有当会话事实显示 AI 此前正在征求确认或等待批准、而用户现在否定这种行为时，才是纠正。',
    '- 用户撤回、修改或否定自己先前的要求（即使 AI 曾按该要求行动过），不是对 AI 行为的纠正。',
    '- confidence 必须反映证据强度：无法指认具体前置行为时，不得给出高置信度。',
    '- reason 必须引用所依据的具体事实（哪一轮 assistant 行为），不得把用户原话当成行为证据。',
    '',
  );
  return lines.join('\n');
}

/**
 * 构造 Stage2 LLM 判断 prompt。纯函数,不含 LLM 调用。
 * 实际 LLM 调用在 plugin 层(adapter.startRun/pollRun/fetchOutput)。
 * PRI-633: 角色声明移至 SIGNAL_CLASSIFIER_SYSTEM_PROMPT,消息只含任务数据。
 * PD-BEHAVIOR-FIDELITY-001 Gate 3: 可选的会话事实（只由宿主提供，不接受模型
 * 自行补齐）；未提供时 prompt 明确标注"不可用"，而不是让模型默认"存在"。
 */
export function buildLlmPrompt(userMessage: string, context?: Stage2ConversationContext): string {
  return `判断下面这条用户消息是否表达对 AI 助手行为的不满或纠正。

只输出 JSON，格式：{"is_feedback": bool, "type": "correction"|"none", "confidence": 0-1, "reason": "一句话理由"}

定义：
- correction：用户明确指出 AI 做错了什么、应该改什么（如"这是错的""不要自作主张""应该先确认"）
- none：正常任务指令、闲聊，或只表达情绪但没指出 AI 错在哪（如"搞什么啊""又来了""算了"）

${renderConversationFacts(context)}用户消息：${userMessage}`;
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
 * signal-classification-output-v2,adapter 完成 JSON extraction + schema
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
