import type { LedgerPrinciple } from './ledger-store.js';

export interface RuleCandidateBindingRevision {
  revision: number;
  decisionId: string;
  requestId: string;
  action: 'bind' | 'revoke';
  principleId: string;
  reason: string;
  decidedAt: string;
  owner: { actorId: string; source: 'authenticated_console' };
  reviewedCandidateDigest: string;
  reviewedPrincipleDigest: string;
}
export interface RuleCandidateBinding { candidateId: string; revisions: RuleCandidateBindingRevision[] }
export type CandidateIdentityBasis = 'derived_candidate' | 'principle_reuse' | 'owner_rule_binding';
export interface CandidateIdentityReceipt {
  candidateId: string;
  basis: CandidateIdentityBasis;
  principleId: string;
  bindingRevision?: number;
  decisionId?: string;
}
export type CandidateIdentityUnresolvedReason = 'ledger_unavailable' | 'ledger_corrupt' | 'candidate_missing' | 'candidate_kind_invalid' | 'missing' | 'ambiguous' | 'conflicting_authorities' | 'target_missing' | 'target_ineligible' | 'binding_revoked';
export type CandidatePrincipleIdentityResolution =
  | ({ status: 'resolved'; checkedAt: string } & CandidateIdentityReceipt)
  | { status: 'unresolved'; reason: CandidateIdentityUnresolvedReason; nextAction: string };
/** The caller loads existing persistence. Core validates the linked records, never model text. */
export interface RuleCandidateMaterial {
  candidate: unknown;
  task: unknown;
  run: unknown;
  artifact: unknown;
  /** For a committed diag_router candidate, loaded from task.inputRef. */
  parentTask?: unknown;
}
export interface RuleCandidateBindingSources {
  loadCandidateMaterial(candidateId: string): Promise<RuleCandidateMaterial | null>;
}
export type RuleCandidateBindingRequest =
  | { action: 'bind'; principleId: string; expectedRevision: number; expectedCandidateDigest: string; expectedPrincipleDigest: string; reason: string; requestId: string; resumeOnce: true }
  | { action: 'revoke'; expectedRevision: number; reason: string; requestId: string; resumeOnce: false };
export interface RuleCandidateBindingMutation {
  candidateId: string;
  request: RuleCandidateBindingRequest;
  owner: { actorId: string; source: 'authenticated_console' };
}
export type RuleCandidateBindingFailure = { ok: false; reason: string; nextAction: string };
export type RuleCandidateBindingMutationResult = RuleCandidateBindingFailure | {
  ok: true;
  status: 'bound' | 'already_bound' | 'revoked' | 'already_revoked';
  binding: RuleCandidateBindingRevision;
  runtimeDeactivated: false;
  inFlightOperationsMayComplete: true;
};
export type RuleCandidateBindingReview = RuleCandidateBindingFailure | {
  ok: true;
  candidateId: string;
  candidateMaterial: RuleCandidateMaterial;
  reviewedCandidateDigest: string;
  currentRevision: number;
  currentBinding: RuleCandidateBindingRevision | null;
  eligibleTargets: { principle: LedgerPrinciple; reviewedPrincipleDigest: string }[];
};
