/**
 * Phase 7.2 P1-01 — recoverable Owner decision lifecycle (pd-cli service).
 *
 * The OLD flow (B2) released the park FIRST — audit + processing complete —
 * and only then ran the verdict's intake. A crash in between left the
 * candidate unparked with no ledger/evidence write and no structured decision
 * state: only prose in the release audit's reason. The Owner had to re-decide
 * from scratch and nothing could prove whether the previous verdict had
 * taken effect.
 *
 * The NEW three-phase flow closes every crash window (directive §2.3):
 *
 *   Phase A — recordOwnerDecisionIntent: after Owner identity verification and
 *   INV-R08 proposal validation, persist a TYPED, append-only Owner decision
 *   record (executionStatus 'pending'). The park is deliberately NOT cleared.
 *   A re-run with the same verdict RESUMES the same record (stable
 *   decisionId); a different verdict supersedes a still-pending intent ONLY
 *   when that intent is provably unexecuted.
 *
 *   Phase B — the verdict executes through CandidateIntakeService.intake with
 *   { ownerDecision: { decisionId } }: the service re-verifies the persisted
 *   pending record under the per-candidate coordination lock (P1-02), so a
 *   bare injected callback is never Owner authorization (P1-03), replays are
 *   idempotent by decisionId, and a crash between B and C resumes exactly
 *   where it stopped.
 *
 *   Phase C — completeOwnerDecisionExecution: ONE transactional admission
 *   write marks the decision applied (resultingPrincipleId), appends the
 *   reuse-park release audit (reuse-park-release@1) when a park was lifted,
 *   and transitions processing to complete. The park can never be cleared
 *   while the decision still reads pending (or the reverse).
 *
 * Owner identity is the ADR-0022 resolver's verified identity resolved by the
 * caller — a CLI self-declaration alone is never recorded as the operator.
 */
import type { RuntimeStateManager } from '@principles/core/runtime';
import {
  appliedOwnerDecision,
  buildOwnerDecisionIntent,
  fingerprintAdmissionMaterial,
  pendingOwnerDecision,
  type AdmissionEvaluationRecord,
  type CandidateAdmissionDocument,
  type OwnerDecisionRecord,
} from '@principles/core/runtime';

/**
 * Static policy identity for reuse-park release records. Distinct from the
 * full-gate ADMISSION_POLICY_VERSION on purpose: the append idempotency key
 * is (materialFingerprint, policyVersion), so a release record can never be
 * deduplicated against a full-gate evaluation, and a re-issued release with
 * the same Owner reason is an idempotent reuse.
 */
export const REUSE_PARK_RELEASE_POLICY_VERSION = 'reuse-park-release@1';

function parkPresent(document: CandidateAdmissionDocument | null | undefined): boolean {
  return document?.processing?.state === 'awaiting_owner'
    && document.processing.blockedReason === 'reuse_pending_owner';
}

function parkFingerprintOf(document: CandidateAdmissionDocument | null | undefined): string | undefined {
  const park = document?.processing;
  if (!parkPresent(document) || park === undefined) return undefined;
  return fingerprintAdmissionMaterial([
    'reuse-park',
    String(park.attempts),
    park.lastAttemptAt ?? 'unknown',
    park.blockedReason ?? 'unknown',
  ]);
}

/**
 * Build the release audit evaluation for a park being lifted in Phase C. The
 * released park's own context travels INSIDE the record (and its idempotency
 * fingerprint): once processing is cleared, these fields exist nowhere else.
 */
