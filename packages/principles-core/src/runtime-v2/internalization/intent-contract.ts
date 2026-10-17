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

// ── SPEC-RULECODE-QUALITY-001 A1: machine-readable execution conditions ─────
//
// The intent contract carries the Owner-intent ANCHOR in prose; deterministic
// code cannot read prose to learn "this principle depends on an external
// trusted fact (e.g. a design approval) the runtime input will never carry".
// ScribeExecutionConditionsV1 closes exactly that gap: the scribe (a
// delegated semantic judgment, actor recorded downstream — never an Owner
// decision) distills WHICH trusted facts the principle's enforcement depends
// on, each with the textual basis it was read from. The artificer intent
// preflight then verifies those facts against a host trusted-facts port
// BEFORE any generation call — the generator alone can never decide that its
// own principle is exempt (Q20).
//
// Wire shape: optional sibling of `intentContract` on the scribe artifact,
// versioned, additive (present-but-malformed is a hard rejection at the
// scribe validator; at extraction it returns null and the preflight treats
// presence-with-null as corrupted, not absent).

/** A trusted external fact the principle's enforcement depends on. */
export interface ScribeRequiredFactV1 {
  /**
   * Closed operational vocabulary is enforced at the scribe prompt level;
   * the wire accepts any non-empty string so an unknown kind surfaces as
   * `trusted_fact_provider_absent`/`unknown` honestly instead of being
   * silently dropped.
   */
  readonly factKind: string;
  /** true = generation depends on this fact being resolvable through the trusted-facts port. */
  readonly required: boolean;
  /** The Owner-attributed text this requirement was read from (never invented). */
  readonly textualBasis: string;
}

export interface ScribeExecutionConditionsV1 {
  readonly version: 1;
  readonly requiredFacts: readonly ScribeRequiredFactV1[];
}

const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime-contract guard (rc-1/rc-2/rc-5): untrusted scribe output validated field-by-field. */
export function isValidScribeExecutionConditionsV1(value: unknown): value is ScribeExecutionConditionsV1 {
  if (!isPlainObjectLike(value)) return false;
  if (Object.keys(value).some((key) => PROTO_KEYS.has(key))) return false;
  if (value.version !== 1) return false;
  if (!Array.isArray(value.requiredFacts)) return false;
  for (const fact of value.requiredFacts) {
    if (!isPlainObjectLike(fact)) return false;
    if (Object.keys(fact).some((key) => PROTO_KEYS.has(key))) return false;
    if (typeof fact.factKind !== 'string' || fact.factKind.trim() === '') return false;
    if (typeof fact.required !== 'boolean') return false;
    if (typeof fact.textualBasis !== 'string' || fact.textualBasis.trim() === '') return false;
  }
  return true;
}

export interface ExtractedExecutionConditions {
  readonly conditions: ScribeExecutionConditionsV1 | null;
  /** true = the artifact carries the key but it failed validation (corrupted, not legacy-absent). */
  readonly corrupted: boolean;
}

/**
 * Extract validated ScribeExecutionConditionsV1 from an untrusted scribe
 * artifact. Distinguishes legacy-absent from corrupted so the preflight can
 * fail loud on corruption and label absence as unverified-legacy.
 */
export function extractExecutionConditions(unknownArtifact: unknown): ExtractedExecutionConditions {
  if (!isPlainObjectLike(unknownArtifact) || !Object.hasOwn(unknownArtifact, 'executionConditions')) {
    return { conditions: null, corrupted: false };
  }
  const candidate: unknown = unknownArtifact.executionConditions;
  return isValidScribeExecutionConditionsV1(candidate)
    ? { conditions: candidate, corrupted: false }
    : { conditions: null, corrupted: true };
}
