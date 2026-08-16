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
    const admittedCount = admissionResults.filter((a) => a.admission.decision === 'admitted').length;
    const nonAdmittedCount = admissionResults.length - admittedCount;

    // Admitted candidates exist but intake produced no ledger entries
    if (autoIntakeEnabled && admittedCount > 0 && ledgerEntryIds.length === 0) {
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
        message: `partial_admission:${admittedCount}_admitted_${nonAdmittedCount}_gated${seedFailureNote ? `; ${seedFailureNote}` : ''}${notInternalizableNote ? `; ${notInternalizableNote}` : ''}`,
      };
    }

    // Success (or degraded when seed failed or a candidate was not internalizable)
    const combinedNote = [notInternalizableNote, seedFailureNote].filter(Boolean).join('; ');
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

  // Existing path: no admission results, simpler decision tree
  if (autoIntakeEnabled && ledgerEntryIds.length === 0) {
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
