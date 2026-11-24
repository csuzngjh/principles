/**
 * SPEC-CODEX-PAIN-CLOSURE-001 CR-03 §7.2 (review rounds 2-3): the shared
 * WRITE permission gate for every candidate mutation entry across the CLI —
 * intake, repair, backfill, review --decide create, `pd pain retry` and
 * `pd diagnose --intake`.
 *
 * Semantics (single source of truth; see candidate.ts for the intake-side
 * wiring and the review findings that produced each rule):
 *   - corrupted / dangling-pointer admission document → refuse (fail closed,
 *     never treated as "historically unrecorded") — rc-3/rc-9;
 *   - no document (pre-CR-03 record) → full re-evaluation from the persisted
 *     materials, saved idempotently;
 *   - current non-admitted → refuse;
 *   - current admitted → revalidated against the current persisted material
 *     (a changed material appends a NEW evaluation whose decision rules).
 */
import type { RuntimeStateManager, SourceMaterialAuthorizationPort } from '@principles/core/runtime';
import {
  currentAdmissionEvaluation,
  evaluateAndPersistAdmissionFromStore,
} from '@principles/core/runtime';

export type AdmissionWriteGateRefusal = {
  decision: string;
  reason: string;
  nextAction: string;
};

export async function enforceFullAdmissionForWrite(
  stateManager: RuntimeStateManager,
  candidateId: string,
  /**
   * PRI-1267 review round: `persistReevaluation: false` (the `--dry-run`
   * preview) computes the SAME verdict over the SAME materials without
   * appending an admission version — a preview must not mutate the candidate's
   * persisted admission state (cli-4).
   */
  options: {
    readonly persistReevaluation?: boolean;
    /** PRI-1283 R2: admission re-verification port; absent = fail-closed. */
    readonly sourceMaterialAuthorization?: SourceMaterialAuthorizationPort;
    /** Serialize read/re-evaluate/append with Owner decisions and internalize. */
    readonly coordination?: {
      withCandidateCoordination<T>(candidateId: string, operation: () => Promise<T>): Promise<T>;
    };
  } = {},
): Promise<AdmissionWriteGateRefusal | null> {
  const evaluate = async (): Promise<AdmissionWriteGateRefusal | null> => {
    const admissionDocument = await stateManager.getAdmissionDocument(candidateId);
    if (admissionDocument.ok && admissionDocument.document !== null) {
      const { document } = admissionDocument;
      const current = currentAdmissionEvaluation(document);
      if (current === null) {
        // Phase 7.2 P1-01: the Owner decision lifecycle (and processing
        // domain) can create a document with NO evaluation yet. An EMPTY
        // history claims nothing; a NON-empty history without a resolvable
        // current pointer is dangling and remains fail-closed.
        if (document.evaluations.length > 0 || document.currentEvaluationId !== null) {
          return {
            decision: 'needs_evidence',
            reason: 'admission_document_current_evaluation_dangling',
            nextAction: 'repair or re-run the diagnosis to regenerate the admission disposition; the write is refused until a valid current evaluation exists',
          };
        }
      }
      if (current !== null && current.decision !== 'admitted') {
        return { decision: current.decision, reason: current.reason, nextAction: current.nextAction };
      }
    } else if (!admissionDocument.ok) {
      return {
        decision: 'needs_evidence',
        reason: `admission_document_unreadable:${admissionDocument.reason}`,
        nextAction: 'inspect principle_candidates.admission_json for this candidate; repair or re-run the diagnosis before this write',
      };
    }
    const candidate = await stateManager.getCandidate(candidateId);
    if (candidate === null) {
      return { decision: 'needs_evidence', reason: 'candidate_not_found', nextAction: 'verify the candidate id' };
    }
    const revalidated = await evaluateAndPersistAdmissionFromStore(stateManager, [candidateId], {
      taskId: candidate.taskId,
      ...(options.persistReevaluation === false ? { persist: false } : {}),
      ...(options.sourceMaterialAuthorization !== undefined ? { sourceMaterialAuthorization: options.sourceMaterialAuthorization } : {}),
    });
    if (!revalidated.ok) {
      return { decision: 'needs_evidence', reason: `admission_revalidation_failed:${revalidated.reason}`, nextAction: revalidated.nextAction };
    }
    const fresh = revalidated.decisions.get(candidateId);
    if (fresh === undefined) {
      return { decision: 'needs_evidence', reason: 'candidate_not_in_diagnosis_chain', nextAction: 're-run the diagnosis; the candidate is not reachable from its diagnosis task' };
    }
    if (fresh.decision !== 'admitted') {
      return { decision: fresh.decision, reason: `${fresh.reason} (revalidated against current material)`, nextAction: fresh.nextAction };
    }
    return null;
  };

  const coordinate = options.coordination?.withCandidateCoordination;
  return typeof coordinate === 'function'
    ? coordinate.call(options.coordination, candidateId, evaluate)
    : evaluate();
}
