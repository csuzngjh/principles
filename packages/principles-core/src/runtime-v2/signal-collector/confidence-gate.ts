import type { LlmClassificationResult } from './types.js';

/**
 * SPEC v0.3 §3.3 / §4.4 P-3 置信度门。
 *
 * Stage 2 的原始输出（含 confidence）必须先经过这里，才允许变成终态或准入：
 * - CORRECTION 且 confidence ≥ θ_confirm → correction（进入 Pain Admission）；
 * - NONE 且 confidence ≥ θ_none → none（终态 resolved_none）；
 * - 低置信度 → pending_low_confidence（attempts+1 后回 pending，绝不伪装终态）；
 * - LLM 超时/异常/无结果 → pending_llm_error（绝不记为 NONE）。
 */
export const STAGE2_CONFIRM_THRESHOLD = 0.7;
export const STAGE2_NONE_THRESHOLD = 0.7;
export const STAGE2_MAX_ATTEMPTS = 5;
export const PENDING_CANDIDATE_TTL_MS = 72 * 60 * 60 * 1000;

export type Stage2GateVerdict =
  | 'correction'
  | 'none'
  | 'pending_low_confidence'
  | 'pending_llm_error';

export interface Stage2GateResult {
  verdict: Stage2GateVerdict;
  reason: string;
  confidence: number | null;
}

export interface Stage2Thresholds {
  readonly confirm: number;
  readonly none: number;
}

const DEFAULT_THRESHOLDS: Stage2Thresholds = {
  confirm: STAGE2_CONFIRM_THRESHOLD,
  none: STAGE2_NONE_THRESHOLD,
};

/**
 * Pure gate over a validated Stage 2 result. `null` means the classifier
 * produced no verdict (timeout, exception, unusable payload) — that is an
 * error path, never a negative conclusion.
 */
export function evaluateStage2ConfidenceGate(
  result: LlmClassificationResult | null,
  thresholds: Stage2Thresholds = DEFAULT_THRESHOLDS,
): Stage2GateResult {
  if (result === null) {
    return { verdict: 'pending_llm_error', reason: 'classifier returned no usable verdict', confidence: null };
  }

  const { confidence } = result;
  if (result.type === 'correction' && result.is_feedback) {
    return confidence >= thresholds.confirm
      ? { verdict: 'correction', reason: result.reason, confidence }
      : { verdict: 'pending_low_confidence', reason: result.reason, confidence };
  }

  // `none`（以及 is_feedback=false 的伪 correction）只有在达到否定阈值时
  // 才允许成为终态；低置信度的否定只是不确定性。
  return confidence >= thresholds.none
    ? { verdict: 'none', reason: result.reason, confidence }
    : { verdict: 'pending_low_confidence', reason: result.reason, confidence };
}
