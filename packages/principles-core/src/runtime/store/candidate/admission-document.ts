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

export type AdmissionDecisionValue = 'admitted' | 'needs_evidence' | 'deferred';

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

export interface CandidateAdmissionDocument {
  schemaVersion: typeof CANDIDATE_ADMISSION_SCHEMA_VERSION;
  evaluations: AdmissionEvaluationRecord[];
  currentEvaluationId: string | null;
  processing?: AdmissionProcessingRecord;
}

export type ParseAdmissionDocumentResult =
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
  return {
    ok: true,
    document: {
      schemaVersion: CANDIDATE_ADMISSION_SCHEMA_VERSION,
      evaluations: record.evaluations as AdmissionEvaluationRecord[],
      currentEvaluationId: currentId ?? null,
      ...(processing !== undefined ? { processing: processing as AdmissionProcessingRecord } : {}),
    },
  };
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

export type AppendAdmissionEvaluationResult =
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
