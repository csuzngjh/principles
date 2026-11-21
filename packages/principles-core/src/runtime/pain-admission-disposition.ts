/**
 * PRI-1274 (B1): the versioned admission/recovery disposition block — the
 * ONE authority both writers persist inside the original task's
 * `diagnostic_json.recovery`:
 *
 *  - the receipt fallback (`pain-receipt-recovery.ts`) after a PostToolUse
 *    receipt restores (or refuses to restore) the submission identity;
 *  - `pd_submit_pain` itself at creation time, when the submission bound a
 *    session and named a target turn whose text is not yet collectable
 *    (`waiting_for_target_evidence`).
 *
 * The candidate picker's SQL gate excludes `waiting_for_target_evidence`
 * tasks BEFORE its ORDER BY/LIMIT, and the workspace worker's reconcile
 * flips the state once the authorized target-turn evidence exists — the
 * states below are the whole vocabulary for that hand-off (no new
 * TaskStatus; SPEC-PD-FEEDBACK-RESILIENCE-001 TD §3 step 9).
 *
 * Leaf module: types and one constant only, so the bridge, the submit
 * capability and the recovery module can share them with no import cycle.
 */

/** Recovery/admission disposition states (SPEC TD §1.3 "Recovery disposition"). */
export type PainRecoveryState =
  | 'waiting_for_receipt'
  | 'waiting_for_target_evidence'
  | 'ready_for_diagnosis'
  | 'blocked_by_consent'
  | 'ambiguous_receipt'
  | 'recovery_exhausted'
  | 'unrecoverable';

export const PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION = 1 as const;

/** Minimal reference to the receipt that drove (or was rejected for) this
 * task — identity fields only, never tool input/output text. */
export interface PainRecoveryReceiptRef {
  readonly schemaVersion: string;
  readonly capability: string;
  readonly status: string;
  readonly toolCallId: string;
  readonly receivedAt: string;
}

/** Versioned disposition persisted inside the original task's
 * `diagnostic_json` under the `recovery` key. */
export interface PainRecoveryDisposition {
  readonly schemaVersion: typeof PAIN_RECOVERY_DISPOSITION_SCHEMA_VERSION;
  readonly state: PainRecoveryState;
  readonly reasonCode: string;
  readonly attemptCount: number;
  readonly lastCheckedAt: string;
  readonly nextCheckAt?: string;
  readonly receiptRef?: PainRecoveryReceiptRef;
  readonly resolvedAt?: string;
}
