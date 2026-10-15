/**
 * PRI-981 (SPEC-PD-IAER-001 FR-01) — Evidence Readiness Gate (evidence-readiness.ts)
 *
 * Shared, side-effect-free judgment of whether an Artificer V2 execution has
 * the Owner-labelled evidence it requires. Pure logic: this module imports
 * node:crypto for the evidence content hash only (intent-hash.ts precedent)
 * and performs NO I/O — the caller injects the assembly step.
 *
 * One judgment authority, one validator: the pack check REUSES
 * `validateBehaviorExamplePack` (behavior-example-pack.ts) — this module must
 * never grow a second, divergent pack validation.
 *
 * Err-prevention / contract IDs:
 *   - ERR-069: an invalid pack fails the attempt LOUD — the gate reports
 *     `invalid_evidence`, it never silently fabricates or drops evidence.
 *   - rc-1/rc-2: the Owner selection and assembled pack are treated as
 *     untrusted — structural guards only, no `as` bypass.
 *   - rc-3: required selection fields fail explicitly (missingFields /
 *     structured reason), never skipped silently.
 *   - rc-4: `positiveToolCallIds` is validated element-by-element (safe
 *     positive integers, uniqueness, 1..3), not just "is array".
 *   - rc-5: `Object.hasOwn` over the `in` operator.
 *   - rc-8: unknown failure details are serialized with a bounded preview.
 *   - rc-9: every non-ready outcome carries a stable reasonCode and a
 *     nextAction the Owner can act on.
 *
 * Reason codes (SPEC-PD-IAER-001 FR-04 stable IDs): `owner_behavior_examples_required`,
 * `owner_behavior_examples_invalid`, `owner_behavior_examples_stale`,
 * `owner_behavior_examples_scope_mismatch`. Stale/scope codes are part of the
 * stable contract for downstream consumers (A2 wiring, FR-04 recovery UX);
 * this pure gate reports `required` (nothing provided) or `invalid`
 * (provided but rejected) — the assembler owns scope/staleness rejection
 * today, and its failures surface here as `invalid`.
 *
 * Channel authority: whether the target channel requires Owner evidence at
 * all is DECLARED by the caller (`channelRequiresOwnerEvidence`) — this module
 * does not guess channels (SPEC §4.2). A2 owns the authoritative wiring; this
 * ticket provides the judgment only.
 *
 * Spec: docs/specs/SPEC-PD-IAER-001-v1.0.md §5 FR-01
 */
import { createHash } from 'node:crypto';
import { validateBehaviorExamplePack, type BehaviorExamplePack } from './behavior-example-pack.js';

// ── public types ───────────────────────────────────────────────────────────

/**
 * Owner-labelled evidence selection (FR-03 contract fields). Provided by an
 * authorized Owner operation — never fabricated by an internal agent.
 * Shape mirrors the host-side `BehaviorExamplePackAssemblerInput` minus
 * I/O-only fields, so an assembler can be driven straight from a selection.
 */
export interface OwnerEvidenceSelection {
  /** Canonical pain ID the evidence belongs to (pain lineage root). */
  readonly sourcePainId: string;
  /** Owner-selected tool call demonstrating the behaviour to block. */
  readonly sourceNegativeToolCallId: number;
  /** Owner-selected tool calls demonstrating the behaviour to allow (1..3, unique). */
  readonly positiveToolCallIds: readonly number[];
  /** Owner's natural-language desired outcome — non-empty. */
  readonly ownerDesiredOutcome: string;
}

/** Stable reason codes (SPEC-PD-IAER-001 FR-04). Do not rename. */
export type OwnerEvidenceReasonCode =
  | 'owner_behavior_examples_required'
  | 'owner_behavior_examples_invalid'
  | 'owner_behavior_examples_stale'
  | 'owner_behavior_examples_scope_mismatch';

/** Pre-computed assembly outcome, for callers that already ran the assembler. */
export type EvidenceAssemblyOutcome =
  | { readonly ok: true; readonly pack: BehaviorExamplePack }
  | { readonly ok: false; readonly error: unknown };

export interface EvidenceReadinessInput {
  /**
   * Caller-declared target-channel applicability (the channel authority lives
   * in the A2 wiring, not here). `false` → `not_applicable`. Anything other
   * than an explicit `false` fails closed toward REQUIRING evidence.
   */
  readonly channelRequiresOwnerEvidence: boolean;
  /** Owner selection; `undefined`/`null` = the Owner has not provided evidence. */
  readonly ownerSelection?: OwnerEvidenceSelection | null;
  /**
   * Injected assembly step. Throws on failure (assembler ERR-069 fail-loud
   * convention); the gate captures the throw as `invalid_evidence` with the
   * bounded error detail — exception details are never swallowed.
   * Takes precedence over `assemblyResult` when both are provided.
   */
  readonly assemblePack?: () => BehaviorExamplePack;
  /** Pre-assembled result, alternative to `assemblePack`. */
  readonly assemblyResult?: EvidenceAssemblyOutcome;
}

