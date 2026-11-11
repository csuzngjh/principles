/**
 * Adaptive Activation — deterministic pre-selection gate (PRI-1181).
 *
 * This gate runs BEFORE any candidate read and before any transport send.
 * Its job is to spend ZERO model calls when the turn provably cannot benefit
 * from a selection:
 *
 * - the Adaptive switch is off — enforced at construction time by
 *   `resolveAdaptiveSelectionModel`, so the provider is never created and no
 *   read/send happens (this module therefore has no "disabled" branch: a
 *   second check would be a second source of truth for the same switch);
 * - the host did not bind the current turn (`sessionId`/`turnId`) or the
 *   prompt body is blank;
 * - the remaining hook budget cannot cover even the slowest first byte ever
 *   observed on this path (see `minRemainingBudgetMs`);
 * - the prompt is a pure social acknowledgement ("好的", "谢谢", "ok").
 *
 * Everything else — including short instructions and task continuations —
 * keeps the existing fast single-send selection. "Simple" is decided by the
 * acknowledgement vocabulary below, never by length alone: "继续" and
 * "执行一下" look short but can carry a stage change.
 */

export const ADAPTIVE_SKIP_LIMITS = {
  /**
   * Measured on this path (PRI-1170 v0.3, Codex exec, 2026-11): time-to-first-
   * byte was 789 / 868 / 1426 ms. Below 1500 ms remaining, no answer has ever
   * started; spending the send would only collide with the Native reserve.
   * This is a gate, not a tuning knob for failing cases — the default runtime
   * budget is 4200 ms, so the normal path is unaffected.
   */
  minRemainingBudgetMs: 1500,
  /** Longest acknowledgement (after normalization) still treated as pure social. */
  maxConfirmationChars: 12,
} as const;

/**
 * Acknowledgements, longest first so the greedy removal below never leaves a
 * fragment behind ("明白了" must be consumed before "明白").
 * Deliberately excludes continuations such as 继续 / 开始 / 执行 / 再来.
 */
const ACKNOWLEDGEMENTS = [
  'thankyouverymuch',
  'thanksalot',
  'soundsgood',
  'thankyou',
  'gotit',
  '好的好的',
  '明白了',
  '收到啦',
  '辛苦了',
  '没问题',
  '好的',
  '好嘞',
  '谢谢',
  '多谢',
  '收到',
  '明白',
  '可以',
  '确认',
  '了解',
  '嗯嗯',
  'okay',
  'thanks',
  'thank',
  'yep',
  'yes',
  'ok',
  '嗯',
  '好',
  '行',
] as const;

/** Strip whitespace, punctuation and emoji-ish separators before matching. */
function normalize(prompt: string): string {
  return prompt
    .toLowerCase()
    .replace(/[\s，。！？、,.!?~～…:：;；"'“”‘’()（）[\]【】{}<>《》/\\|+*=_-]+/g, '');
}

/**
 * True only when the WHOLE normalized prompt is one or more acknowledgements.
 * Removal is greedy on the longest token first, so a substantive sentence that
 * merely contains an acknowledgement ("可以帮我修复这个 bug 吗") never matches.
 */
export function isTrivialConfirmation(prompt: string): boolean {
  let rest = normalize(prompt);
  if (rest.length === 0) return true;
  if (rest.length > ADAPTIVE_SKIP_LIMITS.maxConfirmationChars) return false;
  for (const token of ACKNOWLEDGEMENTS) {
    if (rest.includes(token)) rest = rest.split(token).join('');
    if (rest.length === 0) return true;
  }
  return rest.length === 0;
}

export type AdaptiveSkipReason =
  | 'missing_identity'
  | 'empty_prompt'
  | 'budget_insufficient'
  | 'trivial_confirmation';

export interface AdaptiveSkipInput {
  readonly kind: string;
  readonly sessionId?: string | undefined;
  readonly turnId?: string | undefined;
  readonly prompt: string;
  /** Undefined = no outer host deadline (direct/lab calls): never budget-skip. */
  readonly remainingBudgetMs?: number | undefined;
  readonly minRemainingBudgetMs?: number | undefined;
}

export type AdaptiveSkipDecision =
  | {readonly skip: false}
  | {readonly skip: true; readonly reason: AdaptiveSkipReason};

/**
 * Deterministic and ordered: identity first (it also proves lineage, rc-6),
 * then the prompt itself, then the time budget, then the social check.
 */
export function decideAdaptiveSkip(input: AdaptiveSkipInput): AdaptiveSkipDecision {
  if (input.kind !== 'before_prompt_build') return {skip: true, reason: 'missing_identity'};
  if (!input.sessionId || !input.turnId) return {skip: true, reason: 'missing_identity'};
  if (!input.prompt.trim()) return {skip: true, reason: 'empty_prompt'};
  const minimum = input.minRemainingBudgetMs ?? ADAPTIVE_SKIP_LIMITS.minRemainingBudgetMs;
  if (input.remainingBudgetMs !== undefined && input.remainingBudgetMs < minimum) {
    return {skip: true, reason: 'budget_insufficient'};
  }
  if (isTrivialConfirmation(input.prompt)) return {skip: true, reason: 'trivial_confirmation'};
  return {skip: false};
}
