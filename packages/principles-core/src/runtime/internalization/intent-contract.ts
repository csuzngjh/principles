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

import { isCorePrincipleId } from '../core-principles/core-principle-registry.js';

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

const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ── IntentContract V2 (SPEC v1.2 §8.2, TECH v1.1 §7.2) ──────────────────────
//
// V2 is an ADDITIVE extension of V1: the five V1 fields keep their names,
// semantics and non-emptiness. V2 adds exactly three groups of information —
// the strategic intent REFERENCE (server-authored), the strategic ASSESSMENT
// (relevance + conflicts) and the Core Principle references actually used.
//
// Authority boundaries enforced here (SPEC §7.1 / §8.3):
//   - relevance is NEVER authored by the model or by a downstream stage. The
//     server derives it from Stage A's artifact (see deriveStrategicRelevance);
//   - `intentTension` (tension type) is NOT relevance, and `violatedPrinciples`
//     is NOT `corePrincipleRefs` — neither is ever copied into the other;
//   - a V2 that is missing `strategicAssessment` / `relevance` /
//     `conflictStatus` is a HARD failure, never a silent degradation to V1.

/** Strategic relevance — four explicit states (SPEC §7.1). */
export type StrategicRelevance = 'relevant' | 'not_applicable' | 'insufficient_evidence' | 'not_configured';

/** Overall conflict status (SPEC §7.2). */
export type StrategicConflictStatus = 'none' | 'potential' | 'confirmed';

/** The only section keys a contract may cite (SPEC §8.3). */
export type IntentContractSectionKey =
  | 'why'
  | 'desired_outcome'
  | 'non_negotiables'
  | 'stop_escalation'
  | 'current_strategic_focus';

export const STRATEGIC_RELEVANCE_VALUES: readonly StrategicRelevance[] = [
  'relevant',
  'not_applicable',
  'insufficient_evidence',
  'not_configured',
];

export const STRATEGIC_CONFLICT_STATUS_VALUES: readonly StrategicConflictStatus[] = ['none', 'potential', 'confirmed'];

export const INTENT_CONTRACT_SECTION_KEYS: readonly IntentContractSectionKey[] = [
  'why',
  'desired_outcome',
  'non_negotiables',
  'stop_escalation',
  'current_strategic_focus',
];

/** Reference to the exact Intent artifact this principle was judged against. */
export interface IntentContractStrategicIntent {
  /** Stage A server-captured hash — never a model-reported value. */
  readonly contentHash: string;
  /** The instant Stage A read the document. */
  readonly capturedAt: string;
  /** Present only when an existing intent version record could be linked. */
  readonly intentVersionId?: string;
  /** Only the five fixed INTENT.md section keys. */
  readonly relevantSections?: readonly IntentContractSectionKey[];
}

/** One conflict, self-locating in BOTH the anchor and the evidence. */
export interface IntentContractConflict {
  readonly against: 'core_principle' | 'owner_intent';
  readonly ref: string;
  readonly status: 'potential' | 'confirmed';
  readonly evidenceRefs: readonly string[];
}

export interface IntentContractStrategicAssessment {
  readonly relevance: StrategicRelevance;
  readonly rationale: string;
  readonly conflictStatus: StrategicConflictStatus;
  readonly conflicts?: readonly IntentContractConflict[];
}

export interface IntentContractV2 extends IntentContractV1 {
  readonly schemaVersion: 2;
  readonly strategicIntent?: IntentContractStrategicIntent;
  readonly strategicAssessment: IntentContractStrategicAssessment;
  /** Stable Core Principle ids that ACTUALLY participated (never violatedPrinciples). */
  readonly corePrincipleRefs?: readonly string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function includesValue<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function hasProtoKey(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => PROTO_KEYS.has(key));
}