export function buildReuseParkReleaseEvaluation(input: {
  candidateId: string;
  decide: 'reuse' | 'create';
  reason: string;
  ownerId: string;
  identitySource: string;
  rawRecommendationKind: string | null;
  park: { blockedReason?: string; attempts: number; lastAttemptAt?: string };
}): AdmissionEvaluationRecord {
  const parkContext = `park[blockedReason=${input.park.blockedReason ?? 'unknown'},attempts=${input.park.attempts},lastAttemptAt=${input.park.lastAttemptAt ?? 'unknown'}]`;
  const materialFingerprint = fingerprintAdmissionMaterial([
    input.candidateId,
    'reuse-park-release',
    input.decide,
    input.reason,
    parkContext,
  ]);
  return {
    evaluationId: `ae_${fingerprintAdmissionMaterial([input.candidateId, materialFingerprint, REUSE_PARK_RELEASE_POLICY_VERSION]).slice(0, 16)}`,
    decision: 'admitted',
    reason: `reuse-park release (${input.decide}) by Owner — released ${parkContext} — reason: ${input.reason}`,
    nextAction: input.decide === 'create'
      ? 'create the Principle via intake (Owner verdict)'
      : 'resolve onto the existing Principle via reuseEvidence (Owner verdict)',
    evaluatedAt: new Date().toISOString(),
    policyVersion: REUSE_PARK_RELEASE_POLICY_VERSION,
    provenance: `pd-candidate-review owner=${input.ownerId} source=${input.identitySource}`,
    // The release evaluates no new admission material — the Owner reviewed the
    // parked candidate — so the material counts are truthful zeros and the
    // released park context is carried in the reason/provenance.
    inputEvidenceCount: 0,
    ownerStatementPresent: false,
    recommendationKind: input.rawRecommendationKind ?? 'unknown',
    confidence: null,
    materialFingerprint,
    materialSummary: {
      inputEvidenceCount: 0,
      outputEvidenceCount: 0,
      ownerStatementPresent: false,
    },
  };
}

export type RecordOwnerDecisionOutcome =
  | { status: 'recorded'; decision: OwnerDecisionRecord; resumed: boolean; supersededPrevious?: string }
  /** Re-run after the SAME decision already completed — report, do not re-execute. */
  | { status: 'already_applied'; decision: OwnerDecisionRecord }
  | { status: 'failed'; reason: string; nextAction: string };

/** The ledger probes that prove whether a pending intent already executed. */
export interface OwnerDecisionExecutionProbe {
  findReuseResolutionForCandidate(candidateId: string): { principleId: string } | null;
  existsForCandidate(candidateId: string): { id: string } | null;
}

/**
 * Phase A — persist (or idempotently resume) the Owner decision INTENT. The
 * park is NOT cleared. Callers must have verified the Owner identity and
 * validated the reuse selection (INV-R08) BEFORE this call.
 */
export async function recordOwnerDecisionIntent(args: {
  stateManager: RuntimeStateManager;
  executionProbe: OwnerDecisionExecutionProbe;
  candidateId: string;
  decide: 'reuse' | 'create';
  reason: string;
  ownerId: string;
  identitySource: string;
  rawRecommendationKind: string | null;
  selectedPrincipleId?: string;
}): Promise<RecordOwnerDecisionOutcome> {
  const { stateManager, executionProbe, candidateId, decide, reason, ownerId, identitySource } = args;

  const admission = await stateManager.getAdmissionDocument(candidateId);
  // An UNREADABLE admission document can never prove the decision state —
  // recording an intent over it would park the verdict on unknown ground.
  // Fail closed (CodeRabbit: same posture as the old release path).
  if (!admission.ok) {
    return {
      status: 'failed',
      reason: `admission document unreadable (${admission.reason}); cannot verify the decision state, so the ${decide} intent was NOT recorded`,
      nextAction: 'inspect principle_candidates.admission_json for this candidate, repair the document, then re-run the decision',
    };
  }

  const document = admission.document ?? null;
  const intent = buildOwnerDecisionIntent({
    candidateId,
    decision: decide,
    ...(decide === 'reuse' ? { selectedPrincipleId: args.selectedPrincipleId } : {}),
    ownerId,
    identitySource,
    reason,
    parkFingerprint: parkFingerprintOf(document),
  });

  // Same intent already completed → idempotent re-run: report the applied
  // record; Phase B/C are skipped by the caller.
  const appliedSame = appliedOwnerDecision(document);
  if (appliedSame !== null && appliedSame.decisionId === intent.decisionId) {
    return { status: 'already_applied', decision: appliedSame };
  }

  // A DIFFERENT pending intent may only be superseded when it provably never
  // executed (directive §2.2: never require the Owner to re-choose a recorded
  // verdict, and never leave a half-executed one behind).
  const pending = pendingOwnerDecision(document);
  if (pending !== null && (pending.decision !== decide || pending.selectedPrincipleId !== args.selectedPrincipleId)) {
    const executed = pending.decision === 'reuse'
      ? executionProbe.findReuseResolutionForCandidate(candidateId) !== null
      : executionProbe.existsForCandidate(candidateId) !== null;
    if (executed) {
      return {
        status: 'failed',
        reason: `a pending ${pending.decision} decision (${pending.decisionId}) already executed its ${pending.decision === 'reuse' ? 'reuseEvidence' : 'ledger entry'} but did not complete; superseding it now would create conflicting authorities`,
        nextAction: `re-run the SAME ${pending.decision} verdict to complete the recorded decision, then decide again if still needed`,
      };
    }
  }

  const recorded = await stateManager.recordOwnerDecision(candidateId, intent);
  if (recorded.status === 'refused') {
    return {
      status: 'failed',
      reason: `owner decision intent could not be persisted (${recorded.reason}); the ${decide} verdict was NOT executed and the candidate state is intact`,
      nextAction: 'inspect principle_candidates.admission_json for this candidate, repair the document, then re-run the decision',
    };
  }
  return {
    status: 'recorded',
    decision: recorded.decision,
    resumed: recorded.status === 'resumed',
    ...(recorded.status === 'superseded' ? { supersededPrevious: recorded.supersededDecisionId } : {}),
  };
}