/**
 * Evidence readiness verdict (FR-01 discriminant union). Field naming follows
 * the house style for structured refusals (reasonCode / nextAction / detail).
 */
export type EvidenceReadiness =
  | {
      readonly status: 'ready';
      readonly pack: BehaviorExamplePack;
      /** `sha256:<hex>` content digest of the pack (intent-hash.ts convention). */
      readonly evidenceHash: string;
      readonly sourcePainId: string;
    }
  | {
      readonly status: 'owner_evidence_required';
      readonly reasonCode: Extract<OwnerEvidenceReasonCode, 'owner_behavior_examples_required'>;
      readonly missingFields: readonly string[];
      readonly nextAction: string;
    }
  | {
      readonly status: 'invalid_evidence';
      readonly reasonCode: OwnerEvidenceReasonCode;
      /** Bounded structured reason (rc-8) — why the evidence was rejected. */
      readonly detail: string;
      readonly nextAction: string;
    }
  | {
      readonly status: 'not_applicable';
    };

// ── internal constants ─────────────────────────────────────────────────────

const SELECTION_FIELD_NAMES: readonly string[] = [
  'sourcePainId',
  'sourceNegativeToolCallId',
  'positiveToolCallIds',
  'ownerDesiredOutcome',
];

const MAX_POSITIVES = 3;

/** rc-8: bounded previews for unknown failure details. */
const MAX_DETAIL_LENGTH = 480;
const MAX_VALIDATION_ERRORS = 8;

// ── internal helpers ───────────────────────────────────────────────────────

function isPlainObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** rc-8: bounded, single-line serialization of an unknown error/detail. */
function boundedDetail(value: unknown): string {
  let raw: string;
  if (value instanceof Error) {
    raw = value.message;
  } else if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value) ?? String(value);
    } catch {
      raw = String(value);
    }
  }
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DETAIL_LENGTH
    ? `${flat.slice(0, MAX_DETAIL_LENGTH)}…[truncated]`
    : flat;
}

/**
 * Structural validation of the Owner selection (rc-1..rc-5). Returns the list
 * of field-level problems; an empty list means the selection is usable.
 * Semantics deliberately mirror `validateOwnerSelection` in the plugin
 * assembler (positive safe integers, 1..3 unique positives, non-empty text):
 * a present-but-unusable selection is REJECTED, never repaired here.
 *
 * PRI-982: exported as the SINGLE shape authority for the persisted
 * `pi_metadata.ownerEvidenceSelection` field — pitask-metadata parse reuses
 * this validator so the persistence layer and the readiness gate can never
 * diverge on what a usable selection is. Takes `unknown` (rc-1: the metadata
 * parse reads it from a DB row) and rejects non-objects itself.
 */
export function validateOwnerEvidenceSelectionShape(selection: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObjectLike(selection)) {
    return ['ownerSelection must be a plain object'];
  }

  if (!Object.hasOwn(selection, 'sourcePainId') || !isNonEmptyString(selection.sourcePainId)) {
    problems.push('ownerSelection.sourcePainId must be a non-empty string');
  }
  if (!Object.hasOwn(selection, 'sourceNegativeToolCallId')
    || !isPositiveSafeInteger(selection.sourceNegativeToolCallId)) {
    problems.push('ownerSelection.sourceNegativeToolCallId must be a positive safe integer');
  }
  if (!Object.hasOwn(selection, 'positiveToolCallIds') || !Array.isArray(selection.positiveToolCallIds)) {
    problems.push('ownerSelection.positiveToolCallIds must be an array');
  } else {
    const ids = selection.positiveToolCallIds;
    if (ids.length === 0 || ids.length > MAX_POSITIVES) {
      problems.push(`ownerSelection.positiveToolCallIds must contain 1 to at most ${MAX_POSITIVES} IDs, got ${ids.length}`);
    }
    for (let i = 0; i < ids.length; i++) {
      if (!isPositiveSafeInteger(ids[i])) {
        problems.push(`ownerSelection.positiveToolCallIds[${i}] must be a positive safe integer`);
      }
    }
    if (new Set(ids).size !== ids.length) {
      problems.push('ownerSelection.positiveToolCallIds must be unique');
    }
  }
  if (!Object.hasOwn(selection, 'ownerDesiredOutcome') || !isNonEmptyString(selection.ownerDesiredOutcome)) {
    problems.push('ownerSelection.ownerDesiredOutcome must be a non-empty string');
  }

  return problems;
}

