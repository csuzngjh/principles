/**
 * 5B-F — read-only "rule compatibility scan" view shared by the console server
 * and the browser.
 *
 * This is a DELIBERATELY reduced projection of the core scan result:
 * reason-granular counts + bounded activation-id samples, never the per-row
 * findings array. The console needs to answer "did this upgrade verify my
 * rules?", not to re-render the CLI report.
 *
 * Type-only: the browser validates the wire payload in
 * `ui/utils/validators.ts`; the server maps it in `server/routes/compatibility-scan.ts`.
 */
export interface CompatibilityScanUnscannableView {
  reason: string;
  count: number;
  sampleActivationIds: string[];
}

export interface CompatibilityScanViewData {
  status: 'clean' | 'incomplete' | 'legacy_dependency' | 'no_state_db' | 'scan_failed';
  scannedActivations: number;
  /** Empty = every ACTIVE row was read. */
  unscannable: CompatibilityScanUnscannableView[];
  findingsTotal: number;
  reason?: string;
  nextAction?: string;
}
