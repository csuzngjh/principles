/**
 * Enum Labels — Global enum-to-human-label mapping with i18n fallback.
 *
 * Wave 1 of console UX rebuild: eliminates raw enum values (e.g.
 * "internalization-succeeded", "code_tool_hook", "gone") from the
 * Owner-facing UI by providing a centralized label resolver with
 * three-tier fallback: i18n → local map → raw value.
 *
 * Root cause being fixed: PainPage's `tFallback(t, 'pages.pain.state_${record.state}', ...)`
 * generated keys with hyphens (e.g. `state_evidence-only`) that never matched the
 * i18n keys with underscores (e.g. `state_evidence_only`), so the fallback to the
 * raw enum value was always taken — exposing machine words like
 * "internalization-succeeded" to the Owner.
 *
 * Design constraints:
 * - Pure logic, no I/O (ERR-001/ERR-005: no `as` bypasses on untrusted data)
 * - Category-keyed to avoid cross-enum collisions
 * - i18n key convention: `common.enums.<category>.<snake_value>`
 * - Local map keyed by the RAW value (with hyphens) for exact lookup
 */

import { IS_DEV } from "./runtime-mode.js";

// Type for the translation function (compatible with react-i18next's t)
type TFunc = (key: string) => string;

// ── Categories ───────────────────────────────────────────────────────────────

export type EnumCategory =
  | 'evidenceState'
  | 'sourceKind'
  | 'channel'
  | 'readiness'
  | 'featureCategory'
  | 'featureId'
  | 'confidence'
  | 'feedbackType'
  | 'admission'
  | 'evaluability'
  | 'approvalReadiness';

// ── Local fallback maps ──────────────────────────────────────────────────────
// Used when the i18n key `common.enums.<category>.<snake_value>` is missing.
// Keys are the RAW enum values (with hyphens) for O(1) exact lookup.

