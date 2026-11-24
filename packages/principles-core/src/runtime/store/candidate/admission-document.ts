/**
 * Candidate admission document — SPEC-CODEX-PAIN-CLOSURE-001 CR-03 (PRI-958).
 *
 * The persisted admission disposition of a principle candidate, owned by the
 * candidate store (`principle_candidates.admission_json`). Structure:
 *
 *   - `evaluations`: APPEND-ONLY history of full-gate evaluations. A
 *     re-evaluation with the same material fingerprint + policy version
 *     reuses the existing entry (idempotent); genuinely new material or
 *     policy appends a new version and moves `currentEvaluationId`. Old
 *     decisions are never overwritten (A15: history stays queryable).
 *   - `currentEvaluationId`: pointer to the evaluation that governs intake
 *     eligibility right now.
 *   - `processing`: an INDEPENDENT progress domain (worker continuation
 *     attempts / next-retry / blocked state). It never mutates admission
 *     history; history never claims processing completed.
 *
 * This is NOT an approval fact and does not replace the Ledger / approval /
 * activation authorities — it records "what the admission gate decided, on
 * which material, when". Telemetry and console read it; they do not write it.
 *
 * No Owner statement text is ever copied into this document — only a
 * fingerprint of the statement content (classification summary).
 */
import { createHash } from 'node:crypto';

export const CANDIDATE_ADMISSION_SCHEMA_VERSION = 1;
export const MAX_ADMISSION_EVALUATIONS = 20;
export const MAX_ADMISSION_JSON_CHARS = 96_000;
/** Static policy identity of the current full admission gate. */
export const ADMISSION_POLICY_VERSION = 'admission-gate@cr-03';
/** Static policy identity for typed Owner decision records (Phase 7.2 P1-01). */
export const OWNER_DECISION_POLICY_VERSION = 'owner-decision@1';
/** Bounded Owner decision history — decisions are rare (human-paced). */
export const MAX_OWNER_DECISIONS = 10;
/** Bounded append-only audit history for explicit invalid-kind recovery. */
export const MAX_POST_PROCESSING_RECOVERIES = 10;
export const POST_PROCESSING_RECOVERY_POLICY_VERSION = 'candidate-post-processing-recovery@1';

type AdmissionDecisionValue = 'admitted' | 'needs_evidence' | 'deferred';

export interface AdmissionEvaluationRecord {
  evaluationId: string;
  decision: AdmissionDecisionValue;
  reason: string;
  nextAction: string;
  evaluatedAt: string;
  policyVersion: string;
  provenance: string;
  inputEvidenceCount: number;
  ownerStatementPresent: boolean;
  recommendationKind: string;
  confidence: number | null;
  /** sha256 over the diagnostic output + input material identity (never raw text). */
  materialFingerprint: string;
  /** Classification summary of the evaluated material (no Owner text). */
  materialSummary: {
    inputEvidenceCount: number;
    outputEvidenceCount: number;
    ownerStatementPresent: boolean;
    /** sha256 of the Owner statement content when one was part of the material. */
    statementFingerprint?: string;
  };
}

export type AdmissionProcessingState = 'not_started' | 'in_progress' | 'awaiting_owner' | 'complete' | 'exhausted';

export interface AdmissionProcessingRecord {
  state: AdmissionProcessingState;
  attempts: number;
  lastAttemptAt?: string;
  lastFailure?: { reason: string; nextAction: string; at: string };
  nextRetryAt?: string;
  completedAt?: string;
  /** Bounded structured blocker when state is 'awaiting_owner' or 'exhausted'. */
  blockedReason?: string;
}

/**
 * Phase 7.2 P1-01 — TYPED, append-only Owner decision record. The durable
 * authority for an Owner verdict on a candidate (`pd candidate review
 * --decide reuse|create`), replacing "park released first, verdict ran later,
 * only prose audit in between" — a crash between release and execution
 * previously lost the decision.
 *
 * Lifecycle: `pending` (intent persisted, park NOT cleared) → `applied`
 * (ledger evidence/entry durable, Phase C) — or `superseded` when the Owner
 * issues a DIFFERENT verdict while the previous intent is still pending and
 * provably unexecuted. Applied decisions are history: never rewritten.
 */