/** `sha256:<hex>` content digest over the pack's canonical JSON (rc-6: one hash convention). */
function computeEvidenceHash(pack: BehaviorExamplePack): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(pack), 'utf8').digest('hex')}`;
}

// ── public entry point ─────────────────────────────────────────────────────

/**
 * Pure evidence readiness judgment (FR-01). No I/O, no state — the caller
 * injects the assembly step and declares channel applicability.
 *
 * Decision order:
 *   1. channel does not require evidence → `not_applicable`;
 *   2. no Owner selection → `owner_evidence_required` + missingFields;
 *   3. selection present but structurally unusable → `invalid_evidence`
 *      (assembler validateOwnerSelection semantics);
 *   4. assembly throws / pre-assembled failure → `invalid_evidence` with the
 *      bounded error detail (never swallowed);
 *   5. assembled pack fails `validateBehaviorExamplePack` → `invalid_evidence`
 *      (single validator authority);
 *   6. otherwise → `ready` with the pack, its `sha256:<hex>` evidence hash,
 *      and the source pain ID.
 */
export function assessEvidenceReadiness(input: EvidenceReadinessInput): EvidenceReadiness {
  // 1. Caller-declared channel authority. Fail closed: anything but an
  //    explicit `false` counts as requiring evidence.
  if (input.channelRequiresOwnerEvidence === false) {
    return { status: 'not_applicable' };
  }

  // 2. Owner selection presence (rc-3: missing fields reported explicitly).
  const selection = input.ownerSelection;
  if (selection === undefined || selection === null) {
    return {
      status: 'owner_evidence_required',
      reasonCode: 'owner_behavior_examples_required',
      missingFields: SELECTION_FIELD_NAMES,
      nextAction: 'Owner must provide the labelled behaviour examples (sourcePainId, sourceNegativeToolCallId, positiveToolCallIds 1..3 unique, ownerDesiredOutcome) via the evidence recovery entry (SPEC-PD-IAER-001 FR-06) before this task can run.',
    };
  }

  // 3. Selection shape (untrusted — rc-1..rc-5; assembler-aligned rejection).
  const selectionProblems = validateOwnerEvidenceSelectionShape(selection);
  if (selectionProblems.length > 0) {
    return {
      status: 'invalid_evidence',
      reasonCode: 'owner_behavior_examples_invalid',
      detail: boundedDetail(selectionProblems.join('; ')),
      nextAction: 'Owner must resubmit a complete, valid evidence selection (positive safe integer tool-call IDs, 1..3 unique positives, non-empty outcome).',
    };
  }

  // 4. Assembly — callback (throws captured) or pre-computed outcome.
  let assemblyError: unknown;
  let pack: BehaviorExamplePack | undefined;
  if (input.assemblePack !== undefined) {
    try {
      pack = input.assemblePack();
    } catch (error) {
      assemblyError = error;
    }
  } else if (input.assemblyResult !== undefined) {
    if (input.assemblyResult.ok) {
      ({ pack } = input.assemblyResult);
    } else {
      assemblyError = input.assemblyResult.error;
    }
  }
  if (pack === undefined) {
    return {
      status: 'invalid_evidence',
      reasonCode: 'owner_behavior_examples_invalid',
      detail: boundedDetail(assemblyError),
      nextAction: 'Evidence assembly failed; Owner must re-select examples that still exist in the pain lineage, then retry (do not blindly retry the task).',
    };
  }

  // 5. Single pack-validation authority (reuse, never a second validator).
  const validation = validateBehaviorExamplePack(pack);
  if (!validation.valid) {
    const errors = validation.errors.slice(0, MAX_VALIDATION_ERRORS);
    const truncated = validation.errors.length > errors.length
      ? ` …[+${validation.errors.length - errors.length} more]`
      : '';
    return {
      status: 'invalid_evidence',
      reasonCode: 'owner_behavior_examples_invalid',
      detail: boundedDetail(`${errors.join('; ')}${truncated}`),
      nextAction: 'Owner-provided evidence failed the BehaviorExamplePack contract; Owner must correct the labelled examples and resubmit.',
    };
  }

  // 6. Ready.
  return {
    status: 'ready',
    pack,
    evidenceHash: computeEvidenceHash(pack),
    sourcePainId: selection.sourcePainId,
  };
}