const LOCAL_LABELS: Record<EnumCategory, Record<string, string>> = {
  evidenceState: {
    'evidence-only': '仅观察',
    'recorded-only': '已记录信号',
    'diagnosis-queued': '诊断排队中',
    'diagnosis-running': '诊断运行中',
    'diagnosis-succeeded': '诊断完成',
    'diagnosis-failed': '诊断失败',
    'diagnosis-retry-wait': '等待重试',
    'candidate-generated': '已生成候选',
    'internalization-missing': '内化缺失',
    'internalization-pending': '内化待处理',
    'internalization-running': '内化运行中',
    'internalization-succeeded': '内化完成',
    'internalization-failed': '内化失败',
    'owner-reviewable': '待审查',
    'malformed': '数据异常',
    'degraded': '降级',
  },
  sourceKind: {
    'manual': '手动触发',
    'tool_call': '工具调用',
    'rulehost': '规则守卫',
    'empathy_inferred': '共情推断',
    'review': '审查发现',
    'unknown': '未知来源',
    // P1-1: automatic correction detection stores `source: 'user_correction'`.
    // Without this label the Owner saw "状态待确认" instead of the real source.
    'user_correction': '用户纠正',
    // SPEC-PD-AGENT-PAIN-INGRESS-001 v0.8 §6.6.4: neutral label so the raw
    // `mcp_agent_assisted` enum never reaches the Owner.
    'mcp_agent_assisted': '智能体辅助提交',
  },
  channel: {
    'prompt': '提示词 / 可撤销',
    'defer_archive': '延迟归档',
    'code_tool_hook': 'Code Tool Hook',
    'skill': '技能激活（已停用）',
  },
  readiness: {
    'ready': '就绪',
    'needs_setup': '待配置',
    'disabled': '已停用',
    'not_ready': '未就绪',
    'unknown': '未知',
  },
  featureCategory: {
    'core': '核心启用',
    'quiet': '默认关闭',
    'gone': '已归档（不再激活）',
    'legacy_retire': '待退役',
  },
  featureId: {
    'prompt': '提示词注入',
    'code_tool_hook': '代码工具钩子',
    'defer_archive': '延迟归档',
    'correction_observer': '纠正观察器',
    'internalization_auto_consumer': '内化自动消费器',
    'feedback_channel': '反馈通道',
    'evolution_worker': '进化工作器',
    'diagnostician_async_cli': '诊断器异步 CLI',
    'diagnostician_core_grounding': '诊断器核心锚定',
    'internalization_core_grounding': '内化核心锚定',
    'diagnostician_split_pipeline': '诊断器分流管线',
    'l2_dreamer': 'L2 Dreamer 循环',
  },
  confidence: {
    'high': '高',
    'medium': '中',
    'low': '低',
  },
  feedbackType: {
    'bug': '缺陷',
    'confusing': '体验困惑',
    'privacy_concern': '隐私问题',
    'feature_request': '功能请求',
    'other': '其他',
  },
  admission: {
    'store_signal': '已录入信号',
    'evidence_only': '仅作证据',
    'owner_confirmation_required': '待确认',
  },
  // Owner Decision Experience v1 (T10): evaluability is NOT confidence — it
  // describes how the principle's adherence can be evaluated, and must never
  // be displayed as a confidence score.
  evaluability: {
    'deterministic': '可确定性检查',
    'weak_heuristic': '弱启发式',
    'manual_only': '仅人工',
  },
  // ── SPEC-PD-UIUX-002 Stage 1 (1A 语言层收口) ───────────────────────────────
  // Promotion readiness is rendered raw on the activation page (validated union:
  // ready | evidence_insufficient | blocked | unavailable).
  approvalReadiness: {
    'ready': '可以推进',
    'evidence_insufficient': '证据不足',
    'blocked': '存在阻断项',
    'unavailable': '暂时无法判定',
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a raw enum value to snake_case for i18n key lookup.
 * e.g. "evidence-only" → "evidence_only"
 *      "code_tool_hook" → "code_tool_hook" (already snake)
 *      "internalization-succeeded" → "internalization_succeeded"
 */
function toSnakeCase(value: string): string {
  return value.replace(/-/g, '_').toLowerCase();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Neutral label used when an enum value has no mapping.
 *
 * SPEC-PD-UIUX-002 §4.1: returning the RAW value is what leaked
 * `internalization-missing` / `needs_human_review` into the Owner-facing UI.
 * Unknown values must never reach the screen; they degrade to a neutral,
 * honest phrase and are reported once in development.
 */
export const UNKNOWN_ENUM_LABEL = '状态待确认';

/** Report a missing label once per (category, value) — noisy logs hide the signal. */
const reportedMissing = new Set<string>();

/**
 * Resolve an enum value to a human-readable label.
 *
 * Resolution order:
 * 1. i18n key `common.enums.<category>.<snake_value>` (if the t function
 *    returns something other than the key itself)
 * 2. Local fallback map `LOCAL_LABELS[category][rawValue]`
 * 3. Neutral fallback (`UNKNOWN_ENUM_LABEL`) — NEVER the raw value
 *
 * @param category - The enum category (e.g. 'evidenceState', 'channel')
 * @param value - The raw enum value (e.g. 'internalization-succeeded')
 * @param t - i18n translation function (from useTranslation). Optional;
 *            if omitted, skips straight to the local map.
 * @param fallback - Optional context-specific neutral label
 * @returns Human-readable label
 *
 * @example
 * // In a React component:
 * const { t } = useTranslation();
 * const stateLabel = enumLabel('evidenceState', record.state, t);
 * // → "内化完成" (for 'internalization-succeeded')
 */
export function enumLabel(
  category: EnumCategory,
  value: string,
  t?: TFunc,
): string {
  // 1. Try i18n first
  if (t) {
    const snakeValue = toSnakeCase(value);
    const i18nKey = `common.enums.${category}.${snakeValue}`;
    const result = t(i18nKey);
    if (result !== i18nKey) {
      return result;
    }
  }

  // 2. Fall back to local map
  const localMap = LOCAL_LABELS[category];
  if (localMap && Object.hasOwn(localMap, value)) {
    const label = localMap[value];
    if (label !== undefined) {
      return label;
    }
  }

  // 3. Neutral fallback — the raw value must never reach the screen (1A).
  if (IS_DEV) {
    const reportKey = `${category}:${value}`;
    if (!reportedMissing.has(reportKey)) {
      reportedMissing.add(reportKey);
      console.warn(`[enum-labels] missing label for ${reportKey} — add it to LOCAL_LABELS.${category}`);
    }
  }
  return UNKNOWN_ENUM_LABEL;
}

/**
 * Check whether a local label exists for the given category + value.
 * Useful for conditional rendering (e.g. only show a badge if we can label it).
 */
export function hasEnumLabel(category: EnumCategory, value: string): boolean {
  const localMap = LOCAL_LABELS[category];
  return !!localMap && Object.hasOwn(localMap, value);
}