function isValidStrategicIntentRef(value: unknown): value is IntentContractStrategicIntent {
  if (!isPlainObjectLike(value) || hasProtoKey(value)) return false;
  if (!isNonEmptyString(value.contentHash) || !isNonEmptyString(value.capturedAt)) return false;
  if (Object.hasOwn(value, 'intentVersionId') && value.intentVersionId !== undefined
    && !isNonEmptyString(value.intentVersionId)) return false;
  if (Object.hasOwn(value, 'relevantSections') && value.relevantSections !== undefined) {
    if (!Array.isArray(value.relevantSections)) return false;
    if (!value.relevantSections.every((section) => includesValue(INTENT_CONTRACT_SECTION_KEYS, section))) return false;
  }
  return true;
}

function isValidConflict(value: unknown): value is IntentContractConflict {
  if (!isPlainObjectLike(value) || hasProtoKey(value)) return false;
  if (value.against !== 'core_principle' && value.against !== 'owner_intent') return false;
  if (!isNonEmptyString(value.ref)) return false;
  if (value.status !== 'potential' && value.status !== 'confirmed') return false;
  if (!Array.isArray(value.evidenceRefs) || value.evidenceRefs.length === 0) return false;
  return value.evidenceRefs.every((ref) => isNonEmptyString(ref));
}

function isValidStrategicAssessment(value: unknown): value is IntentContractStrategicAssessment {
  if (!isPlainObjectLike(value) || hasProtoKey(value)) return false;
  if (!includesValue(STRATEGIC_RELEVANCE_VALUES, value.relevance)) return false;
  if (!includesValue(STRATEGIC_CONFLICT_STATUS_VALUES, value.conflictStatus)) return false;
  if (!isNonEmptyString(value.rationale)) return false;
  if (Object.hasOwn(value, 'conflicts') && value.conflicts !== undefined) {
    if (!Array.isArray(value.conflicts)) return false;
    if (!value.conflicts.every((conflict) => isValidConflict(conflict))) return false;
  }
  return true;
}

/**
 * Runtime guard for a COMPLETE IntentContractV2 (SPEC §8.2 completeness rules).
 *
 * Missing `schemaVersion` / `strategicAssessment` / `.relevance` /
 * `.conflictStatus` fails — never treated as "no strategic information".
 */
export function isValidIntentContractV2(value: unknown): value is IntentContractV2 {
  if (!isPlainObjectLike(value) || hasProtoKey(value)) return false;
  if (value.schemaVersion !== 2) return false;
  if (!isValidIntentContractV1(value)) return false;
  if (!Object.hasOwn(value, 'strategicAssessment') || !isValidStrategicAssessment(value.strategicAssessment)) {
    return false;
  }
  if (Object.hasOwn(value, 'strategicIntent') && value.strategicIntent !== undefined
    && !isValidStrategicIntentRef(value.strategicIntent)) return false;
  if (Object.hasOwn(value, 'corePrincipleRefs') && value.corePrincipleRefs !== undefined) {
    if (!Array.isArray(value.corePrincipleRefs)) return false;
    if (!value.corePrincipleRefs.every((id) => isNonEmptyString(id))) return false;
  }
  return true;
}

/**
 * Extract a validated V2 contract from an untrusted artifact. Returns null for
 * a V1 artifact (legitimate) and for a malformed V2 (callers decide whether
 * that is a hard failure at their own boundary).
 */
export function extractIntentContractV2(unknownArtifact: unknown): IntentContractV2 | null {
  if (!isPlainObjectLike(unknownArtifact) || !Object.hasOwn(unknownArtifact, 'intentContract')) return null;
  const candidate: unknown = unknownArtifact.intentContract;
  return isValidIntentContractV2(candidate) ? candidate : null;
}

// ── Server-side assembly (SPEC §7.1 / §8.3 producer table) ───────────────────

/**
 * Deterministic relevance derivation.
 *
 * Stage A owns the judgment; the server only DERIVES the four-state reading
 * from Stage A's artifact. It does not compare `intentTension.source` to the
 * relevance enum (SPEC §7.1 forbids collapsing the two enums) — it reads
 * whether Stage A actually grounded the judgment in INTENT sections.
 */