export type OwnerDecisionValue = 'reuse' | 'create';
export type OwnerDecisionExecutionStatus = 'pending' | 'applied' | 'superseded';

export interface OwnerDecisionRecord {
  /** Stable across idempotent re-runs: hash of candidate+verdict+selection+owner+reason. */
  decisionId: string;
  candidateId: string;
  decision: OwnerDecisionValue;
  /** Required for `reuse`: the principle the Owner selected from the proposal. */
  selectedPrincipleId?: string;
  /** Verified Owner identity (ADR-0022 resolver) — never a bare CLI claim. */
  ownerId: string;
  identitySource: string;
  /** Non-empty — the review command enforces --reason. */
  reason: string;
  decidedAt: string;
  /** Fingerprint of the park context at record time, when the candidate was parked. */
  parkFingerprint?: string;
  executionStatus: OwnerDecisionExecutionStatus;
  policyVersion: string;
  /** Set by Phase C. For `reuse` the selected principle; for `create` the surviving ledger entry (B1 dedup may redirect). */
  resultingPrincipleId?: string;
  executedAt?: string;
  supersededByDecisionId?: string;
}

export interface CandidatePostProcessingRecoveryRecord {
  recoveryId: string;
  candidateId: string;
  rawRecommendationKind: 'principle' | 'rule' | 'prompt';
  priorBlockedReason: string;
  /** Original failure timestamp used to distinguish later recovery attempts. */
  priorFailureAt: string | null;
  ownerId: string;
  identitySource: string;
  reason: string;
  authorizedAt: string;
  policyVersion: string;
}

export interface CandidatePostProcessingRecoveryInput {
  ownerId: string;
  identitySource: string;
  reason: string;
  authorizedAt: string;
}

export type CandidatePostProcessingRecoveryResult =
  | { status: 'authorized' | 'already_authorized'; document: CandidateAdmissionDocument; recovery: CandidatePostProcessingRecoveryRecord }
  | { status: 'refused'; reason: string };

export interface CandidateAdmissionDocument {
  schemaVersion: typeof CANDIDATE_ADMISSION_SCHEMA_VERSION;
  evaluations: AdmissionEvaluationRecord[];
  currentEvaluationId: string | null;
  processing?: AdmissionProcessingRecord;
  /** Phase 7.2 P1-01 — append-only Owner decision history (oldest first). */
  ownerDecisions?: OwnerDecisionRecord[];
  /** Owner-authorized recovery audit; never cleared by processing transitions. */
  postProcessingRecoveries?: CandidatePostProcessingRecoveryRecord[];
}

type ParseAdmissionDocumentResult =
  | { ok: true; document: CandidateAdmissionDocument | null }
  | { ok: false; document: null; reason: string };

