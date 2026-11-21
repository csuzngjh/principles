/**
 * Codex Worker Adapter (SPEC §11 Phase 2, task §4).
 *
 * Wraps the EXISTING bounded Codex cycle — `pd codex worker --once --json
 * --workspace <dir>` — behind the unified Worker Adapter contract. The
 * adapter only invokes and normalizes; every business behavior (catch-up,
 * reconciliation, Diagnostician lease/runner, post-processing continuation,
 * downstream consumer cycle, Stage-2, retention) stays in the Codex worker
 * and the shared execution layer. Liveness facts come from the existing
 * `.state/codex-worker-liveness.json` (written by the worker cycle itself),
 * preserving the Companion's stall attribution contract untouched.
 */
import { readCodexWorkerLiveness } from '@principles/codex-adapter';
import {
  createOnceCliWorkerAdapter,
  readReportCount,
  readReportEvidence,
  readReportSection,
} from './worker-adapter.js';

function isPlainRecordLoose(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sum the persisted-row counts of a parsed Codex catch-up report (F5):
 * `report.catchUp.rollouts[] → outcome{status:'ok', inserted:number}`.
 * Non-'ok' outcomes (degraded/skipped) and absent/malformed fields count 0.
 */
function countCodexCatchUpInserts(parsed: Record<string, unknown>): number {
  const catchUp = readReportSection(parsed, 'catchUp');
  if (catchUp === null) return 0;
  const { rollouts } = catchUp;
  if (!Array.isArray(rollouts)) return 0;
  let inserted = 0;
  for (const rollout of rollouts) {
    if (!isPlainRecordLoose(rollout)) continue;
    const { outcome } = rollout;
    if (!isPlainRecordLoose(outcome)) continue;
    if (outcome.status !== 'ok') continue;
    const count = outcome.inserted;
    if (typeof count === 'number' && Number.isFinite(count) && count > 0) inserted += count;
  }
  return inserted;
}

export function createCodexWorkerAdapter() {
  return createOnceCliWorkerAdapter({
    hostKind: 'codex',
    livenessFileName: 'codex-worker-liveness.json',
    readLiveness: readCodexWorkerLiveness,
    extractCycleEvidence(parsed) {
      const base = readReportEvidence(parsed);
      return {
        ...base,
        // Codex post-processing continuation: resumed task ids are actual
        // resumed work (guarded array-length read).
        postProcessingResumed: readReportCount(parsed, 'postProcessing', 'resumedTaskIds'),
        // F5 review fix: a Codex catch-up rollout entry records a CHECKED
        // session, not a write — re-examining an already-synced session
        // still yields an entry (replay outcome `{status:'ok', inserted:0}`).
        // Only rollouts that actually persisted rows (outcome.status 'ok'
        // with inserted > 0) count as progress; everything else is guarded
        // as zero (rc-4: element-level validation on the parsed array).
        catchUpProcessed: countCodexCatchUpInserts(parsed),
      };
    },
  });
}
