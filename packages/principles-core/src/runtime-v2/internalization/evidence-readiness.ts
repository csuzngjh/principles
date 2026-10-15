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
 * `owner_behavior_examples_scope_mismatch`. This pure gate reports `required`
 * (nothing provided), `invalid` (provided but rejected), and — since B1
 * (PRI-983) — `stale` / `scope_mismatch` when the assembler fails with the
 * typed `OwnerEvidenceScopeError` (structural classification, never message
 * sniffing): unresolvable pain/row references are `stale` (FR-03: cleaned
 * trajectories must never be silently reused), cross-session selections are
 * `scope_mismatch`. Plain errors stay `invalid` (A2 behavior unchanged).
 * PRI-980 review P2-1 adds the §6.2 storage-fault family: the typed
 * `evidence_source_error` kind → a distinct `evidence_source_error` verdict
 * that is NOT an FR-04 owner-fault code.
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
  /**
   * B1 (PRI-983, SPEC FR-03): attach revision — 1 on first attach, +1 on every
   * re-attach. ABSENT = legacy record written before revision tracking.
   */
  readonly revision?: number;
  /**
   * B1 (FR-03): `sha256:<hex>` content digest over the successfully assembled
   * pack (canonical JSON, same convention as the readiness verdict hash).
   * Resume re-assembles and refuses on mismatch — a silently stale reference
   * can never re-enter the model (FR-03 "拒绝无声复用旧引用").
   * ABSENT = legacy record; resume refuses un-digested selections.
   */
  readonly contentDigest?: string;
  /**
   * B1 (FR-03): authorized Owner operation label that wrote this selection
   * (e.g. `cli:attach` / `cli:attach:<decidedBy>`). Evidence is only written
   * by an explicit Owner operation — never by an internal agent (C-04).
   */
  readonly ownerOperation?: string;
  /** B1 (FR-03): ISO timestamp of the attach. ABSENT = legacy. */
  readonly attachedAt?: string;
}

/** Stable reason codes (SPEC-PD-IAER-001 FR-04). Do not rename. */
export type OwnerEvidenceReasonCode =
  | 'owner_behavior_examples_required'
  | 'owner_behavior_examples_invalid'
  | 'owner_behavior_examples_stale'
  | 'owner_behavior_examples_scope_mismatch';

// ── typed assembly-failure classification (B1, PRI-983) ────────────────────
//
// The plugin assembler previously failed evidence gaps with plain Errors, so
// every assembly failure could only surface as `invalid_evidence` (A2
// contract note). B1 adds a STRUCTURAL error classification — never message
// sniffing — so resume can distinguish "trajectory cleaned/changed" (stale)
// from "cross pain/session selection" (scope mismatch), the two stable FR-04
// codes the recovery UX must separate.
//
// Cross-bundle note: the plugin bundle INLINES @principles/core (esbuild,
// core not in `external`), so an `instanceof` check against this module's
// class would fail across the pd-cli → plugin-bundle boundary. The stable
// contract is therefore structural: the reserved error `name` plus a
// validated `ownerEvidenceScopeKind` property (rc-5 hasOwn-style read, rc-1:
// kind is validated, not trusted).

/** Reserved error name for Owner evidence scope failures. Do not rename. */
export const OWNER_EVIDENCE_SCOPE_ERROR_NAME = 'OwnerEvidenceScopeError';

/**
 * Structured kinds of a typed evidence-assembly failure:
 *   - `pain_not_found` / `tool_call_not_found`: the trajectory the selection
 *     references does not resolve (cleaned or wrong workspace) → the stable
 *     STALE code (FR-03: a cleaned trajectory must never be silently reused);
 *   - `session_mismatch`: a selected row belongs to another session → the
 *     stable SCOPE code (SPEC FR-04 cross pain/session);
 *   - `evidence_source_error`: the evidence SOURCE itself failed (trajectory
 *     store I/O: unavailable / locked / read error) → the §6.2 storage-fault
 *     family, deliberately NOT an FR-04 Owner-fault code. Owner-reviewer
 *     vocabulary: a PRI-980 review fix separates "Owner labelled bad
 *     evidence" from "the evidence source could not be read" (§6.2: 保留明确
 *     的存储故障，不误判为 Owner 尚未标注).
 *
 * (The type name predates the storage kind — it is the reserved typed-error
 * family's stable name; do not rename, the plugin bundle relies on the
 * structural `name` + kind contract.)
 */
export type OwnerEvidenceScopeMismatchKind =
  | 'pain_not_found'
  | 'tool_call_not_found'
  | 'session_mismatch'
  | 'evidence_source_error';

const SCOPE_MISMATCH_KINDS: ReadonlySet<string> = new Set([
  'pain_not_found',
  'tool_call_not_found',
  'session_mismatch',
  'evidence_source_error',
]);

/** Map a structured SCOPE failure to its stable FR-04 reason code.
 *  `evidence_source_error` must never enter here — it is not an owner-fault
 *  code and is routed by the readiness gate before this helper. */
function reasonCodeForScopeKind(kind: OwnerEvidenceScopeMismatchKind): OwnerEvidenceReasonCode {
  return kind === 'session_mismatch'
    ? 'owner_behavior_examples_scope_mismatch'
    : 'owner_behavior_examples_stale';
}