export function parseAdmissionDocument(raw: unknown): ParseAdmissionDocumentResult {
  if (raw === null || raw === undefined) return { ok: true, document: null };
  if (typeof raw !== 'string' || raw.length === 0) return { ok: true, document: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, document: null, reason: 'admission_json_unparseable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, document: null, reason: 'admission_json_not_an_object' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.schemaVersion !== CANDIDATE_ADMISSION_SCHEMA_VERSION) {
    return { ok: false, document: null, reason: `admission_json_unsupported_schema_version:${String(record.schemaVersion)}` };
  }
  if (!Array.isArray(record.evaluations) || record.evaluations.length > MAX_ADMISSION_EVALUATIONS) {
    return { ok: false, document: null, reason: 'admission_json_evaluations_invalid' };
  }
  for (const evaluation of record.evaluations) {
    if (typeof evaluation !== 'object' || evaluation === null) return { ok: false, document: null, reason: 'admission_json_evaluation_invalid' };
    const entry = evaluation as Record<string, unknown>;
    if (typeof entry.evaluationId !== 'string'
      || (entry.decision !== 'admitted' && entry.decision !== 'needs_evidence' && entry.decision !== 'deferred')
      || typeof entry.reason !== 'string' || typeof entry.nextAction !== 'string'
      || typeof entry.evaluatedAt !== 'string' || typeof entry.policyVersion !== 'string'
      || typeof entry.materialFingerprint !== 'string') {
      return { ok: false, document: null, reason: 'admission_json_evaluation_invalid' };
    }
  }
  const currentId = record.currentEvaluationId;
  if (currentId !== null && typeof currentId !== 'string') {
    return { ok: false, document: null, reason: 'admission_json_current_evaluation_id_invalid' };
  }
  const {processing} = record;
  if (processing !== undefined
    && (typeof processing !== 'object' || processing === null || typeof (processing as Record<string, unknown>).state !== 'string')) {
    return { ok: false, document: null, reason: 'admission_json_processing_invalid' };
  }
  // Phase 7.2 P1-01 — ownerDecisions is optional (older documents predate it)
  // but, when present, every record must carry the typed lifecycle minimum;
  // a malformed decision history fails the WHOLE document (rc-3 fail-closed:
  // an unreadable decision record must never read as "no decision").
  const {ownerDecisions} = record;
  if (ownerDecisions !== undefined) {
    if (!Array.isArray(ownerDecisions) || ownerDecisions.length > MAX_OWNER_DECISIONS) {
      return { ok: false, document: null, reason: 'admission_json_owner_decisions_invalid' };
    }
    for (const decision of ownerDecisions) {
      if (typeof decision !== 'object' || decision === null) {
        return { ok: false, document: null, reason: 'admission_json_owner_decision_invalid' };
      }
      const entry = decision as Record<string, unknown>;
      if (typeof entry.decisionId !== 'string' || entry.decisionId === ''
        || typeof entry.candidateId !== 'string' || entry.candidateId === ''
        || (entry.decision !== 'reuse' && entry.decision !== 'create')
        || (entry.decision === 'reuse' && (typeof entry.selectedPrincipleId !== 'string' || entry.selectedPrincipleId === ''))
        || typeof entry.ownerId !== 'string' || entry.ownerId === ''
        || typeof entry.identitySource !== 'string' || entry.identitySource === ''
        || typeof entry.reason !== 'string' || entry.reason === ''
        || typeof entry.decidedAt !== 'string'
        || (entry.executionStatus !== 'pending' && entry.executionStatus !== 'applied' && entry.executionStatus !== 'superseded')
        || typeof entry.policyVersion !== 'string') {
        return { ok: false, document: null, reason: 'admission_json_owner_decision_invalid' };
      }
    }
  }
  const {postProcessingRecoveries} = record;
  if (postProcessingRecoveries !== undefined) {
    if (!Array.isArray(postProcessingRecoveries) || postProcessingRecoveries.length > MAX_POST_PROCESSING_RECOVERIES) {
      return { ok: false, document: null, reason: 'admission_json_post_processing_recoveries_invalid' };
    }
    for (const recovery of postProcessingRecoveries) {
      if (typeof recovery !== 'object' || recovery === null) {
        return { ok: false, document: null, reason: 'admission_json_post_processing_recovery_invalid' };
      }
      const entry = recovery as Record<string, unknown>;
      if (typeof entry.recoveryId !== 'string' || entry.recoveryId === ''
        || typeof entry.candidateId !== 'string' || entry.candidateId === ''
        || (entry.rawRecommendationKind !== 'principle' && entry.rawRecommendationKind !== 'rule' && entry.rawRecommendationKind !== 'prompt')
        || typeof entry.priorBlockedReason !== 'string' || !entry.priorBlockedReason.startsWith('candidate_kind_invalid')
        || !(entry.priorFailureAt === null || (typeof entry.priorFailureAt === 'string' && Number.isFinite(Date.parse(entry.priorFailureAt))))
        || typeof entry.ownerId !== 'string' || entry.ownerId === ''
        || typeof entry.identitySource !== 'string' || entry.identitySource === ''
        || typeof entry.reason !== 'string' || entry.reason.trim() === '' || entry.reason.length > 500
        || typeof entry.authorizedAt !== 'string' || !Number.isFinite(Date.parse(entry.authorizedAt))
        || entry.policyVersion !== POST_PROCESSING_RECOVERY_POLICY_VERSION) {
        return { ok: false, document: null, reason: 'admission_json_post_processing_recovery_invalid' };
      }
    }
  }
  return {
    ok: true,
    document: {
      schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
      evaluations: record.evaluations as AdmissionEvaluationRecord[],
      currentEvaluationId: currentId ?? null,
      ...(processing !== undefined ? { processing: processing as AdmissionProcessingRecord } : {}),
      ...(ownerDecisions !== undefined ? { ownerDecisions: ownerDecisions as OwnerDecisionRecord[] } : {}),
      ...(postProcessingRecoveries !== undefined ? { postProcessingRecoveries: postProcessingRecoveries as CandidatePostProcessingRecoveryRecord[] } : {}),
    },
  };
}

