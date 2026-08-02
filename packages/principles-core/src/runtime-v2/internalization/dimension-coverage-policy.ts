/**
 * Dreamer dimension coverage policy (design §6.5.1).
 *
 * The **single source of truth** for how the dreamer's five decision
 * dimensions map to fidelity-judgement coverage classes. Both Layer 1
 * (context-manifest well-formedness, INV-MANIFEST-CRITERION) and Layer 2 / PR 4
 * (the progressive evaluator's flagged criteria) read this table — neither
 * inlines a dimension-name array.
 *
 * rc-5 / ERR-013: dimension lookups must NOT use plain object indexing on an
 * untrusted string (`table['__proto__']` would hit `Object.prototype`). This
 * module only ever looks up dimensions it defines itself, so a typed record is
 * safe here — but consumers that look up an LLM-supplied string must guard with
 * `Object.hasOwn` or a `Map`.
 */

/** The five dimensions a dreamer candidate carries (design §6.1 dreamer fields). */
export type DreamerDimension =
  | 'badDecision'
  | 'betterDecision'
  | 'rationale'
  | 'riskLevel'
  | 'strategicPerspective';

/** How a dimension participates in compression-fidelity judgement. */
export type DimensionCoverageClass = 'required' | 'optional' | 'excluded';

/**
 * The coverage policy table (design §6.5.1).
 *
 *  required   normative content: must have a semantically-equivalent
 *             expression in the principle text; absence counts as a defect
 *             and enters `missingDimensions` + the flag path.
 *  optional   counted as covered when present in `antiPatterns`; absence is
 *             NOT a defect, only recorded in `optionalUncovered` for diagnosis.
 *             Never enters `missingDimensions` and never flags.
 *  excluded   an evaluation-lens label, not normative content; the criteria
 *             must NOT draw a conclusion about it, and it is never injected
 *             into the adjudicating manifest (§6.6.1).
 */
export const DIMENSION_COVERAGE_POLICY: Readonly<Record<DreamerDimension, DimensionCoverageClass>> = {
  betterDecision: 'required',
  rationale: 'required',
  riskLevel: 'required',
  badDecision: 'optional',
  strategicPerspective: 'excluded',
} as const;

/**
 * The required dimensions, derived from the policy table (order stable for
 * deterministic output). Consumers read this instead of inlining a string
 * array.
 */
export const REQUIRED_FIDELITY_DIMENSIONS: readonly DreamerDimension[] = (
  Object.entries(DIMENSION_COVERAGE_POLICY) as Array<[DreamerDimension, DimensionCoverageClass]>
)
  .filter(([, cls]) => cls === 'required')
  .map(([dim]) => dim);

/** All five dimension names (order stable). */
export const ALL_DREAMER_DIMENSIONS: readonly DreamerDimension[] = [
  'badDecision',
  'betterDecision',
  'rationale',
  'riskLevel',
  'strategicPerspective',
];

/**
 * rc-5-safe policy lookup for an untrusted (LLM-supplied) string. Returns the
 * class only when `dim` is genuinely one of the five declared dimensions;
 * `undefined` otherwise (so callers can ignore unknown / optional / excluded
 * values the model may have stuffed into `missingDimensions`).
 */
export function lookupDimensionPolicy(dim: string): DimensionCoverageClass | undefined {
  if (!Object.hasOwn(DIMENSION_COVERAGE_POLICY, dim)) return undefined;
  return DIMENSION_COVERAGE_POLICY[dim as DreamerDimension];
}

/**
 * True iff `dim` is a required dimension (used by the flagged-criteria filter,
 * §6.5.3). Accepts an untrusted string.
 */
export function isRequiredDimension(dim: string): boolean {
  return lookupDimensionPolicy(dim) === 'required';
}
