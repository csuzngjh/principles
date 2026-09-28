/**
 * PRI-917 Slice 1 — Reuse domain contract (internal).
 *
 * Scope: the READ side of "reuse before create". This module defines only the
 * vocabulary and the shapes needed to say "these existing Principles might
 * already cover this candidate". It performs no decision, no write, and no
 * intake wiring — those belong to later slices.
 *
 * Deliberately NOT exported from the runtime-v2 barrel: the frozen export
 * surface (PRI-775) is a public contract, and this is an internal capability
 * until it is proven by production use.
 *
 * @see docs/specs/PRI-917-reuse-before-create-v0.1.md (SPEC v0.2)
 */

/** The candidate fields that carry a Principle's semantic claim. */
export type ReuseSemanticField = 'text' | 'triggerPattern' | 'action';

/**
 * The semantic claim of a new Principle candidate, in the same three fields
 * the existing ledger Principles use. Mirrors `Principle` — deliberately NOT a
 * `Principle` (a candidate has no identity, version, or lifecycle yet).
 */
export interface ReuseCandidateInput {
  text: string;
  triggerPattern: string;
  action: string;
}

/**
 * Why a shortlist entry was surfaced, per field.
 *
 * A shortlist entry without evidence is not reviewable by an Owner, so evidence
 * is part of the shape rather than an optional extra (SPEC §17).
 */
export interface ReuseEvidence {
  field: ReuseSemanticField;
  /** Terms both sides used on this field (bounded, sorted). */
  sharedTerms: string[];
  /** Fraction of the smaller side's term set that is shared, in [0, 1]. */
  coverage: number;
}

/** One existing Principle proposed as already covering the candidate. */
export interface ReuseCandidate {
  /** Canonical Principle Ledger UUID (SPEC INV-R02). */
  principleId: string;
  principleText: string;
  /** Deterministic score in [0, 1]; ties are broken by `principleId`. */
  score: number;
  evidence: ReuseEvidence[];
  /** Human-readable one-liner for the Owner/AI-Owner review surface. */
  similarityReason: string;
}

/** The bounded, deterministically ordered proposal for one candidate. */
export interface ReuseShortlist {
  candidates: ReuseCandidate[];
  /** Principles that passed status eligibility before scoring. */
  eligibleCount: number;
  /** Principles actually scored (after the Top-K cap was irrelevant). */
  consideredCount: number;
  /** True when the candidate kind is eligible for the reuse path at all. */
  candidateKindEligible: boolean;
}

/** Tunables for the deterministic shortlist. Pure configuration, no policy. */
export interface ReuseShortlistOptions {
  /** Maximum entries returned. Phase 1 default 3 (SPEC §10). */
  topK?: number;
  /**
   * Minimum score for an entry to be considered credible. Below it the
   * shortlist is empty, which the caller must treat as "no credible
   * candidate" — never as permission to bypass governance.
   */
  minScore?: number;
  /** Maximum shared terms reported per evidence field. */
  maxEvidenceTerms?: number;
}

/** An existing Principle as seen by the reuse read side. */
export interface ReusablePrinciple {
  id: string;
  text: string;
  triggerPattern: string;
  action: string;
  status: string;
}
