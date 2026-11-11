/**
 * Approval readiness — the decision rules for the approval reading surface.
 *
 * SPEC-PD-UIUX-002 §6 (1C 决策页改造). The plan requires the decision bar to be
 * driven by a single, testable rule set rather than by ad-hoc booleans spread
 * through JSX:
 *
 *   1. Materials incomplete  → 「批准」 disabled, 「查看缺什么」 is primary.
 *   2. System recommends reject → 「拒绝」 is primary, with the reason above it.
 *   3. Otherwise → 「批准」 is primary.
 *
 * Pure function, no React, no I/O, so every branch is covered by unit tests.
 */

export type DecisionAction = 'approve' | 'reject' | 'edit_approval';
export type DecisionPrimary = 'approve' | 'reject' | 'look_at_gaps' | 'none';
export type Recommendation = 'approve' | 'reject' | 'none';

/**
 * Stable gap ids. The reading surface anchors 「查看缺什么」 at these ids, so the
 * key doubles as the DOM anchor (`#approval-gap-<key>`).
 */
export type MissingKey =
  | 'subject'
  | 'artifact'
  | 'body'
  | 'material'
  | 'revision'
  | 'revision_review'
  | 'source_unlinked'
  | 'gate';

export interface MissingItem {
  key: MissingKey;
  /** i18n key describing the gap in one sentence. */
  labelKey: string;
  /**
   * `false` means the Owner cannot fix it from this page right now (the version
   * moved, the source is unlinked). Those are the cases where recommending
   * "reject" is honest instead of asking the Owner to chase a gap.
   */
  fixable: boolean;
}

export interface DecisionReadinessInput {
  status: string;
  hasSubject: boolean;
  artifactState: string;
  exactBodyAvailable: boolean;
  materialAvailability: string;
  revisionMatches: boolean;
  revisionReviewUnavailable: boolean;
  /** Backend material gates that block approve (each item already has an owner sentence). */
  materialBlockCount: number;
  allowedActions?: readonly DecisionAction[];
  sourceUnlinked: boolean;
}

export interface DecisionReadiness {
  /** Every reason the approve action is unavailable, in reading order. */
  missing: MissingItem[];
  /** True only when `missing` is empty and the approval is still pending. */
  approveReady: boolean;
  canApprove: boolean;
  canReject: boolean;
  canEdit: boolean;
  primary: DecisionPrimary;
  recommendation: Recommendation;
  /** i18n key for the one-sentence recommendation shown above the buttons. */
  recommendationReasonKey: string;
}

const GAP_LABELS: Record<MissingKey, string> = {
  subject: 'pages.focus.workbench.gap.subject',
  artifact: 'pages.focus.workbench.gap.artifact',
  body: 'pages.focus.workbench.gap.body',
  material: 'pages.focus.workbench.gap.material',
  revision: 'pages.focus.workbench.gap.revision',
  revision_review: 'pages.focus.workbench.gap.revisionReview',
  source_unlinked: 'pages.focus.workbench.gap.sourceUnlinked',
  gate: 'pages.focus.workbench.gap.gate',
};

export const DECISION_REASON_KEYS = {
  approve: 'pages.focus.workbench.recommendation.approveReason',
  reject: 'pages.focus.workbench.recommendation.rejectReason',
  none: 'pages.focus.workbench.recommendation.noneReason',
} as const;

function gap(key: MissingKey, fixable = true): MissingItem {
  return { key, labelKey: GAP_LABELS[key], fixable };
}

/**
 * Compute readiness from facts the reading surface already holds.
 *
 * Ordering matters: the Owner reads the list top-down, so the first gap is the
 * one worth fixing first.
 */
export function computeDecisionReadiness(input: DecisionReadinessInput): DecisionReadiness {
  const pending = input.status === 'pending';
  const allowed = input.allowedActions;
  const may = (action: DecisionAction) => allowed === undefined || allowed.includes(action);

  const missing: MissingItem[] = [];
  if (pending) {
    if (!input.hasSubject) missing.push(gap('subject'));
    if (input.artifactState !== 'present') missing.push(gap('artifact'));
    if (!input.exactBodyAvailable) missing.push(gap('body'));
    if (input.materialAvailability !== 'available') missing.push(gap('material'));
    if (!input.revisionMatches) missing.push(gap('revision', false));
    if (input.revisionReviewUnavailable) missing.push(gap('revision_review'));
    if (input.sourceUnlinked) missing.push(gap('source_unlinked', false));
    if (input.materialBlockCount > 0) missing.push(gap('gate'));
  }

  const approveReady = pending && missing.length === 0 && may('approve');
  const canReject = pending && may('reject');
  const canEdit = pending && may('edit_approval');

  // Owner decision #2 (2026-11-11): when the only blockers cannot be repaired
  // from this page, approving would accept a version the Owner did not read —
  // recommend rejecting instead of pointing at gaps that will not close.
  const onlyUnfixableGaps = missing.length > 0 && missing.every(item => !item.fixable);
  const recommendReject = pending && !approveReady && onlyUnfixableGaps && canReject;

  const recommendation: Recommendation = recommendReject ? 'reject' : approveReady ? 'approve' : 'none';
  const primary: DecisionPrimary = !pending
    ? 'none'
    : recommendReject
      ? 'reject'
      : approveReady
        ? 'approve'
        : 'look_at_gaps';

  return {
    missing,
    approveReady,
    canApprove: approveReady,
    canReject,
    canEdit,
    primary,
    recommendation,
    recommendationReasonKey: DECISION_REASON_KEYS[recommendation],
  };
}

/** DOM id for a gap anchor — used by 「查看缺什么」. */
export function gapAnchorId(key: MissingKey): string {
  return `approval-gap-${key}`;
}