/**
 * Explicitly authorize recovery of a candidate parked ONLY because its raw
 * kind was invalid. This never lifts a real Owner/reuse park. The caller
 * (CLI) must supply an ADR-0022-resolved Owner identity and an explicit reason;
 * the store persists this audit and the existing `in_progress` state together.
 */
export function authorizeInvalidKindPostProcessingRecovery(
  existing: CandidateAdmissionDocument | null,
  candidateId: string,
  rawKind: 'principle' | 'rule' | 'prompt',
  input: CandidatePostProcessingRecoveryInput,
): CandidatePostProcessingRecoveryResult {
  const processing = existing?.processing;
  if (existing === null || processing === undefined) return { status: 'refused', reason: 'admission_processing_missing' };

  const ownerId = input.ownerId.trim();
  const identitySource = input.identitySource.trim();
  const reason = input.reason.trim();
  if (ownerId === '' || identitySource === '' || reason === '' || reason.length > 500) {
    return { status: 'refused', reason: 'verified_owner_identity_and_reason_required' };
  }
  if (!Number.isFinite(Date.parse(input.authorizedAt))) {
    return { status: 'refused', reason: 'recovery_authorized_at_invalid' };
  }

  // Idempotency must be checked BEFORE the awaiting_owner guard. The first
  // authorization atomically changes processing.state to in_progress; after
  // worker completion the candidate row may also be consumed. Preserve the
  // original blocker + failure timestamp in the audit so the same request can
  // be recognized without reopening or rewriting its durable state.
  const history = existing.postProcessingRecoveries ?? [];
  const previous = history.find((entry) => {
    const expectedId = 'cpr_' + fingerprintMaterial([
      candidateId,
      rawKind,
      entry.priorBlockedReason,
      entry.priorFailureAt ?? '',
      ownerId,
      identitySource,
      reason,
      POST_PROCESSING_RECOVERY_POLICY_VERSION,
    ]).slice(0, 24);
    return entry.recoveryId === expectedId
      && entry.candidateId === candidateId
      && entry.rawRecommendationKind === rawKind
      && entry.ownerId === ownerId
      && entry.identitySource === identitySource
      && entry.reason === reason
      && entry.policyVersion === POST_PROCESSING_RECOVERY_POLICY_VERSION;
  });
  if (previous !== undefined) {
    if (processing.state === 'in_progress' || processing.state === 'complete') {
      return { status: 'already_authorized', document: existing, recovery: previous };
    }
    return { status: 'refused', reason: 'recovery_audit_state_inconsistent' };
  }

  if (processing.state !== 'awaiting_owner') {
    return { status: 'refused', reason: 'processing_state_not_invalid_kind_park:' + processing.state };
  }
  const priorBlockedReason = processing.blockedReason ?? '';
  if (!priorBlockedReason.startsWith('candidate_kind_invalid')) {
    return { status: 'refused', reason: 'processing_not_blocked_by_invalid_raw_kind' };
  }
  if (pendingOwnerDecision(existing) !== null || priorBlockedReason === 'reuse_pending_owner') {
    return { status: 'refused', reason: 'owner_decision_pending_recovery_forbidden' };
  }

  const candidateFailureAt = processing.lastFailure?.at;
  const priorFailureAt = typeof candidateFailureAt === 'string' && Number.isFinite(Date.parse(candidateFailureAt))
    ? candidateFailureAt
    : null;
  const recoveryId = 'cpr_' + fingerprintMaterial([
    candidateId,
    rawKind,
    priorBlockedReason,
    priorFailureAt ?? '',
    ownerId,
    identitySource,
    reason,
    POST_PROCESSING_RECOVERY_POLICY_VERSION,
  ]).slice(0, 24);
  if (history.length >= MAX_POST_PROCESSING_RECOVERIES) {
    return { status: 'refused', reason: 'post_processing_recovery_history_exceeded' };
  }
  const recovery: CandidatePostProcessingRecoveryRecord = {
    recoveryId,
    candidateId,
    rawRecommendationKind: rawKind,
    priorBlockedReason,
    priorFailureAt,
    ownerId,
    identitySource,
    reason,
    authorizedAt: input.authorizedAt,
    policyVersion: POST_PROCESSING_RECOVERY_POLICY_VERSION,
  };
  const document: CandidateAdmissionDocument = {
    ...existing,
    postProcessingRecoveries: [...history, recovery],
    processing: {
      ...processing,
      state: 'in_progress',
      nextRetryAt: input.authorizedAt,
      blockedReason: 'candidate_kind_invalid_recovery_authorized',
    },
  };
  return { status: 'authorized', document, recovery };
}

