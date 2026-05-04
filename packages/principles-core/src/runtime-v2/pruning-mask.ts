/**
 * Pruning Mask — builds a set of principle IDs to exclude from prompt injection.
 *
 * Consumes PruningReviewRecord[] (from listPruningReviews) and applies LWW
 * (Last Write Wins) semantics: for each principleId, only the latest decision
 * matters. archive-candidate → masked, keep/defer → not masked.
 *
 * Pure function, zero I/O, zero side effects.
 */
import type { PruningReviewRecord } from './pruning-review-log.js';

export function buildMaskedPrincipleSet(
  reviews: PruningReviewRecord[],
): Set<string> {
  if (!reviews || reviews.length === 0) {
    return new Set();
  }

  // LWW: track latest decision per principleId
  const latest = new Map<string, { decision: string; reviewedAt: string }>();

  for (const r of reviews) {
    if (!r?.principleId || !r?.decision || !r?.reviewedAt) {
      continue; // skip corrupt records
    }
    const existing = latest.get(r.principleId);
    if (!existing || r.reviewedAt >= existing.reviewedAt) {
      latest.set(r.principleId, { decision: r.decision, reviewedAt: r.reviewedAt });
    }
  }

  const masked = new Set<string>();
  for (const [principleId, { decision }] of latest) {
    if (decision === 'archive-candidate') {
      masked.add(principleId);
    }
  }
  return masked;
}
