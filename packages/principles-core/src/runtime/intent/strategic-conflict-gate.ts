/**
 * SIA v1.2 · SPEC §10.3 / §10.5, TECH §8.4 / §8.5 — the strategic-conflict
 * approval gate.
 *
 * ONE predicate shared by the write path (SqliteApprovalStore.approve) and the
 * read model (approval block) so the UI can never promise an approval the
 * server would refuse, and the server can never rely on the UI.
 *
 * Rules:
 * 1. Legacy / V1 artifacts are unaffected (no schemaVersion: 2 → allowed).
 * 2. A V2 that claims `schemaVersion: 2` but does not validate is a HARD block
 *    (tampered / incomplete V2 must never be approvable).
 * 3. `conflictStatus !== 'confirmed'` → allowed.
 * 4. `confirmed` requires an effective resolution record bound to ALL of:
 *    the artifact's candidate, the contract's intent hash AND the artifact
 *    digest. Any change to any of those invalidates the old record.
 *
 * `intentTension` is NOT consulted here; relevance/conflicts live in the V2
 * assessment, which is the only authority this gate reads.
 */
import {
  extractIntentContractV2,
  type IntentContractV2,
} from '../internalization/intent-contract.js';

export const STRATEGIC_CONFLICT_UNCONFIRMED = 'strategic_conflict_unconfirmed';

/**
 * The Owner action that acknowledges a confirmed conflict. Other actions
 * (`observe` = keep pending, `dismiss` = drop the tension, `revise_intent` =
 * change the anchor, `promote_to_*` = act on the candidate) do not resolve it.
 */
export const STRATEGIC_CONFLICT_RESOLUTION_ACTION = 'confirm_drift';

export interface StrategicResolutionRecord {
  readonly ownerAction: string;
  readonly intentDocHash: string | null;
  /**
   * Bound to the FULL artifact digest (`computeArtifactDigest()` over the
   * artifact snapshot under approval), NOT a contract-only digest. Such a
   * digest does not exist in PD and must not be introduced: re-scribing or
   * rewriting the artifact must invalidate the decision.
   */
  readonly contractDigest: string | null;
  readonly resultingCandidateId: string | null;
  /**
   * P1-2: the INTENT sections this decision covered, resolved from the immutable
   * `related_intent_fields_snapshot` (falling back to the mutable column for
   * legacy rows). A decision only exempts the conflicts it actually names.
   */
  readonly relatedIntentFields?: readonly string[];
}

/**
 * SPEC §20.2: ONLY these three sections are ordinary strategic trade-offs an
 * Owner may accept with `confirm_drift`. `non_negotiables` and
 * `stop_escalation` are boundaries, not trade-offs — accepting a boundary
 * violation is not a decision the drift acknowledgement can express.
 */
export const STRATEGIC_TRADEOFF_SECTIONS = [
  'why',
  'desired_outcome',
  'current_strategic_focus',
] as const;

type StrategicConflict = NonNullable<IntentContractV2['strategicAssessment']['conflicts']>[number];

function isExemptableConflict(conflict: StrategicConflict): boolean {
  return conflict.against === 'owner_intent'
    && (STRATEGIC_TRADEOFF_SECTIONS as readonly string[]).includes(conflict.ref);
}

export interface StrategicConflictGateInput {
  /** Parsed artifact contentJson (untrusted). `undefined` = unparseable. */
  readonly artifactContent: unknown;
  /** True when contentJson could not be parsed at all (corrupted artifact). */
  readonly artifactContentUnreadable?: boolean;
  /** Server-computed digest of the SAME artifact snapshot under approval. */
  readonly artifactDigest: string;
  /** Candidate ids attached to the artifact (server read). */
  readonly candidateIds: readonly string[];
  /** Resolution candidates for this artifact, server read. */
  readonly resolutions: readonly StrategicResolutionRecord[];
}

