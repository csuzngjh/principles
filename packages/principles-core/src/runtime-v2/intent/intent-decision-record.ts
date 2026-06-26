/**
 * IntentDecisionRecord — durable audit record of Owner decisions on surfaced
 * intentTension (PRI-470, SPEC §21.7).
 *
 * Owner decisions on intentTension MUST form an auditable record. This module
 * defines the pure types and the store interface; the SQLite implementation
 * lives in `runtime-v2/store/intent/`.
 *
 * Persistence boundary (SPEC §21.7):
 * - Records are durable (state.db `intent_decisions` table), never transient.
 * - Same `painId + intentDocHash + ownerAction` resubmission is idempotent.
 * - Records are refresh-safe: read side can query by painId / taskId.
 * - Write failure fails loud with reason + nextAction.
 *
 * ERR checklist:
 * - EP-01 / ERR-001, ERR-005: enum fields validated via type guards, never `as`
 * - EP-03 / ERR-002: store failures surface reason, never silent
 * - EP-09: pure types — independently usable without I/O mocks
 */

import type {
  IntentTensionSource,
  EvidenceStrength,
  IntentRelatedField,
  SuggestedOwnerAction,
} from '../diagnostician/diag-rootcause-output.js';

/**
 * Durable record of an Owner decision on a surfaced intentTension.
 *
 * Per SPEC §21.7, this is the minimal auditable field set. `evidenceRefs`
 * MUST point to Pain Evidence, trace, Owner correction, or an INTENT field.
 */
export interface IntentDecisionRecord {
  id: string;
  painId?: string;
  taskId?: string;
  runId?: string;
  intentDocHash?: string;
  source: IntentTensionSource;
  evidenceStrength: EvidenceStrength;
  relatedIntentFields: IntentRelatedField[];
  ownerAction: SuggestedOwnerAction;
  evidenceRefs: string[];
  resultingCandidateId?: string;
  resultingRuleCandidateId?: string;
  patchProposalId?: string;
  createdAt: string;
}

/**
 * Input for creating an IntentDecisionRecord.
 *
 * `id` is caller-supplied so the Console API can return the canonical id
 * before persistence completes. `note` is an optional Owner free-text note
 * that the store persists alongside the decision.
 */
export interface IntentDecisionInput {
  id: string;
  painId?: string;
  taskId?: string;
  runId?: string;
  intentDocHash?: string;
  source: IntentTensionSource;
  evidenceStrength: EvidenceStrength;
  relatedIntentFields: IntentRelatedField[];
  ownerAction: SuggestedOwnerAction;
  evidenceRefs: string[];
  note?: string;
}

/**
 * Result of recording a decision.
 *
 * `created=false` means an idempotent hit — the same decision already exists
 * and `record` is the pre-existing record. Callers SHOULD return 200 (not 201)
 * in this case so clients can distinguish a fresh write from a replay.
 */
export interface IntentDecisionRecordResult {
  record: IntentDecisionRecord;
  created: boolean;
}

/**
 * Lightweight audit summary derived from IntentDecisionRecord (SPEC §22.1.1).
 *
 * `counts` holds a tally per SuggestedOwnerAction (every key is present,
 * defaulting to 0). `lastDecisionAt` is the most recent `createdAt` across
 * all records, or null when no records exist.
 */
export interface IntentDecisionSummary {
  counts: Record<SuggestedOwnerAction, number>;
  lastDecisionAt: string | null;
}

/**
 * Patch for updating follow-up action fields on an existing IntentDecisionRecord.
 * Used by PRI-471 to record which follow-up action was dispatched after the
 * Owner decision was persisted (SPEC §22.1.4).
 *
 * Only one field should be set per call — each follow-up type is independent.
 * Setting a field to `undefined` leaves it unchanged; the store only updates
 * fields that are explicitly provided.
 */
export interface FollowUpPatch {
  resultingCandidateId?: string;
  resultingRuleCandidateId?: string;
  patchProposalId?: string;
}

/**
 * Durable store contract for IntentDecisionRecord (SPEC §21.7 persistence).
 *
 * Implementations MUST:
 * - Be idempotent on (painId + intentDocHash + ownerAction) when painId is
 *   non-null; fall back to (taskId + intentDocHash + ownerAction) when painId
 *   is null.
 * - Store immutable snapshots of source / evidenceStrength /
 *   relatedIntentFields / evidenceRefs so the audit trail stays accurate even
 *   if the underlying artifact is later modified.
 * - Truncate evidence to max 3 items before storing.
 * - Fail loud (throw) on write failure — never return a silent "success".
 */
export interface IntentDecisionStore {
  record(input: IntentDecisionInput): Promise<IntentDecisionRecordResult>;
  getById(id: string): Promise<IntentDecisionRecord | null>;
  listByPainId(painId: string): Promise<IntentDecisionRecord[]>;
  listByTaskId(taskId: string): Promise<IntentDecisionRecord[]>;
  getSummary(): Promise<IntentDecisionSummary>;
  /**
   * Update follow-up action fields on an existing record (PRI-471, SPEC §22.1.4).
   * Returns the updated record, or null if the record does not exist.
   * Only fields present in `patch` are updated; others remain unchanged.
   */
  updateFollowUp(id: string, patch: FollowUpPatch): Promise<IntentDecisionRecord | null>;
}