export type CompleteOwnerDecisionOutcome =
  | { status: 'completed' }
  | { status: 'already_completed' }
  | { status: 'failed'; reason: string; nextAction: string };

/**
 * Phase C — atomically finalize the executed decision: applied + release
 * audit (when a park was lifted) + processing complete, in ONE admission
 * write. `already_completed` is the idempotent re-run (crash after
 * completion, lost response): the caller reports the completed result.
 */
export async function completeOwnerDecisionExecution(args: {
  stateManager: RuntimeStateManager;
  candidateId: string;
  decision: OwnerDecisionRecord;
  resultingPrincipleId: string;
  ownerId: string;
  identitySource: string;
  rawRecommendationKind: string | null;
}): Promise<CompleteOwnerDecisionOutcome> {
  const { stateManager, candidateId, decision } = args;

  const admission = await stateManager.getAdmissionDocument(candidateId);
  if (!admission.ok) {
    return {
      status: 'failed',
      reason: `admission document unreadable (${admission.reason}); the decision's ledger side is durable but the completion could not be recorded`,
      nextAction: 'inspect principle_candidates.admission_json for this candidate; re-running the SAME verdict resumes Phase C idempotently',
    };
  }

  // The release audit exists ONLY when this decision actually lifted a park.
  let releaseEvaluation: AdmissionEvaluationRecord | undefined;
  if (parkPresent(admission.document ?? null)) {
    const park = admission.document?.processing;
    if (park !== undefined) {
      releaseEvaluation = buildReuseParkReleaseEvaluation({
        candidateId,
        decide: decision.decision,
        reason: decision.reason,
        ownerId: args.ownerId,
        identitySource: args.identitySource,
        rawRecommendationKind: args.rawRecommendationKind,
        park: { blockedReason: park.blockedReason, attempts: park.attempts, lastAttemptAt: park.lastAttemptAt },
      });
    }
  }

  const completed = await stateManager.completeOwnerDecision(candidateId, decision.decisionId, {
    resultingPrincipleId: args.resultingPrincipleId,
    ...(releaseEvaluation !== undefined ? { releaseEvaluation } : {}),
  });
  if (completed.status === 'refused') {
    return {
      status: 'failed',
      reason: `owner decision completion could not be persisted (${completed.reason}); the decision's ledger side is durable and the decision stays pending`,
      nextAction: 'inspect principle_candidates.admission_json for this candidate; re-running the SAME verdict resumes Phase C idempotently',
    };
  }
  return completed.status === 'completed'
    ? { status: 'completed' }
    : { status: 'already_completed' };
}