/** Build the typed error the plugin assembler throws for scope failures. */
export function createOwnerEvidenceScopeError(
  kind: OwnerEvidenceScopeMismatchKind,
  message: string,
): Error {
  const error = new Error(message);
  error.name = OWNER_EVIDENCE_SCOPE_ERROR_NAME;
  Object.assign(error, { ownerEvidenceScopeKind: kind });
  return error;
}

export type OwnerEvidenceScopeError = Error & {
  readonly ownerEvidenceScopeKind: OwnerEvidenceScopeMismatchKind;
};

/** Structural guard (cross-bundle safe — see module comment above). */
export function isOwnerEvidenceScopeError(value: unknown): value is OwnerEvidenceScopeError {
  if (!(value instanceof Error)) return false;
  if ((value as { name?: unknown }).name !== OWNER_EVIDENCE_SCOPE_ERROR_NAME) return false;
  const kind = (value as { ownerEvidenceScopeKind?: unknown }).ownerEvidenceScopeKind;
  return typeof kind === 'string' && SCOPE_MISMATCH_KINDS.has(kind);
}

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
   * convention); the gate captures the throw and classifies it: typed scope
   * kinds → the stable FR-04 codes, the typed `evidence_source_error` kind →
   * the §6.2 storage-fault verdict, everything else → `invalid_evidence` with
   * the bounded error detail — exception details are never swallowed.
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
      /**
       * The evidence SOURCE failed (trajectory store I/O — PRI-980 review
       * P2-1, SPEC §6.2 case 3). Deliberately NOT `invalid_evidence`: a
       * storage fault must never read as "Owner labelled bad evidence".
       * `reason` (not `reasonCode`) marks it as outside the FR-04
       * Owner-fault vocabulary — callers must keep the task wake-eligible /
       * untouched and degrade observably, never write an owner-fault NHR
       * reason.
       */
      readonly status: 'evidence_source_error';
      readonly reason: 'evidence_source_error';
      /** Bounded structured reason (rc-8) — the underlying failure message. */
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

/** `sha256:<64 lowercase hex chars>` — the only accepted contentDigest shape. */
const CONTENT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

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

  // ── B1 (PRI-983 FR-03) persisted provenance fields — optional (ABSENT =
  // legacy A2 record), but presence MUST be well-formed: a corrupted
  // provenance field fails the whole selection here, which (via the
  // pitask-metadata parse delegation) fails the whole metadata closed.
  if (Object.hasOwn(selection, 'revision') && selection.revision !== undefined) {
    if (typeof selection.revision !== 'number' || !Number.isSafeInteger(selection.revision) || selection.revision < 1) {
      problems.push('ownerSelection.revision must be a positive safe integer when present');
    }
  }
  if (Object.hasOwn(selection, 'contentDigest') && selection.contentDigest !== undefined) {
    if (typeof selection.contentDigest !== 'string' || !CONTENT_DIGEST_PATTERN.test(selection.contentDigest)) {
      problems.push('ownerSelection.contentDigest must match sha256:<64 hex> when present');
    }
  }
  if (Object.hasOwn(selection, 'ownerOperation') && selection.ownerOperation !== undefined) {
    if (!isNonEmptyString(selection.ownerOperation)) {
      problems.push('ownerSelection.ownerOperation must be a non-empty string when present');
    }
  }
  if (Object.hasOwn(selection, 'attachedAt') && selection.attachedAt !== undefined) {
    if (!isNonEmptyString(selection.attachedAt)) {
      problems.push('ownerSelection.attachedAt must be a non-empty ISO string when present');
    }
  }

  return problems;
}

/** `sha256:<hex>` content digest over the pack's canonical JSON (rc-6: one hash convention). */
export function computeBehaviorExamplePackDigest(pack: BehaviorExamplePack): string {
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
    // B1: structured scope classification first (typed error, never message
    // sniffing). pain/row unresolvable → stale (FR-03: cleaned trajectory must
    // not be silently reused); cross-session selection → scope mismatch
    // (SPEC FR-04). PRI-980 review P2-1: a typed evidence_source_error (the
    // assembler's trajectory-store I/O failure) is routed to the §6.2
    // storage-fault family — task-side routing must keep the task
    // wake-eligible, never write an owner-fault reason. Plain errors stay
    // `invalid` (A2 behavior unchanged).
    if (isOwnerEvidenceScopeError(assemblyError)) {
      if (assemblyError.ownerEvidenceScopeKind === 'evidence_source_error') {
        return {
          status: 'evidence_source_error',
          reason: 'evidence_source_error',
          detail: boundedDetail(assemblyError.message),
          nextAction: 'The evidence source itself failed (trajectory store I/O); this is NOT an Owner evidence fault. The task stays wake-eligible and the next cycle retries assembly at zero model cost; if it persists, inspect the trajectory store for this workspace (pd runtime internalization integrity --json).',
        };
      }
      const reasonCode = reasonCodeForScopeKind(assemblyError.ownerEvidenceScopeKind);
      return {
        status: 'invalid_evidence',
        reasonCode,
        detail: boundedDetail(`${assemblyError.ownerEvidenceScopeKind}: ${assemblyError.message}`),
        nextAction: reasonCode === 'owner_behavior_examples_stale'
          ? 'Trajectory evidence is missing or has changed; Owner must re-attach fresh examples (pd runtime internalization evidence attach --confirm) before this task can resume.'
          : 'Owner must select tool calls that belong to the referenced pain session (cross pain/session selections are refused), then re-attach.',
      };
    }
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
    evidenceHash: computeBehaviorExamplePackDigest(pack),
    sourcePainId: selection.sourcePainId,
  };
}
