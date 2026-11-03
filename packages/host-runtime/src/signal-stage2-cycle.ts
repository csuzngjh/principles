/**
 * Bounded Stage-2 correction review step shared by the Codex and WorkBuddy
 * workers (SPEC v0.3 §4.4.7 / v0.3.1 §2).
 *
 * Contract:
 * - runs at the END of the worker cycle (never ahead of the Diagnostician);
 * - at most 2 candidates per cycle;
 * - one aggregate wall-clock budget (default 60s), checked before each
 *   candidate and clamped into the single classification timeout;
 * - serial, CAS-claimed candidates; no new worker process, no new flag.
 *
 * The classifier itself comes from `createSignalClassifierForWorkspace`
 * (B4). A missing classifier does NOT fail the cycle: candidates with a
 * durable review result are still settled without any LLM call.
 */
import type { SignalLlmClassifier } from './signal-classifier.js';
import {
  claimPendingCorrectionCandidates,
  recordPendingCorrectionReview,
  releasePendingCorrectionClaim,
  settlePendingCorrection,
  type PendingCorrectionCandidate,
  type PendingReviewResult,
} from './governance-signal-admission.js';

const DEFAULT_MAX_CANDIDATES = 2;
const DEFAULT_AGGREGATE_BUDGET_MS = 60_000;
const DEFAULT_CLASSIFICATION_TIMEOUT_MS = 60_000;

export interface Stage2CorrectionCycleReport {
  readonly ok: boolean;
  readonly classifier: 'used' | 'unavailable' | 'disabled';
  readonly claimed: number;
  readonly admitted: number;
  readonly resolvedNone: number;
  readonly abandoned: number;
  readonly stillPending: number;
  readonly skipped: number;
  readonly expired: number;
  readonly durationMs: number;
  readonly reason?: string;
  readonly nextAction?: string;
  readonly degradations: readonly string[];
}