export function deriveStrategicRelevance(input: {
  readonly diagnosisAvailable: boolean;
  readonly hasStrategicIntentRef: boolean;
  readonly intentTension?: { readonly relatedIntentFields: readonly string[] };
}): StrategicRelevance {
  if (!input.diagnosisAvailable) return 'insufficient_evidence';
  if (!input.hasStrategicIntentRef) return 'not_configured';
  if (input.intentTension === undefined) return 'insufficient_evidence';
  return input.intentTension.relatedIntentFields.length > 0 ? 'relevant' : 'not_applicable';
}

const DERIVED_RATIONALE: Readonly<Record<Exclude<StrategicRelevance, 'relevant' | 'not_applicable'>, string>> = {
  not_configured: 'No owner strategic intent was configured (or the intent document was unreadable) when this formation was diagnosed; relevance is recorded as not_configured by the server.',
  insufficient_evidence: 'The strategic basis could not be established for this formation; relevance is recorded as insufficient_evidence instead of inventing a relation.',
};

/** Element-level parse of the model-authored conflict list (untrusted). */
function parseModelConflicts(strategicAssessment: unknown): { ok: true; conflicts: IntentContractConflict[] } | { ok: false; errors: string[] } {
  if (!isPlainObjectLike(strategicAssessment)) {
    return { ok: false, errors: ['intentContract.strategicAssessment must be an object when present'] };
  }
  if (!Object.hasOwn(strategicAssessment, 'conflicts') || strategicAssessment.conflicts === undefined) {
    return { ok: true, conflicts: [] };
  }
  if (!Array.isArray(strategicAssessment.conflicts)) {
    return { ok: false, errors: ['intentContract.strategicAssessment.conflicts must be an array'] };
  }
  const conflicts: IntentContractConflict[] = [];
  for (const [index, conflict] of strategicAssessment.conflicts.entries()) {
    if (!isValidConflict(conflict)) {
      return {
        ok: false,
        errors: [`intentContract.strategicAssessment.conflicts[${index}] must carry against/ref/status and non-empty evidenceRefs`],
      };
    }
    conflicts.push(conflict);
  }
  return { ok: true, conflicts };
}

function parseModelCorePrincipleRefs(contract: Record<string, unknown>): { ok: true; refs: string[]; errors: string[] } {
  if (!Object.hasOwn(contract, 'corePrincipleRefs') || contract.corePrincipleRefs === undefined) {
    return { ok: true, refs: [], errors: [] };
  }
  if (!Array.isArray(contract.corePrincipleRefs)) {
    return { ok: true, refs: [], errors: ['intentContract.corePrincipleRefs must be an array'] };
  }
  const refs: string[] = [];
  const errors: string[] = [];
  for (const ref of contract.corePrincipleRefs) {
    if (!isNonEmptyString(ref)) {
      errors.push('intentContract.corePrincipleRefs must contain non-empty ids');
      continue;
    }
    if (!isCorePrincipleId(ref)) {
      errors.push(`intentContract.corePrincipleRefs entry "${ref}" is not a resolvable Core Principle id`);
      continue;
    }
    refs.push(ref);
  }
  return { ok: true, refs, errors };
}

function maxConflictStatus(conflicts: readonly IntentContractConflict[]): StrategicConflictStatus {
  if (conflicts.some((conflict) => conflict.status === 'confirmed')) return 'confirmed';
  return conflicts.length > 0 ? 'potential' : 'none';
}

export interface AssembleIntentContractV2Input {
  /** The validated V1 anchor authored by the Scribe. */
  readonly base: IntentContractV1;
  /** False when no Stage A artifact was reachable for this formation. */
  readonly diagnosisAvailable: boolean;
  /** Stage A server-captured reference (from the formation evidence). */
  readonly strategicIntentRef?: IntentContractStrategicIntent;
  /** Stage A's own judgment, used verbatim as the rationale basis. */
  readonly intentTension?: { readonly relatedIntentFields: readonly string[]; readonly explanation: string | null };
  /** The Scribe output, read for model-authored conflicts / core principle refs only. */
  readonly modelContract?: unknown;
}

