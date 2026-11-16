/**
 * Phase 7.2 B2.5 — Dreamer seed suppression for candidates that are already
 * resolved onto an existing principle (or still parked for the Owner).
 *
 * Rationale (LEDGER_WRITE_SAFETY_SPEC §3.4 downstream contract): a candidate
 * resolved by a reuse decision, by the exact-duplicate guard (B1), or still
 * parked as a suspected duplicate (B2) has NO information gain from an
 * independent Dreamer exploration chain — the mechanism is already learned
 * (or awaiting the Owner's verdict), and the chain's input would be the same
 * diagnosis the existing principle already came from.
 *
 * PURE function over two already-loaded PERSISTENT facts, so both seeding
 * entry points (CLI diagnose seed loop + PainSignalBridge seed loop) — and
 * the recovery paths (process restart, bridge rescan, review-create) — reach
 * the same verdict from durable state, never from a transient in-memory
 * intake result:
 *
 *   - processing: the candidate's admission processing record —
 *     awaiting_owner / reuse_pending_owner means a persisted park is waiting
 *     for the Owner (production anomaly 19aa989d: consumed AND parked AND
 *     seeded — this check closes that combination). Checked FIRST: an
 *     uncleared Owner park outranks everything below;
 *   - identity: resolveCandidatePrincipleIdentity(candidateId, kind) —
 *     basis 'principle_reuse' means the ledger's reuseEvidence[] records this
 *     candidate as resolved onto an existing principle (covers BOTH an Owner
 *     reuse decision and a B1 exact-duplicate resolution, which is audited
 *     through the same evidence seam). basis 'derived_candidate' (the
 *     candidate's OWN new principle) and rule bindings are NOT suppressed —
 *     that is the normal chain.
 */
import type { CandidatePrincipleIdentityResolution } from './types/rule-candidate-binding.js';

export type DreamerSeedSuppression =
  | { suppress: true; reason: 'reuse_resolved_to_existing_principle'; principleId: string }
  | { suppress: true; reason: 'reuse_park_pending_owner' }
  | { suppress: false };

export function evaluateDreamerSeedSuppression(input: {
  identity: CandidatePrincipleIdentityResolution;
  processing: { state: string; blockedReason?: string } | undefined;
}): DreamerSeedSuppression {
  // Owner P1 follow-up: the PARK outranks the recorded reuse resolution. For
  // the combined state (reuseEvidence present AND an uncleared park — a
  // concurrent race or historical inconsistency), answering
  // reuse_resolved_to_existing_principle first would make the bridge treat
  // the candidate as terminally resolved: consumed + processing completed —
  // silently clearing the Owner park without an Owner decision. The park
  // check therefore comes FIRST, mirroring the intake service's step-1b
  // ordering.
  if (input.processing?.state === 'awaiting_owner' && input.processing.blockedReason === 'reuse_pending_owner') {
    return { suppress: true, reason: 'reuse_park_pending_owner' };
  }
  if (input.identity.status === 'resolved' && input.identity.basis === 'principle_reuse') {
    return {
      suppress: true,
      reason: 'reuse_resolved_to_existing_principle',
      principleId: input.identity.principleId,
    };
  }
  return { suppress: false };
}
