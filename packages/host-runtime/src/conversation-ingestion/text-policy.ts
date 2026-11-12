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
 * PRI-1179 wires the policy into production: the host resolves the tier from its
 * own consent record and passes it through `runConversationIngestion`, which
 * forwards `maxChars` to the store and the core `sanitizeString` bound.
 */

export type TextPolicy =
  | { tier: 'bounded'; maxChars: 200 }
  | { tier: 'full'; maxChars: 20_000 };

export const TEXT_POLICY_BOUNDED_MAX_CHARS = 200;
export const TEXT_POLICY_FULL_MAX_CHARS = 20_000;

/**
 * Order two disclosure version identifiers. Identifiers in the wild mix
 * alphabetic prefixes with numeric runs INSIDE one segment ('g2a-2026-08-28',
 * 'b2', 'b10'), so both a plain lexicographic compare ('b10' < 'b2') and a
 * separator-only split get numeric orderings wrong. This tokenizes each
 * identifier into digit and non-digit runs, comparing digit runs numerically
 * and the rest lexicographically — a stable total order for the version
 * families PD actually issues. A missing trailing token orders below a
 * present one ('b2' < 'b2.1').
 */
export function compareDisclosureVersions(a: string, b: string): number {
  const tokensA = a.match(/\d+|\D+/g) ?? [];
  const tokensB = b.match(/\d+|\D+/g) ?? [];
  const length = Math.max(tokensA.length, tokensB.length);
  for (let index = 0; index < length; index += 1) {
    const ta = tokensA[index] ?? '';
    const tb = tokensB[index] ?? '';
    const aIsNumeric = ta.length > 0 && /^\d+$/.test(ta);
    const bIsNumeric = tb.length > 0 && /^\d+$/.test(tb);
    if (aIsNumeric && bIsNumeric) {
      const na = Number(ta);
      const nb = Number(tb);
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (ta !== tb) {
      return ta < tb ? -1 : 1;
    }
  }
  return 0;
}

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
    && compareDisclosureVersions(consent.disclosureVersion, requiredDisclosureVersion) >= 0
  ) {
    return { tier: 'full', maxChars: TEXT_POLICY_FULL_MAX_CHARS };
  }
  return { tier: 'bounded', maxChars: TEXT_POLICY_BOUNDED_MAX_CHARS };
}
