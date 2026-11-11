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
 * - the remaining hook budget cannot cover the request's own MINIMUM executable
 *   envelope (see `minExecutableBudgetMs`) — a fast Decisions request that can
 *   still finish is never skipped just because it is under an old slow-path
 *   line;
 * - the prompt is a pure social acknowledgement ("谢谢", "收到", "ok").
 *
 * Everything else — including short instructions, approvals and task
 * continuations — keeps the fast single-send selection. "Simple" is decided by
 * the acknowledgement vocabulary below, never by length alone: "继续", "执行一下"
 * and "确认" look short but can approve or advance a stage.
 */

export const ADAPTIVE_SKIP_LIMITS = {
  /**
   * Smallest remaining budget worth one Decisions send.
   *
   * PRI-1181 used the measured slow-path time-to-first-byte (789–1426 ms) as a
   * 1500 ms admission line. That line skipped requests that were executable:
   * the Decisions endpoint answers a small answer table well inside a
   * sub-second window, and a skip is permanent for the turn.
   *
   * The gate is now the request's own floor — the output reserve plus one
   * bounded round trip — not the slow path's observed maximum. The deadline
   * machinery still cancels an answer that does not arrive.
   */
  minExecutableBudgetMs: 300,
  /** Longest acknowledgement (after normalization) still treated as pure social. */
  maxConfirmationChars: 12,
} as const;

/**
 * Acknowledgements, longest first so the greedy removal below never leaves a
 * fragment behind ("明白了" must be consumed before "明白").
 *
 * Scope is deliberately PURE SOCIAL: gratitude and receipt-of-message only.
 * Approval words that can answer a pending question are excluded — "确认",
 * "可以", "好的", "行", "ok", "yes" must all reach the decision endpoint,
 * because "要不要提交最终版？→ 确认" is a real stage change, not social noise.
 */
const ACKNOWLEDGEMENTS = [
  'thankyouverymuch',
  'thanksalot',
  'thankyou',
  '明白了',
  '收到啦',
  '辛苦了',
  '谢谢',
  '多谢',
  '感谢',
  '收到',
  '明白',
  '了解',
  '嗯嗯',
  'thanks',
  'thank',
  'gotit',
  '嗯',
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
  readonly minExecutableBudgetMs?: number | undefined;
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
  const minimum = input.minExecutableBudgetMs ?? ADAPTIVE_SKIP_LIMITS.minExecutableBudgetMs;
  if (input.remainingBudgetMs !== undefined && input.remainingBudgetMs < minimum) {
    return {skip: true, reason: 'budget_insufficient'};
  }
  if (isTrivialConfirmation(input.prompt)) return {skip: true, reason: 'trivial_confirmation'};
  return {skip: false};
}