export interface Stage2CorrectionCycleInput {
  readonly workspaceDir: string;
  readonly classifier: SignalLlmClassifier | null;
  readonly classifierState?: 'used' | 'unavailable' | 'disabled';
  readonly maxCandidates?: number;
  readonly aggregateBudgetMs?: number;
  readonly classificationTimeoutMs?: number;
  readonly now?: Date;
  readonly onEvent?: (event: string, payloadJson: string) => void;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function emptyReport(
  classifier: Stage2CorrectionCycleReport['classifier'],
  reason?: string,
  nextAction?: string,
): Stage2CorrectionCycleReport {
  return {
    ok: reason === undefined,
    classifier,
    claimed: 0,
    admitted: 0,
    resolvedNone: 0,
    abandoned: 0,
    stillPending: 0,
    skipped: 0,
    expired: 0,
    durationMs: 0,
    ...(reason !== undefined ? { reason } : {}),
    ...(nextAction !== undefined ? { nextAction } : {}),
    degradations: [],
  };
}

export async function runStage2CorrectionCycle(input: Stage2CorrectionCycleInput): Promise<Stage2CorrectionCycleReport> {
  const classifierState = input.classifierState ?? (input.classifier === null ? 'unavailable' : 'used');
  // Monotonic clock for the aggregate budget; wall clock stays for DB/TTL.
  const startedAt = performance.now();
  const now = input.now ?? new Date();
  const maxCandidates = Math.min(Math.max(input.maxCandidates ?? DEFAULT_MAX_CANDIDATES, 1), DEFAULT_MAX_CANDIDATES);
  const budgetMs = Math.max(0, input.aggregateBudgetMs ?? DEFAULT_AGGREGATE_BUDGET_MS);
  const classificationTimeoutMs = Math.max(0, input.classificationTimeoutMs ?? DEFAULT_CLASSIFICATION_TIMEOUT_MS);

  const claimedResult = claimPendingCorrectionCandidates({ workspaceDir: input.workspaceDir, limit: maxCandidates, now });
  if (!claimedResult.ok) {
    return {
      ...emptyReport(classifierState, claimedResult.reason, claimedResult.nextAction),
      durationMs: Math.round(performance.now() - startedAt),
      degradations: [claimedResult.reason],
    };
  }

  let admitted = 0;
  let resolvedNone = 0;
  let abandoned = 0;
  let stillPending = 0;
  let skipped = 0;
  const degradations: string[] = [];

  /**
   * Release our claim when classification has NOT started. The release is
   * guarded inside gsa (never clears a durable reviewResult, CAS on the
   * fencing token), so a concurrent worker's state cannot be touched.
   */
  const releaseClaim = (candidate: PendingCorrectionCandidate): void => {
    if (candidate.claimToken === null) return;
    const released = releasePendingCorrectionClaim({
      workspaceDir: input.workspaceDir,
      logicalObservationKey: candidate.logicalObservationKey,
      claimToken: candidate.claimToken,
    });
    if (!released.ok) {
      degradations.push(`${candidate.logicalObservationKey}:claim_release_failed:${released.reason}`);
    }
  };

  const tally = (outcome: PendingReviewResult): void => {
    if (outcome.disposition === 'admitted') admitted += 1;
    else if (outcome.disposition === 'resolved_none') resolvedNone += 1;
    else if (outcome.disposition === 'abandoned') abandoned += 1;
    else if (outcome.disposition === 'pending') stillPending += 1;
    else skipped += 1;
  };

  for (const candidate of claimedResult.candidates) {
    const elapsed = performance.now() - startedAt;
    const remaining = budgetMs - elapsed;
    if (remaining <= 0) {
      releaseClaim(candidate);
      skipped += 1;
      continue;
    }
    try {
      let review = candidate.reviewResult;
      if (review === null) {
        if (input.classifier === null) {
          // No LLM configured/available: release the claim (no attempt
          // consumed) so a later cycle can retry immediately. NOT a verdict.
          releaseClaim(candidate);
          skipped += 1;
          continue;
        }
        const timeoutMs = Math.max(1, Math.min(classificationTimeoutMs, remaining));
        // The remaining budget goes INTO the adapter request as well as the
        // outer race (v0.3.1 §2.2); an outer timeout does not cancel a
        // provider request that the adapter does not support cancelling.
        const llm = await withTimeout(input.classifier(candidate.text, { timeoutMs }), timeoutMs);
        const { claimToken } = candidate;
        if (claimToken === null) {
          // A freshly claimed candidate always carries a token; its absence
          // means the claim was consumed elsewhere — do not write without it.
          degradations.push(`${candidate.logicalObservationKey}:claim_token_missing`);
          skipped += 1;
          continue;
        }
        const recorded = recordPendingCorrectionReview({
          workspaceDir: input.workspaceDir,
          logicalObservationKey: candidate.logicalObservationKey,
          claimToken,
          llmResult: llm,
          now,
        });
        if (!recorded.ok) {
          // Nothing durable was written; release so the next cycle retries
          // instead of waiting out the claim TTL.
          releaseClaim(candidate);
          degradations.push(`${candidate.logicalObservationKey}:${recorded.reason}`);
          skipped += 1;
          continue;
        }
        if (recorded.disposition === 'concurrent_loss') {
          skipped += 1;
          continue;
        }
        // Read the freshly persisted verdict through the settle step; the
        // recorded verdict is durable even if a later step throws.
      }
      const settled = await settlePendingCorrection({
        workspaceDir: input.workspaceDir,
        logicalObservationKey: candidate.logicalObservationKey,
        // Fencing token only when this cycle holds the claim; crash recovery
        // of an already durable reviewResult settles without one.
        ...(candidate.claimToken !== null ? { claimToken: candidate.claimToken } : {}),
        now,
      });
      if (!settled.ok) {
        degradations.push(`${candidate.logicalObservationKey}:${settled.reason}`);
        skipped += 1;
        continue;
      }
      tally(settled);
      input.onEvent?.('SIGNAL_STAGE2_SETTLED', JSON.stringify({
        logicalObservationKey: candidate.logicalObservationKey,
        disposition: settled.disposition,
        reason: settled.reason,
      }));
    } catch (error) {
      // Guarded release: a durable reviewResult is never cleared here.
      releaseClaim(candidate);
      const detail = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
      degradations.push(`${candidate.logicalObservationKey}:stage2_failed:${detail}`);
      skipped += 1;
    }
  }

  return {
    ok: degradations.length === 0,
    classifier: classifierState,
    claimed: claimedResult.candidates.length,
    admitted,
    resolvedNone,
    abandoned,
    stillPending,
    skipped,
    expired: claimedResult.expired,
    durationMs: Math.round(performance.now() - startedAt),
    ...(degradations.length > 0
      ? { reason: 'stage2_correction_degradations', nextAction: 'Inspect the per-candidate degradations; pending candidates remain durable and retry next cycle.' }
      : {}),
    degradations: degradations.slice(0, 10),
  };
}
