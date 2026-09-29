/**
 * PRI-917 Slice 2 — reuse proposal + decision contract (internal).
 *
 * This slice delivers the FLOW only: given a candidate, produce a bounded
 * proposal of existing Principles that may already cover it, and let an
 * injected decision function answer `reuse` or `create`.
 *
 * Deliberately NOT in this slice (SPEC v0.2 / task scope):
 * - persistence of the decision or the relation (`reuseEvidence[]` is Slice 3)
 * - any Console page, new approval subsystem, or automated decision model
 * - any change to `derivedFromPainIds`, the ledger schema, or candidate status
 *
 * @see docs/specs/PRI-917-reuse-before-create-v0.1.md (SPEC v0.2)
 */

import type { ReuseCandidate, ReuseShortlist } from './reuse-domain.js';
import type { ReuseEvidenceActor } from '../types/principle-schema.js';

/**
 * `pending` — credible existing Principles were found and an Owner decision is
 * required before anything is written.
 * `no_candidates` — nothing credible was found; the caller proceeds to create.
 */
export type ReuseProposalStatus = 'pending' | 'no_candidates';

export interface ReuseProposalEntry {
  /** Canonical Principle Ledger UUID. */
  principleId: string;
  score: number;
  /** Human-readable reasons, one per evidence field. */
  reasons: string[];
}

export interface ReuseProposal {
  candidateId: string;
  status: ReuseProposalStatus;
  candidates: ReuseProposalEntry[];
  /** Principles that passed status eligibility. */
  eligibleCount: number;
}

/**
 * The Owner's answer. There is no automatic option.
 *
 * A `reuse` verdict carries the SPEC §11 decision-exchange fields (`actor`,
 * `reason`, `decidedAt`) because PRI-917 PR3B materialises the verdict into
 * `Principle.reuseEvidence[]` verbatim (SPEC §12): the durable evidence must
 * record WHO decided, WHY, and WHEN — an answer without them cannot be
 * persisted as a reuse resolution, so the validator rejects it fail-closed.
 */
export type ReuseDecision =
  | { decision: 'create' }
  | {
      decision: 'reuse';
      selectedPrincipleId: string;
      actor: ReuseEvidenceActor;
      reason: string;
      decidedAt: string;
    };

/**
 * Converts a deterministic shortlist into the proposal contract.
 *
 * The shortlist already guarantees determinism and a bounded Top-K, so this is
 * a pure projection: it adds no ranking of its own and never widens the set.
 */
export function buildReuseProposal(
  candidateId: string,
  shortlist: ReuseShortlist,
): ReuseProposal {
  const candidates: ReuseProposalEntry[] = shortlist.candidates.map((entry: ReuseCandidate) => ({
    principleId: entry.principleId,
    score: entry.score,
    reasons: [
      entry.similarityReason,
      ...entry.evidence.map((e) => `${e.field}: ${e.sharedTerms.slice(0, 5).join('、')}`),
    ],
  }));
  return {
    candidateId,
    status: candidates.length > 0 ? 'pending' : 'no_candidates',
    candidates,
    eligibleCount: shortlist.eligibleCount,
  };
}

/** True when the proposal needs an Owner answer before writing. */
export function proposalNeedsDecision(proposal: ReuseProposal): boolean {
  return proposal.status === 'pending';
}

export type ReuseDecisionValidation =
  | { ok: true; decision: ReuseDecision }
  | { ok: false; reason: string };

/**
 * Runtime validator for the reuse decision (rc-1/rc-2/rc-3).
 *
 * The decision function is an untrusted boundary — an AI Owner parses model
 * output into it — so its TypeScript type cannot be the guard. A bare
 * `"create"` string, `{}`, `{decision:'REUSE'}`, a non-string principle id, or
 * a missing id for reuse are ALL rejected here, because the alternative is
 * silently reading a malformed answer as "go ahead and create" — the exact
 * duplicate manufacturing this gate exists to prevent.
 *
 * PRI-917 PR3B Phase 2: a `reuse` verdict must additionally carry the
 * SPEC §11 accountability fields (`actor` / `reason` / `decidedAt`) — they are
 * materialised verbatim into `Principle.reuseEvidence[]`, and an answer
 * without them cannot produce a self-contained, auditable evidence entry.
 */
export function validateReuseDecision(raw: unknown): ReuseDecisionValidation {
  if (raw === null || raw === undefined) return { ok: false, reason: 'decision_is_nullish' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'decision_is_not_an_object' };
  const record = raw as Record<string, unknown>;
  const { decision } = record;
  if (decision === 'create') return { ok: true, decision: { decision: 'create' } };
  if (decision !== 'reuse') return { ok: false, reason: `unknown_decision_value:${String(decision)}` };
  const selected = record.selectedPrincipleId;
  if (typeof selected !== 'string' || selected.length === 0) {
    return { ok: false, reason: 'reuse_without_principle_id' };
  }
  const actorRaw: unknown = record.actor;
  if (typeof actorRaw !== 'object' || actorRaw === null || Array.isArray(actorRaw)) {
    return { ok: false, reason: 'reuse_actor_invalid' };
  }
  const actorRecord = actorRaw as Record<string, unknown>;
  if (
    !(actorRecord.kind === 'owner' || actorRecord.kind === 'ai_owner')
    || typeof actorRecord.id !== 'string'
    || actorRecord.id.length === 0
  ) {
    return { ok: false, reason: 'reuse_actor_invalid' };
  }
  const { reason, decidedAt } = record;
  if (typeof reason !== 'string' || reason.length === 0) {
    return { ok: false, reason: 'reuse_reason_missing' };
  }
  if (typeof decidedAt !== 'string' || decidedAt.length === 0 || Number.isNaN(Date.parse(decidedAt))) {
    return { ok: false, reason: 'reuse_decidedAt_invalid' };
  }
  return {
    ok: true,
    decision: {
      decision: 'reuse',
      selectedPrincipleId: selected,
      actor: { kind: actorRecord.kind, id: actorRecord.id },
      reason,
      decidedAt,
    },
  };
}
