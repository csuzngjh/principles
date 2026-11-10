/**
 * Rule Host Result Normalizer — the ONE place that turns untrusted rule output
 * into a decision a consumer may act on (B1).
 *
 * PROBLEM IT REMOVES:
 *   The same illegal RuleHostResult used to get three different treatments:
 *   the OpenClaw legacy path threw, the shared production gate logged a
 *   warning and dropped the rule. In the second case another rule's `allow`
 *   could win the merge, so a rule that meant to block silently did not exist
 *   any more. "The result is unusable" is one fact; it must have one meaning.
 *
 * CONTRACT:
 *   - valid result            → returned unchanged (identity preserved: the
 *                               merge attributes a winning rule by reference);
 *   - `matched=false`         → `decision='allow'` is enforced by
 *                               validateRuleHostResult (PRI-439) and is NOT
 *                               re-derived here — one authority, one place;
 *   - unusable result         → fail-closed `requireApproval` marked with
 *                               `degraded.reasonCode='invalid_result'`.
 *
 *   `decision` remains the only verdict field. Nothing else is added.
 */

import type { RuleHostResult } from './rule-host-contracts.js';
import { validateRuleHostResult } from './rule-host-validator.js';

function isValidRuleHostResult(value: unknown): value is RuleHostResult {
  return validateRuleHostResult(value).valid;
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize one raw implementation result.
 *
 * Fail-closed on unusable output: a rule whose result cannot be read must not
 * become an invisible `allow`. `matched` is set so the merge treats the
 * degradation as an opinion instead of dropping it; `degraded` marks it as
 * synthesized so telemetry does not report it as the rule's own decision.
 */
export function normalizeRuleHostResult(raw: unknown): RuleHostResult {
  if (isValidRuleHostResult(raw)) {
    return raw;
  }

  // Contradictory but unambiguous: the rule said "I did not match". A decision
  // field that disagrees (block/requireApproval/auto_correct) carries no
  // trustworthy intent, so the matched=false meaning wins — this is the single
  // place the PRI-439 cross-field rule ("matched=false means allow") is applied.
  if (isRecordLike(raw) && Object.hasOwn(raw, 'matched') && raw.matched === false) {
    return {
      decision: 'allow',
      matched: false,
      reason: typeof raw.reason === 'string' ? raw.reason : 'not matched',
    };
  }

  const notes = validateRuleHostResult(raw).errors.join('; ');
  return {
    decision: 'requireApproval',
    matched: true,
    reason: `invalid RuleHostResult: ${notes}`,
    degraded: { reasonCode: 'invalid_result', notes },
  };
}
