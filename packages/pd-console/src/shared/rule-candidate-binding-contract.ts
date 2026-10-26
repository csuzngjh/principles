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
  sourcePainId: string;
  evidence: string;
  candidateDigest: string;
  currentRevision: number;
  currentBinding: { action: 'bind' | 'revoke'; principleId: string; reason: string; revision: number } | null;
  eligibleTargets: RuleBindingTargetView[];
  resumeNotice: string;
}
export interface RuleBindingQueueView {
  items: { candidateId: string; text: string; reason: string }[];
}
