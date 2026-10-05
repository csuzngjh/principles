/**
 * PRI-456: Pure result-shaping function for PainSignalBridge.
 *
 * Extracts the duplicated status-decision tree from:
 * - PainSignalBridge.onDiagnosisComplete() (fresh diagnosis path)
 * - PainSignalBridge.buildExistingResult() (idempotent existing-task path)
 *
 * Both paths decide: no candidates → failed; admitted-but-no-ledger → failed;
 * gated/partial → degraded; otherwise succeeded. But they differ in message
 * strings and the fresh path has admission results + degraded states.
 *
 * This function is pure: zero I/O, zero side effects. Callers pass all
 * computed values; the function never re-derives lineage fields.
 *
 * ERR gate:
 * - ERR-007 / EP-02: single source for status decision — branches can't diverge
 * - ERR-002 / EP-03: every degraded/failed branch keeps its structured message
 * - ERR-004 / ERR-008 / EP-07: lineage fields are received, never re-derived
 */
import type { PainSignalBridgeResult, NotInternalizableCandidate } from './pain-signal-bridge.js';
import type { CandidateAdmissionResult } from './admission-gate.js';

/** Base fields shared by both fresh and existing paths. */
interface ShapeBridgeResultBase {
  painId: string;
  taskId: string;
  candidateIds: string[];
  ledgerEntryIds: string[];
  runId?: string;
  artifactId?: string;
  autoIntakeEnabled: boolean;
  /**
   * Phase 1 / PR1 (Principle Ledger write boundary): how many candidates in
   * this batch have a ledger entry EXPECTED of them — i.e. they were admitted
   * and their validated `recommendation_kind` is exactly `'principle'`.
   *
   * "Admitted but zero ledger entries" is only an intake FAILURE when at least
   * one candidate was actually ledger-eligible. For a batch of rule / prompt /
   * implementation / defer candidates the boundary refuses the write BY DESIGN,
   * so the absence of ledger entries is their normal disposition and must be
   * reported as routed / not_internalizable rather than as a failed run.
   */
  ledgerEligibleCandidateCount: number;
  /**
   * PRI-917 v0.3.3 — candidateIds parked by the Reuse Review Gate (suspected
   * duplicates awaiting the Owner). A parked ledger-eligible candidate has NO
   * ledger entry BY DESIGN, so a batch whose ledger-eligible candidates are
   * ALL parked is a degraded "waiting for the Owner" outcome, not the intake
   * failure this branch used to report.
   */
  reuseReviewRequiredCandidateIds?: string[];
  /** PRI-539: candidates admitted+ledgered but not internalizable (MVP-disabled channel). */
  notInternalizable?: NotInternalizableCandidate[];
}

/** Fresh diagnosis path — has admission results and seed failure notes. */
export interface ShapeBridgeResultFreshInput extends ShapeBridgeResultBase {
  path: 'fresh';
  admissionResults: CandidateAdmissionResult[];
  /** Non-empty string when dreamer seed failed; empty string otherwise. */
  seedFailureNote: string;
}

/** Existing-task idempotent path — ledger-existence-derived, no admissions. */
export interface ShapeBridgeResultExistingInput extends ShapeBridgeResultBase {
  path: 'existing';
}

export type ShapeBridgeResultInput =
  | ShapeBridgeResultFreshInput
  | ShapeBridgeResultExistingInput;

/**
 * Derive the final PainSignalBridgeResult from computed inputs.
 *
 * Byte-for-byte identical to the original inline logic in both call sites.
 * The `path` discriminator selects the appropriate message strings and
 * decision branches.
 */
