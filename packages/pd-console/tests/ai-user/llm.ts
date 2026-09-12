/**
 * PRI-754 — AI User 的 LLM 调用与决策解析。
 *
 * 调用惯例对齐 pd-cli quality-scorecard（strong-model-gate.ts）：OpenAI 兼容
 * POST {baseUrl}/chat/completions + Bearer。操作员配置的 baseUrl 在任何请求前
 * 校验（CWE-918 同一立场：仅 http/https、禁止内嵌凭据；本地/私有 OpenAI 兼容
 * 端点属可信操作员配置，保持支持——LM Studio / 本地网关可用）。
 *
 * 模型回复是不可信运行时数据（rc-1）：抽取 JSON 后逐字段守卫校验，畸形输出
 * 是可重试错误，不用 `as` 断言成形状（rc-2）；进入提示词/日志的越界文本一律
 * 有界截断（rc-8）。
 */

export interface AiUserLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const AI_USER_ACTION_TYPES = ['navigate', 'click', 'fill', 'press', 'wait', 'finish'] as const;

export type AiUserActionType = (typeof AI_USER_ACTION_TYPES)[number];

export interface AiUserAction {
  /** click/fill 的目标选择器（role=button[name="…"] / text=文字 / CSS）。 */
  target?: string;
  /** fill=输入文本；navigate=站内路径（/ 开头）；press=键名；wait=毫秒。 */
  value?: string;
  /** finish 专用：目标是否达成。 */
  success?: boolean;
  /** finish 专用：一句话结论。 */
  note?: string;
  type: AiUserActionType;
}

export interface AiUserDecision {
  thought: string;
  action: AiUserAction;
  problems: string[];
  suggestions: string[];
}

export function bounded(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + '…[截断]';
}

/**
 * 与 pd-cli strong-model-gate.assertSafeLlmBaseUrl 同构：仅 http/https、
 * 禁止内嵌凭据。本地/私有端点合法（可信操作员配置），故不拒绝 loopback。
 */
export function assertSafeLlmBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`非法 LLM base URL: ${bounded(raw, 200)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`LLM base URL 仅允许 http/https，收到 ${url.protocol}`);
  }
  if (url.username || url.password) {
    throw new Error('LLM base URL 不允许内嵌凭据');
  }
  return url;
}

export function resolveLlmConfig(overrides?: Partial<AiUserLlmConfig>): AiUserLlmConfig {
  const baseUrl = assertSafeLlmBaseUrl(
    overrides?.baseUrl ?? process.env['OPENAI_BASE_URL'] ?? 'https://api.openai.com/v1',
  ).toString();
  const apiKey = overrides?.apiKey ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY 未设置，无法调用 AI User 模型。nextAction: 设置 OPENAI_API_KEY 后重试');
  }
  const model = overrides?.model ?? process.env['PD_AI_USER_MODEL'];
  if (!model) {
    throw new Error('未指定 AI User 模型。nextAction: 传 --model <id> 或设置 PD_AI_USER_MODEL');
  }
  return { baseUrl, apiKey, model };
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

const FENCED_JSON_PATTERN = /```(?:json)?\s*([\s\S]*?)```/;

/** 从模型回复中提取第一个可解析的 JSON 对象文本；找不到返回 null。 */
export function extractJsonBlock(content: string): string | null {
  const candidates: string[] = [];
  const trimmed = content.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.push(trimmed);
  const fenced = content.match(FENCED_JSON_PATTERN);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(content.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 尝试下一个候选
    }
  }
  return null;
}

function requireActionString(action: Record<string, unknown>, field: string, type: string): string {
  const value = action[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`动作 ${type} 缺少非空字符串字段 "${field}"`);
  }
  return value;
}

function validateAction(action: unknown): AiUserAction {
  const record = asRecord(action);
  if (record === null) throw new Error('decision 缺少 action 对象');
  const type = record['type'];
  if (typeof type !== 'string' || !(AI_USER_ACTION_TYPES as readonly string[]).includes(type)) {
    throw new Error(`未知动作类型 "${String(type)}"，允许: ${AI_USER_ACTION_TYPES.join('|')}`);
  }
  const result: AiUserAction = { type: type as AiUserActionType };
  switch (type) {
    case 'click':
      result.target = requireActionString(record, 'target', type);
      break;
    case 'fill':
      result.target = requireActionString(record, 'target', type);
      if (!('value' in record) || typeof record['value'] !== 'string') {
        throw new Error('动作 fill 缺少字符串字段 "value"');
      }
      result.value = record['value'];
      break;
    case 'navigate': {
      const url = requireActionString(record, 'value', type);
      if (!url.startsWith('/')) {
        throw new Error('动作 navigate 的 value 必须是站内路径（/ 开头）');
      }
      result.value = url;
      break;
    }
    case 'press':
      result.value = requireActionString(record, 'value', type);
      break;
    case 'wait':
      if (record['value'] !== undefined) {
        const ms = Number(record['value']);
        if (!Number.isFinite(ms) || ms < 0) throw new Error('动作 wait 的 value 必须是非负毫秒数');
        result.value = String(ms);
      }
      break;
    case 'finish':
      if (record['success'] !== undefined) {
        if (typeof record['success'] !== 'boolean') throw new Error('动作 finish 的 success 必须是布尔值');
        result.success = record['success'];
      }
      if (record['note'] !== undefined) {
        if (typeof record['note'] !== 'string') throw new Error('动作 finish 的 note 必须是字符串');
        result.note = record['note'];
      }
      break;
  }
  return result;
}

/** 解析模型回复为决策对象；任何协议违规都抛错（由调用方决定是否重试）。 */
export function parseAiUserDecision(content: string): AiUserDecision {
  const jsonText = extractJsonBlock(content);
  if (jsonText === null) {
    throw new Error(`回复中未找到 JSON 对象: ${bounded(content, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const record = asRecord(parsed);
  if (record === null) throw new Error('决策必须是 JSON 对象');
  const thought = record['thought'];
  if (typeof thought !== 'string' || thought.trim().length === 0) {
    throw new Error('决策缺少非空字符串字段 "thought"');
  }
  const action = validateAction(record['action']);
  const problems = record['problems'] ?? [];
  const suggestions = record['suggestions'] ?? [];
  if (!isNonEmptyStringArray(problems)) throw new Error('"problems" 必须是非空字符串数组');
  if (!isNonEmptyStringArray(suggestions)) throw new Error('"suggestions" 必须是非空字符串数组');
  return { thought, action, problems, suggestions };
}

/** 守卫提取 chat/completions 响应中的 assistant 文本（rc-1，不用 as）。 */
export function extractAssistantContent(payload: unknown): string {
  const record = asRecord(payload);
  const choices = record?.['choices'];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('LLM 响应缺少 choices 数组');
  }
  const message = asRecord(asRecord(choices[0])?.['message']);
  const content = message?.['content'];
  if (typeof content !== 'string') {
    throw new Error('LLM 响应缺少 message.content 字符串');
  }
  return content;
}