export type StrategicConflictGateResult =
  | { readonly ok: true; readonly conflictStatus: 'none' | 'potential' | 'confirmed' }
  | {
      readonly ok: false;
      readonly code: typeof STRATEGIC_CONFLICT_UNCONFIRMED;
      readonly reason: string;
      readonly nextAction: string;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * TECH §8.3: the refusal reason must NAME the conflict target (`against` +
 * `ref`) so the Owner can act on it instead of reading an opaque code.
 */
function describeTargets(conflicts: readonly StrategicConflict[]): string {
  if (conflicts.length === 0) return '';
  return conflicts.map((conflict) => `${conflict.against}:${conflict.ref}`).join(', ');
}

function blocked(
  reason: string,
  conflicts: readonly StrategicConflict[],
  nextAction: string,
): StrategicConflictGateResult {
  const targets = describeTargets(conflicts);
  return {
    ok: false,
    code: STRATEGIC_CONFLICT_UNCONFIRMED,
    reason: targets === '' ? reason : `${reason} [${targets}]`,
    nextAction,
  };
}

const HOW_TO_RESOLVE_TRADEOFF =
  'Record an Owner decision with owner_action=confirm_drift that NAMES these sections in relatedIntentFields, bound to the current candidate, the intent hash and the current artifact digest, then approve again.';

const HOW_TO_RESOLVE_CORE_PRINCIPLE =
  'A PD Core Principle cannot be exempted by an Owner Intent decision. Change the candidate so it satisfies BOTH anchors, then re-form the candidate and submit it for approval again.';

const HOW_TO_RESOLVE_BOUNDARY =
  'confirm_drift cannot exempt a Non-negotiable / Stop-Escalation boundary. Either change the candidate so it respects the boundary, or update INTENT.md deliberately and re-form the candidate from the new intent version.';

/**
 * P1-3: a `confirmed` conflict that carries no conflict element cannot be
 * matched against any decision — the Owner cannot "cover" an unnamed target.
 */
const HOW_TO_RECLASSIFY_CONFLICT =
  'This contract claims a confirmed conflict but names no conflict target, so no Owner decision can cover it. Re-form the candidate so the Scribe emits an explicit conflict (against + ref), then approve again. Already-completed historical approvals are not revoked; a pending one must be re-reviewed.';

/**
 * Rule 1 predicate: does this artifact CLAIM an IntentContract V2? The V2 lives
 * at `artifact.intentContract` (schemaVersion 2), never at the artifact root —
 * the contract is a sibling key of the scribe output, exactly as V1 is.
 *
 * REVIEW FIX (PR #2652 P0-4): a claim is ANY presence of a V2-exclusive key or
 * of `schemaVersion` — including an ILLEGAL `schemaVersion` value and a V2 that
 * forgot the field. The old predicate only matched `schemaVersion === 2`, so an
 * incomplete V2 silently fell into the V1 compatibility path and was approvable.
 */
export function claimsIntentContractV2(artifactContent: unknown): boolean {
  if (!isRecord(artifactContent)) return false;
  const contract = artifactContent.intentContract;
  if (!isRecord(contract)) return false;
  return Object.hasOwn(contract, 'schemaVersion')
    || Object.hasOwn(contract, 'strategicAssessment')
    || Object.hasOwn(contract, 'strategicIntent')
    || Object.hasOwn(contract, 'corePrincipleRefs');
}

/**
 * Does the approval gate have jurisdiction over this artifact at all?
 * True when the content is unreadable (a corrupted artifact must never be
 * approvable) or when the artifact carries an `intentContract` of any shape.
 */
export function hasStrategicContractClaim(artifactContent: unknown, unreadable = false): boolean {
  if (unreadable) return true;
  return isRecord(artifactContent) && Object.hasOwn(artifactContent, 'intentContract');
}

/**
 * Classification of the artifact's contract claim (SPEC §8.2 completeness).
 *
 * `invalid-v2` / `unreadable` are HARD blocks: an artifact that claims V2 must
 * carry a COMPLETE V2.
 *
 * Contracts with NO V2-exclusive key stay on the legacy V1 compatibility path
 * (`none`) even when they are not a complete V1. SIA only governs V2; blocking
 * pre-SIA artifacts here would freeze historical approvals the gate never
 * owned (V1 completeness is enforced by the V1 creation path).
 */
type StrategicClaim =
  | { readonly kind: 'none' }
  | { readonly kind: 'v2'; readonly contract: IntentContractV2 }
  | { readonly kind: 'invalid-v2' | 'unreadable' };

function readStrategicClaim(input: StrategicConflictGateInput): StrategicClaim {
  if (input.artifactContentUnreadable === true) return { kind: 'unreadable' };
  const content = input.artifactContent;
  if (!isRecord(content)) return { kind: 'none' };
  if (!Object.hasOwn(content, 'intentContract')) return { kind: 'none' };
  const raw = content.intentContract;
  // A present-but-non-object contract is corruption, never "absent".
  if (!isRecord(raw)) return { kind: 'invalid-v2' };
  if (!claimsIntentContractV2(content)) return { kind: 'none' };
  const contract = extractIntentContractV2(content);
  return contract === null ? { kind: 'invalid-v2' } : { kind: 'v2', contract };
}

export function evaluateStrategicConflictGate(input: StrategicConflictGateInput): StrategicConflictGateResult {
  // Rule 1: artifacts without an intent-contract claim are outside SIA.
  const claim = readStrategicClaim(input);
  if (claim.kind === 'none') {
    return { ok: true, conflictStatus: 'none' };
  }
  // Rule 2: an incomplete / corrupted claim is never approvable.
  if (claim.kind !== 'v2') {
    return blocked(
      claim.kind === 'unreadable' ? 'unreadable_artifact_content' : 'malformed_strategic_contract',
      [],
      'Re-run the Scribe stage so the artifact carries a complete IntentContract V2, then approve again.',
    );
  }
  const { contract } = claim;
  const status = contract.strategicAssessment.conflictStatus;
  // Rule 3.
  if (status !== 'confirmed') {
    return { ok: true, conflictStatus: status };
  }
  // Rule 4: binding requires the server-captured intent hash.
  const intentDocHash = contract.strategicIntent?.contentHash;
  if (intentDocHash === undefined || intentDocHash === '') {
    return blocked('missing_intent_reference', [], HOW_TO_RESOLVE_TRADEOFF);
  }

  const confirmed = (contract.strategicAssessment.conflicts ?? [])
    .filter((conflict) => conflict.status === 'confirmed');

  const effective = input.resolutions.filter((record) =>
    record.ownerAction === STRATEGIC_CONFLICT_RESOLUTION_ACTION
    && record.intentDocHash === intentDocHash
    && record.contractDigest === input.artifactDigest
    && record.resultingCandidateId !== null
    && input.candidateIds.includes(record.resultingCandidateId));

  if (confirmed.length === 0) {
    // P1-3: `conflictStatus: 'confirmed'` with NO conflict element is an
    // UNCLASSIFIED conflict. The contract never says what conflicts, so no
    // Owner decision can cover it, and inferring the target from a decision's
    // `relatedIntentFields` would let a generic `confirm_drift` exempt a
    // conflict the server never understood. Hard block — never a resolution.
    return blocked('unclassified_conflict', [], HOW_TO_RECLASSIFY_CONFLICT);
  }

  // Rule 5 (SPEC §20.2): boundaries and Core Principles are NEVER exemptable.
  const unexemptable = confirmed.filter((conflict) => !isExemptableConflict(conflict));
  if (unexemptable.length > 0) {
    const hasCorePrinciple = unexemptable.some((conflict) => conflict.against === 'core_principle');
    return blocked(
      hasCorePrinciple ? 'core_principle_conflict' : 'owner_boundary_conflict',
      unexemptable,
      hasCorePrinciple ? HOW_TO_RESOLVE_CORE_PRINCIPLE : HOW_TO_RESOLVE_BOUNDARY,
    );
  }

  // Rule 6: EVERY ordinary trade-off must be covered by an effective decision.
  // Exempting one conflict must not silently release the others.
  const uncovered = confirmed.filter((conflict) =>
    !effective.some((record) => (record.relatedIntentFields ?? []).includes(conflict.ref)));
  return uncovered.length === 0
    ? { ok: true, conflictStatus: 'confirmed' }
    : blocked('no_effective_resolution', uncovered, HOW_TO_RESOLVE_TRADEOFF);
}

/** Read-model projection: what the Owner must see before the approve action. */
export interface StrategicConflictView {
  readonly isV2: boolean;
  readonly relevance: string | null;
  readonly conflictStatus: string | null;
  /** The V2 conflict list (`against` + `ref`) the card must render. */
  readonly conflicts: readonly { readonly against: string; readonly ref: string; readonly status: string }[];
  readonly resolved: boolean;
  readonly blockCode: string | null;
  readonly reason: string | null;
  readonly nextAction: string | null;
}

export function describeStrategicConflict(input: StrategicConflictGateInput): StrategicConflictView {
  const claim = readStrategicClaim(input);
  const contract = claim.kind === 'v2' ? claim.contract : null;
  const gate = evaluateStrategicConflictGate(input);
  return {
    // A malformed V2 is still a V2 artifact — the card must show it as a
    // blocked strategic contract, never as a plain non-SIA approval.
    isV2: claim.kind === 'v2' || claim.kind === 'invalid-v2',
    relevance: contract?.strategicAssessment.relevance ?? null,
    conflictStatus: contract?.strategicAssessment.conflictStatus ?? null,
    conflicts: (contract?.strategicAssessment.conflicts ?? []).map((conflict) => ({
      against: conflict.against,
      ref: conflict.ref,
      status: conflict.status,
    })),
    resolved: gate.ok,
    blockCode: gate.ok ? null : gate.code,
    reason: gate.ok ? null : gate.reason,
    nextAction: gate.ok ? null : gate.nextAction,
  };
}
