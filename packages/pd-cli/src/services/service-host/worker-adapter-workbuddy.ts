/**
 * WorkBuddy Worker Adapter (SPEC §11 Phase 2, task §5).
 *
 * Wraps the EXISTING bounded WorkBuddy cycle — `pd workbuddy worker --once
 * --json --workspace <dir>` — behind the unified Worker Adapter contract.
 * The adapter only invokes and normalizes; catch-up, reconciliation, the
 * local candidate pick, the downstream consumer cycle and Stage-2 stay in
 * the WorkBuddy worker. Cycle-level liveness now exists as
 * `.state/workbuddy-worker-liveness.json` (shipped with this change — before
 * it, WorkBuddy had NO liveness record and FR-10 was undecidable).
 *
 * Known, RECORDED parity gap (task §5 / TD §2.3, not fixed here): the
 * WorkBuddy worker picks candidates with a local pending-first selector —
 * retry_wait tasks can starve under sustained pending pressure. This does
 * not block the Phase 2 minimal hookup, but Codex/WorkBuddy parity is NOT
 * complete until the fair-share selector is adopted (follow-up recorded on
 * PRI-1280).
 */
import { readWorkbuddyWorkerLiveness } from '@principles/workbuddy-adapter';
import {
  createOnceCliWorkerAdapter,
  readReportCount,
  readReportEvidence,
} from './worker-adapter.js';

export function createWorkbuddyWorkerAdapter() {
  return createOnceCliWorkerAdapter({
    hostKind: 'workbuddy',
    livenessFileName: 'workbuddy-worker-liveness.json',
    readLiveness: readWorkbuddyWorkerLiveness,
    extractCycleEvidence(parsed) {
      const base = readReportEvidence(parsed);
      return {
        ...base,
        postProcessingResumed: 0, // WorkBuddy has no post-processing continuation step (asymmetry §3.1)
        catchUpProcessed: readReportCount(parsed, 'catchUp', 'ingested'),
      };
    },
  });
}
