/**
 * Receipt evidence coverage disclosure contract — PRI-590..594.
 *
 * Pure metadata contract for the read-side disclosure of the existing
 * principle receipt ledger (principle_applications). No new fact source:
 * every runtime field is derived from existing state at request time
 * (observedFrom, asOf) or is a static policy constant shared with the
 * ledger writer (retentionPolicyDays).
 *
 * Owner-facing meaning (SPEC §8): counts are OBSERVED evidence within the
 * currently retained window — never a claim of complete history.
 */

/**
 * Rolling retention enforced by the plugin ledger writer
 * (principle-application-ledger.ts sweepRetention). Single source of
 * truth — import this instead of re-declaring the number.
 */
export const RECEIPT_RETENTION_POLICY_DAYS = 90;

/**
 * Whether the receipt fact source (state.db principle_applications) can be
 * read right now.
 *
 * - available   — source exists and is readable
 * - disabled    — collection turned off via principle_receipt_ledger flag
 * - unavailable — source cannot be read (state.db missing / table missing /
 *                 state error)
 *
 * Precedence mirrors the reader's existing precheck: unavailable outranks
 * disabled, so observable legacy behavior is unchanged.
 */
export type ReceiptSourceStatus = 'available' | 'disabled' | 'unavailable';

/**
 * Trustworthiness of the ledger data, assessed only when the source is
 * available. When sourceStatus is disabled/unavailable no assessment is
 * performed and the field stays 'valid'.
 *
 * - valid    — data structure normal
 * - partial  — some rows were dropped from presentation (kind/created_at
 *              anomalies); counts remain accurate for known levels
 * - malformed— level space or aggregates broken; counts are untrustworthy
 *              ("receipt data requires recovery")
 */
export type ReceiptValidationStatus = 'valid' | 'partial' | 'malformed';

export interface ReceiptEvidenceCoverage {
  sourceStatus: ReceiptSourceStatus;
  validationStatus: ReceiptValidationStatus;
  /** Earliest retained evidence in the queried scope; null = nothing retained (true zero). NOT a claim of full history. */
  observedFrom: string | null;
  /** ISO timestamp of the read that produced this coverage. */
  asOf: string;
  retentionPolicyDays: number;
  reasonCode?: string;
  nextActionCode?: string;
}