export function serializeAdmissionDocument(document: CandidateAdmissionDocument): { ok: true; json: string } | { ok: false; reason: string } {
  const json = JSON.stringify(document);
  if (json.length > MAX_ADMISSION_JSON_CHARS) return { ok: false, reason: 'admission_json_size_exceeded' };
  return { ok: true, json };
}

export function fingerprintMaterial(parts: readonly string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

export function fingerprintStatement(statementText: string): string {
  return createHash('sha256').update(statementText).digest('hex');
}

type AppendAdmissionEvaluationResult =
  | { status: 'appended'; document: CandidateAdmissionDocument; evaluation: AdmissionEvaluationRecord }
  | { status: 'reused'; document: CandidateAdmissionDocument; evaluation: AdmissionEvaluationRecord }
  | { status: 'refused'; reason: string };

/**
 * Append (or idempotently reuse) one full-gate evaluation. Reuse requires the
 * same material fingerprint AND policy version — a changed material or policy
 * MUST produce a new version; the previous decision/reason/evaluatedAt stay
 * intact in history and `currentEvaluationId` moves forward only.
 */
export function appendAdmissionEvaluation(
  existing: CandidateAdmissionDocument | null,
  evaluation: AdmissionEvaluationRecord,
): AppendAdmissionEvaluationResult {
  if (existing === null) {
    const document: CandidateAdmissionDocument = {
      schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
      evaluations: [evaluation],
      currentEvaluationId: evaluation.evaluationId,
    };
    return { status: 'appended', document, evaluation };
  }
  const reused = existing.evaluations.find((entry) => entry.materialFingerprint === evaluation.materialFingerprint && entry.policyVersion === evaluation.policyVersion);
  if (reused !== undefined) {
    const document: CandidateAdmissionDocument = { ...existing, currentEvaluationId: reused.evaluationId };
    return { status: 'reused', document, evaluation: reused };
  }
  if (existing.evaluations.length >= MAX_ADMISSION_EVALUATIONS) {
    return { status: 'refused', reason: 'admission_history_exceeded' };
  }
  const document: CandidateAdmissionDocument = {
    ...existing,
    evaluations: [...existing.evaluations, evaluation],
    currentEvaluationId: evaluation.evaluationId,
  };
  return { status: 'appended', document, evaluation };
}

export function currentEvaluation(document: CandidateAdmissionDocument | null): AdmissionEvaluationRecord | null {
  if (document === null || document.currentEvaluationId === null) return null;
  return document.evaluations.find((entry) => entry.evaluationId === document.currentEvaluationId) ?? null;
}

export function withProcessing(document: CandidateAdmissionDocument | null, processing: AdmissionProcessingRecord): CandidateAdmissionDocument {
  if (document === null) {
    return {
      schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
      evaluations: [],
      currentEvaluationId: null,
      processing,
    };
  }
  return { ...document, processing };
}

// ---------------------------------------------------------------------------
// Phase 7.2 P1-01 — Owner decision lifecycle (pure transitions; the store
// wraps them in BEGIN IMMEDIATE read-modify-write transactions).
// ---------------------------------------------------------------------------

/** The decisionId for an intent — stable across idempotent re-runs. */
export function ownerDecisionId(parts: {
  candidateId: string;
  decision: OwnerDecisionValue;
  selectedPrincipleId?: string;
  ownerId: string;
  reason: string;
}): string {
  return `od_${fingerprintMaterial([
    parts.candidateId,
    parts.decision,
    parts.selectedPrincipleId ?? '',
    parts.ownerId,
    parts.reason,
    OWNER_DECISION_POLICY_VERSION,
  ]).slice(0, 24)}`;
}

/**
 * Build a Phase A INTENT record from verified Owner input. Pure: assigns the
 * stable decisionId, stamps the policy version, and validates the reuse shape
 * (a reuse verdict without a selection is a caller bug, not a persistable
 * intent — rc-3 fail loud).
 */
export function buildOwnerDecisionIntent(input: {
  candidateId: string;
  decision: OwnerDecisionValue;
  selectedPrincipleId?: string;
  ownerId: string;
  identitySource: string;
  reason: string;
  parkFingerprint?: string;
  decidedAt?: string;
}): OwnerDecisionRecord {
  if (input.decision === 'reuse' && (typeof input.selectedPrincipleId !== 'string' || input.selectedPrincipleId === '')) {
    throw new Error('buildOwnerDecisionIntent: a reuse intent requires selectedPrincipleId');
  }
  if (input.reason.trim() === '') {
    throw new Error('buildOwnerDecisionIntent: reason must be non-empty');
  }
  return {
    decisionId: ownerDecisionId(input),
    candidateId: input.candidateId,
    decision: input.decision,
    ...(input.decision === 'reuse' ? { selectedPrincipleId: input.selectedPrincipleId } : {}),
    ownerId: input.ownerId,
    identitySource: input.identitySource,
    reason: input.reason,
    decidedAt: input.decidedAt ?? new Date().toISOString(),
    ...(input.parkFingerprint !== undefined ? { parkFingerprint: input.parkFingerprint } : {}),
    executionStatus: 'pending',
    policyVersion: OWNER_DECISION_POLICY_VERSION,
  };
}

/** The newest decision still in `pending` (the executable intent), if any. */
export function pendingOwnerDecision(document: CandidateAdmissionDocument | null): OwnerDecisionRecord | null {
  if (!document?.ownerDecisions?.length) return null;
  const pending = document.ownerDecisions.filter((d) => d.executionStatus === 'pending');
  return pending.at(-1) ?? null;
}

/** The newest `applied` decision, if any (the completed governing verdict). */
export function appliedOwnerDecision(document: CandidateAdmissionDocument | null): OwnerDecisionRecord | null {
  if (!document?.ownerDecisions?.length) return null;
  const applied = document.ownerDecisions.filter((d) => d.executionStatus === 'applied');
  return applied.at(-1) ?? null;
}

type RecordOwnerDecisionResult =
  | { status: 'appended'; document: CandidateAdmissionDocument; decision: OwnerDecisionRecord }
  | { status: 'resumed'; document: CandidateAdmissionDocument; decision: OwnerDecisionRecord }
  | { status: 'superseded'; document: CandidateAdmissionDocument; decision: OwnerDecisionRecord; supersededDecisionId: string }
  | { status: 'refused'; reason: string };

/**
 * Phase A — persist (or idempotently resume) an Owner decision INTENT. The
 * park is deliberately NOT touched here; it is cleared only by
 * {@link completeOwnerDecision} after the execution is durable.
 *
 * `resumed` — the identical intent (same decisionId: same candidate, verdict,
 * selection, owner, reason) is already pending: a re-run after a crash must
 * not re-ask the Owner and must not duplicate the record.
 * `superseded` — a DIFFERENT intent is pending. Superseding is safe only when
 * the old intent is provably unexecuted; the CALLER owns that proof (the CLI
 * checks the ledger for the old verdict's artifacts before calling with a
 * differing intent). Applied decisions are never superseded — a differing new
 * intent after an applied one is simply a new record.
 */
export function recordOwnerDecision(
  existing: CandidateAdmissionDocument | null,
  intent: OwnerDecisionRecord,
): RecordOwnerDecisionResult {
  if (intent.executionStatus !== 'pending') {
    return { status: 'refused', reason: 'owner_decision_intent_must_be_pending' };
  }
  const decisions = existing?.ownerDecisions ?? [];
  const byId = decisions.find((d) => d.decisionId === intent.decisionId);
  if (byId !== undefined) {
    if (byId.executionStatus === 'pending' && existing !== null) {
      return { status: 'resumed', document: existing, decision: byId };
    }
    // Same id but no longer pending — the intent already ran to completion
    // (applied) or was withdrawn (superseded). Re-recording it would rewind
    // history; the caller must read the record instead.
    return { status: 'refused', reason: `owner_decision_${byId.executionStatus}_not_rerecordable` };
  }
  const pending = decisions.find((d) => d.executionStatus === 'pending');
  if (pending !== undefined) {
    if (pending.decision === intent.decision && pending.selectedPrincipleId === intent.selectedPrincipleId && existing !== null) {
      // Same verdict but a different decisionId (e.g. different reason text) —
      // treat as a resume of the EXISTING intent: one executable decision per
      // candidate, first recorded wins.
      return { status: 'resumed', document: existing, decision: pending };
    }
    if (decisions.length >= MAX_OWNER_DECISIONS) {
      return { status: 'refused', reason: 'owner_decision_history_exceeded' };
    }
    const supersededBy: OwnerDecisionRecord = { ...pending, executionStatus: 'superseded', supersededByDecisionId: intent.decisionId };
    const document: CandidateAdmissionDocument = {
      ...(existing ?? { schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION, evaluations: [], currentEvaluationId: null }),
      ownerDecisions: [...decisions.filter((d) => d.decisionId !== pending.decisionId), supersededBy, intent],
    };
    return { status: 'superseded', document, decision: intent, supersededDecisionId: pending.decisionId };
  }
  if (decisions.length >= MAX_OWNER_DECISIONS) {
    return { status: 'refused', reason: 'owner_decision_history_exceeded' };
  }
  const document: CandidateAdmissionDocument = {
    ...(existing ?? { schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION, evaluations: [], currentEvaluationId: null }),
    ownerDecisions: [...decisions, intent],
  };
  return { status: 'appended', document, decision: intent };
}

type CompleteOwnerDecisionResult =
  | { status: 'completed'; document: CandidateAdmissionDocument }
  | { status: 'already_completed'; document: CandidateAdmissionDocument }
  | { status: 'refused'; reason: string };

/**
 * Phase C — atomically finalize an executed Owner decision: mark `applied`
 * (with resultingPrincipleId + executedAt), append the release audit
 * evaluation (when a park is being lifted), and transition processing to
 * `complete`. One document write = one admission_json UPDATE, so a crash can
 * never leave the park cleared but the decision unmarked (or vice versa).
 *
 * `already_completed` — idempotent re-run of Phase C after a lost response:
 * the decision is applied; the caller reports the completed result without
 * re-executing anything.
 */
export function completeOwnerDecision(
  existing: CandidateAdmissionDocument | null,
  decisionId: string,
  input: {
    resultingPrincipleId: string;
    executedAt?: string;
    /** The reuse-park release audit (reuse-park-release@1) when the decision lifted a park. */
    releaseEvaluation?: AdmissionEvaluationRecord;
  },
): CompleteOwnerDecisionResult {
  const decisions = existing?.ownerDecisions ?? [];
  const decision = decisions.find((d) => d.decisionId === decisionId);
  if (decision === undefined) {
    return { status: 'refused', reason: 'owner_decision_not_found' };
  }
  if (decision.executionStatus === 'applied') {
    if (existing === null) return { status: 'refused', reason: 'owner_decision_document_missing' };
    return { status: 'already_completed', document: existing };
  }
  if (decision.executionStatus !== 'pending') {
    return { status: 'refused', reason: `owner_decision_${decision.executionStatus}_not_completable` };
  }
  const executedAt = input.executedAt ?? new Date().toISOString();
  const applied: OwnerDecisionRecord = {
    ...decision,
    executionStatus: 'applied',
    executedAt,
    resultingPrincipleId: input.resultingPrincipleId,
  };
  let document: CandidateAdmissionDocument = {
    ...(existing ?? { schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION, evaluations: [], currentEvaluationId: null }),
    ownerDecisions: decisions.map((d) => (d.decisionId === decisionId ? applied : d)),
  };
  if (input.releaseEvaluation !== undefined) {
    const { releaseEvaluation } = input;
    const appended = appendAdmissionEvaluation(document, releaseEvaluation);
    if (appended.status === 'refused') {
      return { status: 'refused', reason: `owner_decision_release_audit_${appended.reason}` };
    }
    ({ document } = appended);
  }
  document = withProcessing(document, {
    state: 'complete',
    attempts: 0,
    completedAt: executedAt,
  });
  return { status: 'completed', document };
}
