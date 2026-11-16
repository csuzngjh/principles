/**
 * Phase 7.2 B2 — Owner release of a persisted reuse park.
 *
 * The ONLY channel that may lift a candidate out of
 * `admission_json.processing = { state: 'awaiting_owner', blockedReason:
 * 'reuse_pending_owner' }` is an explicit Owner verdict
 * (`pd candidate review --decide reuse|create`). This helper makes that
 * release a DURABLE, audited fact on the candidate's admission document
 * BEFORE the verdict runs:
 *
 *   1. an append-only release evaluation record (appendAdmissionEvaluation)
 *      carrying operator, time, reason and the released park context;
 *   2. a processing transition awaiting_owner → complete.
 *
 * Ordering is crash-safe by construction: audit first, then the park clear,
 * then the verdict's intake. A crash after the audit but before intake leaves
 * the candidate pending with the release recorded — a re-run is idempotent
 * (same reason → same materialFingerprint+policyVersion → the append reuses
 * the existing entry). A release whose audit cannot be persisted FAILS LOUD:
 * the verdict must not proceed on an unaudited release (审计失败不得静默成功).
 *
 * Owner identity is the ADR-0022 resolver's verified identity
 * (env PD_OWNER_ID+PD_OWNER_CREDENTIAL_ID or ~/.pd/owner.json) resolved by the
 * caller — a CLI self-declaration alone is never recorded as the operator.
 */
import type { RuntimeStateManager } from '@principles/core/runtime';
import {
  fingerprintAdmissionMaterial,
  type AdmissionEvaluationRecord,
} from '@principles/core/runtime';

/**
 * Static policy identity for reuse-park release records. Distinct from the
 * full-gate ADMISSION_POLICY_VERSION on purpose: the append idempotency key
 * is (materialFingerprint, policyVersion), so a release record can never be
 * deduplicated against a full-gate evaluation, and a re-issued release with
 * the same Owner reason is an idempotent reuse.
 */
export const REUSE_PARK_RELEASE_POLICY_VERSION = 'reuse-park-release@1';

export type ReuseParkReleaseOutcome =
  | { status: 'no_park' }
  | { status: 'released'; evaluationId: string; reusedExistingEntry: boolean }
  | { status: 'failed'; reason: string; nextAction: string };

export interface ReleaseReuseParkArgs {
  stateManager: RuntimeStateManager;
  candidateId: string;
  decide: 'reuse' | 'create';
  /** Non-empty — the review command enforces --reason before calling. */
  reason: string;
  /** Verified Owner identity (ADR-0022 resolver) — never a bare CLI claim. */
  ownerId: string;
  identitySource: string;
  /** The candidate's raw persisted recommendation kind, for the record. */
  rawRecommendationKind: string | null;
}

/**
 * Release a persisted reuse park with a durable audit. Read-only when no park
 * exists (`no_park`) — a non-parked candidate keeps its existing review flow
 * untouched.
 */
export async function releaseReusePark(args: ReleaseReuseParkArgs): Promise<ReuseParkReleaseOutcome> {
  const { stateManager, candidateId, decide, reason, ownerId, identitySource, rawRecommendationKind } = args;

  const admission = await stateManager.getAdmissionDocument(candidateId);
  // An UNREADABLE admission document can never prove there is no park —
  // treating it as no_park would let an Owner verdict lift a (potentially
  // parked) candidate without the release audit this helper exists to write
  // (CodeRabbit: the create path refuses unreadable documents via the write
  // gate; the reuse path must not be the softer one). Fail closed.
  if (!admission.ok) {
    return {
      status: 'failed',
      reason: `admission document unreadable (${admission.reason}); cannot prove the reuse-park state, so the ${decide} verdict was NOT executed`,
      nextAction: 'inspect principle_candidates.admission_json for this candidate, repair the document, then re-run the decision',
    };
  }
  if (admission.document?.processing?.state !== 'awaiting_owner'
    || admission.document.processing.blockedReason !== 'reuse_pending_owner') {
    return { status: 'no_park' };
  }
  const releasedFrom = admission.document.processing;
  // The released park's own context travels INSIDE the audit record (and its
  // idempotency fingerprint): once processing is cleared below, these fields
  // exist nowhere else (CodeRabbit — the audit must preserve what it lifted).
  const parkContext = `park[blockedReason=${releasedFrom.blockedReason ?? 'unknown'},attempts=${releasedFrom.attempts},lastAttemptAt=${releasedFrom.lastAttemptAt ?? 'unknown'}]`;

  const materialFingerprint = fingerprintAdmissionMaterial([
    candidateId,
    'reuse-park-release',
    decide,
    reason,
    parkContext,
  ]);
  const evaluation: AdmissionEvaluationRecord = {
    evaluationId: `ae_${fingerprintAdmissionMaterial([candidateId, materialFingerprint, REUSE_PARK_RELEASE_POLICY_VERSION]).slice(0, 16)}`,
    decision: 'admitted',
    reason: `reuse-park release (${decide}) by Owner — released ${parkContext} — reason: ${reason}`,
    nextAction: decide === 'create'
      ? 'create the Principle via intake (Owner verdict)'
      : 'resolve onto the existing Principle via reuseEvidence (Owner verdict)',
    evaluatedAt: new Date().toISOString(),
    policyVersion: REUSE_PARK_RELEASE_POLICY_VERSION,
    provenance: `pd-candidate-review owner=${ownerId} source=${identitySource}`,
    // The release evaluates no new admission material — the Owner reviewed the
    // parked candidate — so the material counts are truthful zeros and the
    // released park context is carried in the reason/provenance.
    inputEvidenceCount: 0,
    ownerStatementPresent: false,
    recommendationKind: rawRecommendationKind ?? 'unknown',
    confidence: null,
    materialFingerprint,
    materialSummary: {
      inputEvidenceCount: 0,
      outputEvidenceCount: 0,
      ownerStatementPresent: false,
    },
  };

  const appended = await stateManager.appendAdmissionEvaluation(candidateId, evaluation);
  if (appended.status === 'refused') {
    return {
      status: 'failed',
      reason: `reuse-park release audit could not be persisted (${appended.reason}); the ${decide} verdict was NOT executed and the park is intact`,
      nextAction: 'inspect principle_candidates.admission_json for this candidate, repair the admission document, then re-run the decision',
    };
  }
  // The append (or idempotent reuse) moved currentEvaluationId onto the
  // release record — that is the durable audit entry's id.
  const evaluationId = appended.document.currentEvaluationId;
  if (evaluationId === null) {
    return {
      status: 'failed',
      reason: 'reuse-park release audit was persisted but the admission document reports no current evaluation; the verdict was NOT executed',
      nextAction: 'inspect principle_candidates.admission_json for this candidate, then re-run the decision',
    };
  }

  const cleared = await stateManager.updateAdmissionProcessing(candidateId, {
    state: 'complete',
    attempts: 0,
    completedAt: new Date().toISOString(),
  });
  if (!cleared) {
    return {
      status: 'failed',
      reason: `reuse-park release audit was persisted but the park (awaiting_owner since ${releasedFrom.lastAttemptAt ?? 'unknown'}) could not be cleared; the ${decide} verdict was NOT executed`,
      nextAction: 'inspect principle_candidates.admission_json for this candidate; the release record is durable, re-run the decision after repairing the row',
    };
  }

  return {
    status: 'released',
    evaluationId,
    reusedExistingEntry: appended.status === 'reused',
  };
}
