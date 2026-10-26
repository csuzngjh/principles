/** Owner-facing projection DTOs for the rule-candidate binding queue (PRI-1048).
 * Derived read-only views over existing authorities (state.db tasks/candidates,
 * trajectory.db pain_events, the principle ledger, the internalization chain).
 * No new persisted state; the Ledger remains the only binding authority. */

/** Which owner feedback produced the candidate. Text is null when the pain
 * record is gone — the UI must show 未记录, never fabricate a quote. */
export interface RuleBindingPainSourceView {
  painId: string;
  text: string | null;
  source: string;
  createdAt: string | null;
}

/** The formal principle a candidate is currently bound to (ledger authority). */
export interface RuleBindingBoundPrincipleView {
  principleId: string;
  text: string;
  status: string;
  version: number;
  revision: number;
  decidedAt: string;
}

/** Where the bound candidate's regeneration chain stands. `stageKind` names the
 * deepest internalization task reached ('scribe', 'artificer', …). Blocked
 * carries the server's reasonCode (e.g. textual_basis_unanchored) verbatim. */
export interface RuleBindingGenerationView {
  stage: 'not_built' | 'in_progress' | 'blocked' | 'advanced' | 'ambiguous';
  stageKind: string | null;
  reasonCode: string | null;
  detail: string | null;
}

/** Real backend revision eligibility, resolved by the production resolver
 * (resolveRuleBindingRevisionTarget + the same budget rule reviseRuleBindingOnce
 * enforces). The UI may only offer 修订并继续 when status === 'ready'. */
export interface RuleBindingResumeView {
  status: 'ready' | 'refused';
  reason: string | null;
  scribeTaskId: string | null;
  /** CAS input for the revise-once request (ready only). */
  taskRevisionEpoch: number | null;
}

export type RuleBindingQueueBindingView =
  | { status: 'unlinked' }
  | { status: 'bound'; principle: RuleBindingBoundPrincipleView }
  | { status: 'binding_revoked' }
  | { status: 'attention'; reason: string };

export interface RuleBindingQueueItem {
  candidateId: string;
  text: string;
  pain: RuleBindingPainSourceView;
  diagnosisStatus: string;
  binding: RuleBindingQueueBindingView;
  generation: RuleBindingGenerationView | null;
  resume: RuleBindingResumeView | null;
}

export interface RuleBindingQueueSummary {
  painGroups: number;
  candidates: number;
  bound: number;
  unlinked: number;
  blocked: number;
}

export interface RuleBindingQueueView {
  items: RuleBindingQueueItem[];
  summary: RuleBindingQueueSummary;
  truncated: boolean;
}

export interface RuleBindingTargetView {
  principleId: string;
  text: string;
  status: string;
  version: number;
  digest: string;
}
export interface RuleBindingReviewView {
  candidateId: string;
  candidateText: string;
  sourcePain: RuleBindingPainSourceView;
  evidence: string;
  candidateDigest: string;
  currentRevision: number;
  currentBinding: { action: 'bind' | 'revoke'; principleId: string; reason: string; revision: number } | null;
  boundPrinciple: RuleBindingBoundPrincipleView | null;
  eligibleTargets: RuleBindingTargetView[];
  generation: RuleBindingGenerationView | null;
  resume: RuleBindingResumeView | null;
  resumeNotice: string;
}
