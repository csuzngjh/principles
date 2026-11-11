/**
 * Consent-tiered text policy for conversation ingestion (PRI-1171; SPEC v0.2
 * §4.2 / §8.1).
 *
 * The stored `visible_text` bound follows the CONSENT TIER, not a global
 * constant:
 *
 *   bounded — the pre-unification behavior and the default: 200 chars + the
 *             15-char `___TRUNCATED___` suffix applied by the core evidence
 *             sanitizer (the longest stored value today is 215).
 *   full    — reachable ONLY when the recorded consent is `granted` AND its
 *             `disclosureVersion` is at least the CURRENT disclosure version
 *             (an old bounded-era grant never silently widens). Hard cap
 *             20,000 chars against malformed giant records; the observed
 *             truncation rate is reported at acceptance time.
 *
 * P1 ships this resolver with the seam; the sanitizer-side application of the
 * full bound (core `sanitizeString` maxChars parameter) lands with the P3
 * depth-alignment batch, so in P1 every tier resolves through the unchanged
 * bounded storage path.
 */

export type TextPolicy =
  | { tier: 'bounded'; maxChars: 200 }
  | { tier: 'full'; maxChars: 20_000 };

export const TEXT_POLICY_BOUNDED_MAX_CHARS = 200;
export const TEXT_POLICY_FULL_MAX_CHARS = 20_000;

/**
 * Resolve the text tier for one host's consent record. `requiredDisclosureVersion`
 * is the disclosure the caller's CURRENT flow presents (the version whose text
 * the Owner actually saw); a record granted against an older disclosure stays
 * bounded until a new-disclosure record exists.
 */
export function resolveTextPolicy(
  consent: { decision: string; disclosureVersion: string | null },
  requiredDisclosureVersion: string,
): TextPolicy {
  if (
    consent.decision === 'granted'
    && consent.disclosureVersion !== null
    && consent.disclosureVersion >= requiredDisclosureVersion
  ) {
    return { tier: 'full', maxChars: TEXT_POLICY_FULL_MAX_CHARS };
  }
  return { tier: 'bounded', maxChars: TEXT_POLICY_BOUNDED_MAX_CHARS };
}
