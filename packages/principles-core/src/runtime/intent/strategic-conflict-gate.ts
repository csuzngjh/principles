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
import { extractIntentContractV2, type IntentContractV2 } from '../internalization/intent-contract.js';

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
  readonly contractDigest: string | null;
  readonly resultingCandidateId: string | null;
}

export interface StrategicConflictGateInput {
  /** Parsed artifact contentJson (untrusted). */
  readonly artifactContent: unknown;
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
function describeTargets(contract: IntentContractV2 | null): string {
  const conflicts = contract?.strategicAssessment.conflicts ?? [];
  if (conflicts.length === 0) return '';
  return conflicts.map((conflict) => `${conflict.against}:${conflict.ref}`).join(', ');
}

function blocked(reason: string, contract: IntentContractV2 | null): StrategicConflictGateResult {
  const targets = describeTargets(contract);
  return {
    ok: false,
    code: STRATEGIC_CONFLICT_UNCONFIRMED,
    reason: targets === '' ? reason : `${reason} [${targets}]`,
    nextAction:
      'Resolve the confirmed strategic conflict for THIS contract first: record an Owner decision bound to the current candidate, the intent hash and the current contract digest, then approve again.',
  };
}

/**
 * Rule 1 predicate: does this artifact CLAIM an IntentContract V2? The V2 lives
 * at `artifact.intentContract` (schemaVersion 2), never at the artifact root —
 * the contract is a sibling key of the scribe output, exactly as V1 is.
 */
export function claimsIntentContractV2(artifactContent: unknown): boolean {
  if (!isRecord(artifactContent)) return false;
  const contract = artifactContent.intentContract;
  return isRecord(contract) && contract.schemaVersion === 2;
}

export function evaluateStrategicConflictGate(input: StrategicConflictGateInput): StrategicConflictGateResult {
  // Rule 1: only artifacts that explicitly claim V2 are subject to the gate.
  if (!claimsIntentContractV2(input.artifactContent)) {
    return { ok: true, conflictStatus: 'none' };
  }
  // Rule 2: a V2 claim that does not validate is never approvable.
  const contract = extractIntentContractV2(input.artifactContent);
  if (contract === null) {
    return blocked('malformed_strategic_contract', null);
  }
  const status = contract.strategicAssessment.conflictStatus;
  // Rule 3.
  if (status !== 'confirmed') {
    return { ok: true, conflictStatus: status };
  }
  // Rule 4: binding requires the server-captured intent hash.
  const intentDocHash = contract.strategicIntent?.contentHash;
  if (intentDocHash === undefined || intentDocHash === '') {
    return blocked('missing_intent_reference', contract);
  }
  const resolved = input.resolutions.some((record) =>
    record.ownerAction === STRATEGIC_CONFLICT_RESOLUTION_ACTION
    && record.intentDocHash === intentDocHash
    && record.contractDigest === input.artifactDigest
    && record.resultingCandidateId !== null
    && input.candidateIds.includes(record.resultingCandidateId));
  return resolved ? { ok: true, conflictStatus: 'confirmed' } : blocked('no_effective_resolution', contract);
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
  const contract = isRecord(input.artifactContent) ? extractIntentContractV2(input.artifactContent) : null;
  const gate = evaluateStrategicConflictGate(input);
  return {
    isV2: contract !== null,
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
