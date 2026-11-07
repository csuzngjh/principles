import type { RecommendationKind } from '../../diagnostician-output.js';

export const VALID_RECOMMENDATION_KINDS: ReadonlySet<string> = new Set([
  'principle',
  'rule',
  'implementation',
  'prompt',
  'defer',
]);

/**
 * Normalize a persisted `recommendation_kind` for READ / display purposes.
 *
 * ⚠️ FAIL-OPEN BY DESIGN (legacy compatibility): any missing, unknown, invalid,
 * or non-string value collapses to `'principle'`.
 *
 * This function must NEVER be used to decide whether a candidate may write the
 * Principle Ledger — its fail-open default is exactly the "unknown → principle"
 * amplification documented in `docs/specs/principle-purification.md` (RC-4).
 * Use {@link isPrincipleLedgerEligibleKind} at any write boundary instead.
 */
export function resolveRecommendationKind(raw: unknown): RecommendationKind {
  if (typeof raw === 'string' && VALID_RECOMMENDATION_KINDS.has(raw)) {
    return raw as RecommendationKind;
  }
  return 'principle';
}

/** The single recommendation kind permitted to write the Principle Ledger. */
export const PRINCIPLE_LEDGER_KIND = 'principle' as const;

/**
 * Strict, FAIL-CLOSED validation of a raw `recommendation_kind` value.
 *
 * Unlike {@link resolveRecommendationKind} this never guesses: it returns the
 * kind only when the value is exactly one of {@link VALID_RECOMMENDATION_KINDS},
 * and `null` for everything else (`null` / `undefined` / `42` / `{}` / `[]` /
 * `''` / `'PRINCIPLE'` / `'unknown_xyz'` / `'skill'`).
 *
 * This is the validator the Principle Ledger write boundary is built on
 * (Phase 1 / PR1, SPEC §5.1 "Raw Kind Provenance Validation").
 */
export function validateRecommendationKind(raw: unknown): RecommendationKind | null {
  if (typeof raw === 'string' && VALID_RECOMMENDATION_KINDS.has(raw)) {
    return raw as RecommendationKind;
  }
  return null;
}

/**
 * Principle Ledger write-boundary predicate (Phase 1 / PR1).
 *
 * The ledger accepts ONLY an exactly-validated `recommendation_kind ===
 * 'principle'`. Everything else — including every form of unknown / missing /
 * invalid value — is refused (FAIL CLOSED), so no malformed kind can be
 * silently promoted into a principle.
 *
 * Equivalent to the routing form
 * `CANDIDATE_KIND_TO_ROUTE[kind] === 'principle-ledger'`; the two are pinned
 * together by `__tests__/recommendation-kind-resolver.test.ts` so they cannot
 * drift without a red test.
 */
export function isPrincipleLedgerEligibleKind(raw: unknown): boolean {
  return validateRecommendationKind(raw) === PRINCIPLE_LEDGER_KIND;
}