export type IntentContractV2Assembly =
  | { readonly ok: true; readonly contract: IntentContractV2; readonly overrides: readonly string[] }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Assemble the complete V2 contract on the server.
 *
 * The model NEVER decides `relevance` / `rationale` / `conflictStatus` /
 * `strategicIntent`; those are derived from Stage A's artifact here. The model
 * may only contribute `conflicts[]` (its own critique) and `corePrincipleRefs`
 * (which must resolve in the Core Principle registry). A differing model value
 * is recorded in `overrides` so the substitution is observable (rc-9).
 */
export function assembleIntentContractV2(input: AssembleIntentContractV2Input): IntentContractV2Assembly {
  const modelContract = isPlainObjectLike(input.modelContract) ? input.modelContract : {};
  const modelAssessment: unknown = Object.hasOwn(modelContract, 'strategicAssessment')
    ? modelContract.strategicAssessment
    : undefined;

  const parsedConflicts = modelAssessment === undefined
    ? { ok: true as const, conflicts: [] as IntentContractConflict[] }
    : parseModelConflicts(modelAssessment);
  if (!parsedConflicts.ok) return { ok: false, errors: parsedConflicts.errors };

  const parsedRefs = parseModelCorePrincipleRefs(modelContract);
  if (parsedRefs.errors.length > 0) return { ok: false, errors: parsedRefs.errors };

  const relevance = deriveStrategicRelevance({
    diagnosisAvailable: input.diagnosisAvailable,
    hasStrategicIntentRef: input.strategicIntentRef !== undefined,
    ...(input.intentTension !== undefined ? { intentTension: input.intentTension } : {}),
  });
  const rationale = relevance === 'relevant' || relevance === 'not_applicable'
    ? (input.intentTension?.explanation ?? DERIVED_RATIONALE.insufficient_evidence)
    : DERIVED_RATIONALE[relevance];
  const conflictStatus = maxConflictStatus(parsedConflicts.conflicts);

  const overrides: string[] = [];
  if (isPlainObjectLike(modelAssessment) && Object.hasOwn(modelAssessment, 'relevance')) {
    overrides.push('strategicAssessment.relevance');
  }
  if (isPlainObjectLike(modelAssessment) && Object.hasOwn(modelAssessment, 'conflictStatus')) {
    overrides.push('strategicAssessment.conflictStatus');
  }

  const relevantSections = (input.intentTension?.relatedIntentFields ?? [])
    .filter((section): section is IntentContractSectionKey => includesValue(INTENT_CONTRACT_SECTION_KEYS, section));

  const contract: IntentContractV2 = {
    ...input.base,
    schemaVersion: 2,
    ...(input.strategicIntentRef !== undefined
      ? {
          strategicIntent: {
            contentHash: input.strategicIntentRef.contentHash,
            capturedAt: input.strategicIntentRef.capturedAt,
            ...(input.strategicIntentRef.intentVersionId !== undefined
              ? { intentVersionId: input.strategicIntentRef.intentVersionId }
              : {}),
            ...(relevantSections.length > 0 ? { relevantSections } : {}),
          },
        }
      : {}),
    strategicAssessment: {
      relevance,
      rationale,
      conflictStatus,
      ...(parsedConflicts.conflicts.length > 0 ? { conflicts: parsedConflicts.conflicts } : {}),
    },
    corePrincipleRefs: parsedRefs.refs,
  };

  if (!isValidIntentContractV2(contract)) {
    return { ok: false, errors: ['assembled intentContract is not a complete IntentContractV2'] };
  }
  return { ok: true, contract, overrides };
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

interface ExtractedExecutionConditions {
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