export const AI_USER_SYSTEM_PROMPT = `你是「PD（Principles Disciple）」产品的模拟真实用户，正通过浏览器完成你的目标。你只根据当前页面可见内容行动，像真实用户一样：找不到入口、看不懂文案、无法恢复时，如实记入 problems。

每次回复必须只输出一个 JSON 对象（不要输出 JSON 以外的任何文字）：
{
  "thought": "当前想法（中文，一两句）",
  "action": {
    "type": "click|fill|press|navigate|wait|finish",
    "target": "选择器（click/fill 必填）",
    "value": "fill=输入文本；navigate=站内路径；press=键名；wait=毫秒",
    "success": true,
    "note": "finish 专用：一句话结论"
  },
  "problems": ["发现的体验问题（中文，没有则给空数组）"],
  "suggestions": ["改进建议（中文，没有则给空数组）"]
}
注意：success 是布尔值，仅 finish 动作需要；target/value 仅在动作说明中标注必填时提供。

可用动作：
- click：点击元素。target 推荐 role=button[name="按钮文字"] 或 text=文字 或 CSS 选择器。
- fill：向输入框填写。target 推荐 role=textbox[name="标签"]，value=要输入的文本。
- press：按键。value 如 Enter、Escape。
- navigate：站内跳转。value 必须以 / 开头，如 / 或 /governance。
- wait：等待页面变化。value=毫秒（最大 2000）。
- finish：结束。目标已达成 success=true；确定无法完成 success=false，并把卡点写进 problems。

规则：
- 一次只输出一个动作。
- 目标达成后立即 finish(success=true)，不要继续探索。
- 页面快照是可访问性树（YAML），元素的角色和名称可用来构造选择器：快照里的 "- link \"文字\"" 这一行，对应 target 应写成 "role=link[name=\"文字\"]"，按钮同理 "role=button[name=\"…\"]"。
- thought/problems/suggestions 一律使用中文。`;

export interface AiUserLlmClient {
  readonly config: AiUserLlmConfig;
  decide(userPrompt: string): Promise<AiUserDecision>;
}

/** 429（限频）需要更长退避；其余瞬时错误用基础退避。可单测的纯函数。 */
export function retryDelayFor(lastError: string, baseDelayMs: number): number {
  return /HTTP 429/.test(lastError) ? baseDelayMs * 4 : baseDelayMs;
}

export function createLlmClient(
  config: AiUserLlmConfig,
  opts?: { retryDelayMs?: number },
): AiUserLlmClient {
  const retryDelayMs = opts?.retryDelayMs ?? 5_000;

  async function chat(messages: { role: string; content: string }[]): Promise<string> {
    const endpoint = assertSafeLlmBaseUrl(config.baseUrl);
    endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/chat/completions';
    const resp = await fetch(endpoint.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: 0.2,
        max_tokens: 900,
      }),
      // 150s：免费/慢端点（如免费网关）单次大提示词调用可达分钟级
      signal: AbortSignal.timeout(150_000),
    });
    if (!resp.ok) {
      const body = bounded(await resp.text().catch(() => ''), 300);
      throw new Error(`LLM 请求失败 HTTP ${resp.status}: ${body}`);
    }
    return extractAssistantContent(await resp.json());
  }

  return {
    config,
    // 每类失败最多重试一次（rc-7：重试是全新请求，不复用陈旧响应）：
    // 网络错误 / 429 / 5xx → 退避后整请求重发；协议解析失败 → 附纠错反馈重问。
    async decide(userPrompt: string): Promise<AiUserDecision> {
      const messages: { role: string; content: string }[] = [
        { role: 'system', content: AI_USER_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ];
      let lastError = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        let content: string;
        try {
          content = await chat(messages);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt === 0) {
            await new Promise(resolvePromise => setTimeout(resolvePromise, retryDelayFor(lastError, retryDelayMs)));
          }
          continue;
        }
        try {
          return parseAiUserDecision(content);
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err);
          if (attempt === 0) {
            messages.push({
              role: 'user',
              content: `你的上一次回复不符合动作协议：${bounded(lastError, 300)}。请重新只输出一个符合协议的 JSON 对象。`,
            });
          }
        }
      }
      throw new Error(`AI User 决策失败（重试后仍无效）：${bounded(lastError, 300)}`);
    },
  };
}
