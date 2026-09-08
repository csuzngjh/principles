/**
 * Intent Contract v1 (PRI-703 Phase 1, Owner decision 2026-09-07).
 *
 * Problem: the pipeline stages each re-interpret the principle's meaning from
 * prose (statement/rationale). Episode 001 (PRI-700) showed the repair loop
 * can deadlock when "what the Owner actually wants" has no structured carrier:
 * evaluator requiredChanges text induced rule outputs that contradicted the
 * principle's own context mode. Downstream stages (rule generation,
 * evaluation, repair) had no single authoritative statement of intent to check
 * against — "everyone plays from a different score".
 *
 * Solution: a lightweight structured intent contract carried on the scribe
 * principle draft (metadata extension of the EXISTING artifact — no second
 * state source, no new store, no new table). It is produced once by the
 * scribe, validated by the same hand-rolled runtime-contract style as
 * ScribeOutputV1, and deterministically forwarded to the stages that need an
 * anchor:
 *   - artificer prompt (rule generation must honor ownerIntent /
 *     forbiddenBehavior);
 *   - evaluator prompt (intentConsistency judging gets the explicit contract);
 *   - repair prompt (requiredChanges that contradict the contract are the
 *     evaluator's problem to re-derive, not the rule's to blindly satisfy).
 *
 * Compatibility: optional on the wire. Scribe outputs that predate this
 * contract simply lack the key; every consumer treats absence as
 * "contract unavailable" (best-effort degradation, observable via events —
 * rc-9) and behaves exactly as before. No migration, no flag.
 *
 * Adversarial-case scoping (Owner decision, factor A principle): an
 * evaluation case may only judge a principle/rule failure when it falls
 * INSIDE the intent contract's applicability. Cases that introduce new
 * behavioral requirements outside the contract are test-out-of-scope for
 * this principle revision (Phase 2 attribution consumes this).
 */

/**
 * The structured Owner-intent contract. All fields are non-empty strings so
 * the contract can never degrade into ceremonial prose with no information.
 */
export interface IntentContractV1 {
  /** What the Owner actually wants to prevent/achieve, in one sentence. */
  readonly ownerIntent: string;
  /** The observable behavior a compliant agent must exhibit. */
  readonly targetBehavior: string;
  /** The behavior this principle explicitly forbids (the failure family). */
  readonly forbiddenBehavior: string;
  /** Which real evidence (pain/diagnosis) this intent is distilled from. */
  readonly evidenceSource: string;
  /** What an evaluator should observe to accept a rule as faithful. */
  readonly validationExpectation: string;
}

/** Runtime-contract guard (rc-1/rc-2): untrusted LLM output must be validated field-by-field. */
export function isValidIntentContractV1(value: unknown): value is IntentContractV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const nonEmptyString = (key: string): boolean =>
    Object.hasOwn(record, key) && typeof record[key] === 'string' && (record[key]).trim() !== '';
  return nonEmptyString('ownerIntent')
    && nonEmptyString('targetBehavior')
    && nonEmptyString('forbiddenBehavior')
    && nonEmptyString('evidenceSource')
    && nonEmptyString('validationExpectation');
}

/**
 * Extract a validated IntentContractV1 from an untrusted scribe artifact
 * contentJson (unknown). Returns null when absent or malformed — callers
 * degrade best-effort (rc-9: emit an event, never a silent fallback).
 */
export function extractIntentContract(unknownArtifact: unknown): IntentContractV1 | null {
  if (typeof unknownArtifact !== 'object' || unknownArtifact === null || Array.isArray(unknownArtifact)) return null;
  const artifact = unknownArtifact as Record<string, unknown>;
  if (!Object.hasOwn(artifact, 'intentContract')) return null;
  const candidate = artifact.intentContract;
  return isValidIntentContractV1(candidate) ? candidate : null;
}