export function shapeBridgeResult(input: ShapeBridgeResultInput): PainSignalBridgeResult {
  const { painId, taskId, candidateIds, ledgerEntryIds, runId, artifactId, autoIntakeEnabled } = input;

  // Common: no candidates → failed (message differs by path)
  if (candidateIds.length === 0) {
    if (input.path === 'fresh') {
      return {
        status: 'failed',
        painId,
        taskId,
        runId,
        candidateIds,
        ledgerEntryIds,
        admissionResults: input.admissionResults,
        message: 'Diagnostician succeeded but produced no principle candidates',
      };
    }
    return {
      status: 'failed',
      painId,
      taskId,
      runId,
      candidateIds,
      ledgerEntryIds,
      message: 'Task has no principle candidates — treating as failed',
    };
  }

  if (input.path === 'fresh') {
    const { admissionResults, seedFailureNote } = input;
    const notInternalizable = input.notInternalizable ?? [];
    const notInternalizableNote = notInternalizable.length > 0
      ? `not_internalizable:${notInternalizable.map((n) => `${n.candidateId}=${n.reason}`).join(',')}`
      : '';
    // PRI-917 v0.3.3 review fix (P2-2): parked candidates must stay visible in
    // MIXED batches too. Previously only a fully-parked batch surfaced the
    // review requirement; a batch with one ledgered and one parked candidate
    // reported plain succeeded and hid the pending item from the Owner.
    const parked = input.reuseReviewRequiredCandidateIds ?? [];
    const parkedNote = parked.length > 0
      ? `reuse_review_required:${parked.join(',')} — suspected duplicates parked for Owner review; nextAction: pd candidate review --candidate-id <id> --decide reuse|create`
      : '';
    const admittedCount = admissionResults.filter((a) => a.admission.decision === 'admitted').length;
    const nonAdmittedCount = admissionResults.length - admittedCount;

    // Admitted LEDGER-ELIGIBLE candidates exist but intake produced no ledger
    // entries. Non-principle kinds are excluded here: the Principle Ledger write
    // boundary refuses them by design (Phase 1 / PR1), which is not a failure.
    // PRI-917 v0.3.3: candidates parked by the Reuse Review Gate also have no
    // ledger entry BY DESIGN — when EVERY ledger-eligible candidate is parked,
    // the run is a degraded "awaiting the Owner" outcome (rc-9), not a failure.
    if (autoIntakeEnabled && input.ledgerEligibleCandidateCount > 0 && ledgerEntryIds.length === 0) {
      if (parked.length > 0 && parked.length >= input.ledgerEligibleCandidateCount) {
        return {
          status: 'degraded',
          painId,
          taskId,
          runId,
          artifactId,
          candidateIds,
          ledgerEntryIds,
          admissionResults,
          notInternalizable: input.notInternalizable,
          message: parkedNote,
        };
      }
      return {
        status: 'failed',
        painId,
        taskId,
        runId,
        artifactId,
        candidateIds,
        ledgerEntryIds,
        admissionResults,
        notInternalizable: input.notInternalizable,
        message: 'Candidate intake did not produce a ledger entry',
      };
    }

    // All candidates gated (none admitted)
    if (nonAdmittedCount > 0 && admittedCount === 0) {
      return {
        status: 'degraded',
        painId,
        taskId,
        runId,
        artifactId,
        candidateIds,
        ledgerEntryIds,
        admissionResults,
        notInternalizable: input.notInternalizable,
        message: `all_candidates_gated:${admissionResults.map((a) => `${a.candidateId}=${a.admission.decision}`).join(',')}${seedFailureNote ? `; ${seedFailureNote}` : ''}${notInternalizableNote ? `; ${notInternalizableNote}` : ''}`,
      };
    }

    // Partial admission (some admitted, some gated)
    if (nonAdmittedCount > 0 && admittedCount > 0) {
      return {
        status: 'degraded',
        painId,
        taskId,
        runId,
        artifactId,
        candidateIds,
        ledgerEntryIds,
        admissionResults,
        notInternalizable: input.notInternalizable,
        message: `partial_admission:${admittedCount}_admitted_${nonAdmittedCount}_gated${seedFailureNote ? `; ${seedFailureNote}` : ''}${notInternalizableNote ? `; ${notInternalizableNote}` : ''}${parkedNote ? `; ${parkedNote}` : ''}`,
      };
    }

    // Success (or degraded when seed failed, a candidate was not internalizable,
    // or a candidate is parked awaiting the Owner — P2-2)
    const combinedNote = [notInternalizableNote, seedFailureNote, parkedNote].filter(Boolean).join('; ');
    return {
      status: combinedNote ? 'degraded' : 'succeeded',
      painId,
      taskId,
      runId,
      artifactId,
      candidateIds,
      ledgerEntryIds,
      admissionResults,
      notInternalizable: input.notInternalizable,
      message: combinedNote || undefined,
    };
  }

  // Existing path: no admission results, simpler decision tree.
  // Phase 1 / PR1: same reasoning as the fresh path — only ledger-eligible
  // candidates can be legitimately "missing" a ledger entry.
  // PRI-917 v0.3.3 review fix (P2-3): the caller passes principle-kind
  // candidates that are STILL PENDING without a ledger entry — the durable
  // carrier of "parked by the Reuse Review Gate" (the park persists nothing).
  // A replay of a parked task used to flip from the fresh path's
  // review_required outcome into a bare intake failure here.
  const parked = input.reuseReviewRequiredCandidateIds ?? [];
  if (autoIntakeEnabled && input.ledgerEligibleCandidateCount > 0 && ledgerEntryIds.length === 0) {
    if (parked.length > 0 && parked.length >= input.ledgerEligibleCandidateCount) {
      return {
        status: 'degraded',
        painId,
        taskId,
        runId,
        artifactId,
        candidateIds,
        ledgerEntryIds,
        message: `reuse_review_required:${parked.join(',')} — candidates still pending without a ledger entry (parked for Owner review or a prior intake did not complete); nextAction: pd candidate review --candidate-id <id> --decide reuse|create`,
      };
    }
    return {
      status: 'failed',
      painId,
      taskId,
      runId,
      artifactId,
      candidateIds,
      ledgerEntryIds,
      message: 'Candidate intake did not produce a ledger entry — treating as failed',
    };
  }

  // P2-2/F3: a replayed batch that ledgered SOME candidates while others are
  // still pending keeps the same review_required visibility as the fresh path.
  if (autoIntakeEnabled && parked.length > 0) {
    return {
      status: 'degraded',
      painId,
      taskId,
      runId,
      artifactId,
      candidateIds,
      ledgerEntryIds,
      message: `Task already succeeded; reuse_review_required:${parked.join(',')} — pending candidates await Owner review; nextAction: pd candidate review --candidate-id <id> --decide reuse|create`,
    };
  }

  return {
    status: 'succeeded',
    painId,
    taskId,
    runId,
    artifactId,
    candidateIds,
    ledgerEntryIds,
    message: 'Task already succeeded',
  };
}
