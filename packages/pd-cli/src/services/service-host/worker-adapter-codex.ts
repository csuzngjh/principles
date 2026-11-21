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
} from './worker-adapter.js';

export function createCodexWorkerAdapter() {
  return createOnceCliWorkerAdapter({
    hostKind: 'codex',
    livenessFileName: 'codex-worker-liveness.json',
    readLiveness: readCodexWorkerLiveness,
    extractCycleEvidence(parsed) {
      const base = readReportEvidence(parsed);
      return {
        ...base,
        // Codex-specific corroborating evidence (guarded reads; absent
        // sections read as zero — an empty cycle never counts as progress).
        postProcessingResumed: readReportCount(parsed, 'postProcessing', 'resumedTaskIds'),
        catchUpProcessed: readReportCount(parsed, 'catchUp', 'rollouts'),
      };
    },
  });
}
