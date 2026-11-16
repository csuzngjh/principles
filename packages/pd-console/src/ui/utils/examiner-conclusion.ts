/**
 * Examiner conclusion derivation — ONE truth for "what does the A/B result
 * mean" (P4). Both consumers must go through this module:
 *
 *   - ExaminerReportPage owner-summary (verified conclusion, full sentence)
 *   - ExaminerPage study list + principle answer card (preliminary direction)
 *
 * The functions are pure: they consume the raw report facts (report status,
 * point-estimate status/value, replay-verification, examiner presence) and
 * return a stable code; the locale files turn codes into Owner-facing
 * sentences.
 *
 * Report-status gate (2026-11-16 Owner review, P1-1): the writer computes the
 * ITT BEFORE it judges the report status, so a REPORT_INVALID report can still
 * carry an ESTIMABLE positive point estimate — and replay verification only
 * proves the report can be recomputed, not that it is fit for conclusions.
 * Direction (positive/negative/noDifference) is therefore ONLY reachable for
 * REPORT_READY; every non-READY state maps to its own honest non-directional
 * code.
 */

import type { ExaminerStudySummary } from '../api.js';

/** Verified-conclusion code — maps 1:1 onto pages.examiner.ownerSummary.conclusion* keys. */
export type ReportConclusionCode =
  | 'invalid'
  | 'unverified'
  | 'pending'
  | 'noControlled'
  | 'inconclusive'
  | 'insufficient'
  | 'noDifference'
  | 'positive'
  | 'negative';

/** Study-list verdict code — maps onto pages.examiner.studies.verdict.* keys. */
export type StudyListVerdictCode =
  | 'problem'
  | 'noReport'
  | 'invalid'
  | 'pending'
  | 'inconclusive'
  | 'insufficient'
  | 'noDifference'
  | 'positive'
  | 'negative';

export interface ReportConclusionInput {
  /** Raw Report V2 status ('REPORT_READY' | 'REPORT_PENDING' | 'REPORT_INCONCLUSIVE' | 'REPORT_INVALID'). */
  reportStatus: string | null;
  verificationOk: boolean;
  hasExaminer: boolean;
  estimateStatus: string | null;
  estimateValue: number | null;
}

/** Report-page conclusion: replay verification AND report status both gate the direction. */
export function deriveReportConclusion(input: ReportConclusionInput): ReportConclusionCode {
  // An invalid report is unfit for conclusions even when the replay happens
  // to succeed — integrity/bindings failure outranks recomputability.
  if (input.reportStatus === 'REPORT_INVALID') return 'invalid';
  if (!input.verificationOk) return 'unverified';
  if (input.reportStatus === 'REPORT_PENDING') return 'pending';
  if (!input.hasExaminer) return 'noControlled';
  // INCONCLUSIVE and any unknown status never yield a direction.
  if (input.reportStatus !== 'REPORT_READY') return 'inconclusive';
  if (input.estimateStatus !== 'ESTIMABLE' || input.estimateValue === null) return 'insufficient';
  if (input.estimateValue === 0) return 'noDifference';
  return input.estimateValue > 0 ? 'positive' : 'negative';
}

export interface StudyListVerdictInput {
  reportStatus: string | null;
  hasExaminerResult: boolean;
  pointEstimate: { status: string; value: number | null } | null;
  /** Server-side metadata read problem — the row must NOT pretend nothing happened. */
  problemCode?: string;
}

/** Preliminary direction for a study-list row; direction requires REPORT_READY. */
export function deriveStudyListVerdict(study: StudyListVerdictInput): StudyListVerdictCode {
  if (study.problemCode !== undefined) return 'problem';
  if (study.reportStatus === null) return 'noReport';
  if (study.reportStatus === 'REPORT_INVALID') return 'invalid';
  if (!study.hasExaminerResult) return 'pending';
  if (study.reportStatus === 'REPORT_PENDING') return 'pending';
  if (study.reportStatus !== 'REPORT_READY') return 'inconclusive';
  const estimate = study.pointEstimate;
  if (estimate === null || estimate.status !== 'ESTIMABLE' || estimate.value === null) return 'insufficient';
  if (estimate.value === 0) return 'noDifference';
  return estimate.value > 0 ? 'positive' : 'negative';
}

/** |value| as a percentage string ("12.5%") or null — shared formatting. */
export function estimatePercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return `${(Math.abs(value) * 100).toFixed(1)}%`;
}

/**
 * Newest-first ordering for study rows (createdAt desc; null dates last,
 * equal dates keep their relative order — comparator contract respected).
 * Shared by the answer card's "latest study" pick and the list so both agree.
 */
export function orderStudiesByNewest(studies: ExaminerStudySummary[]): ExaminerStudySummary[] {
  return [...studies].sort((a, b) => {
    if (a.createdAt !== null && b.createdAt !== null) {
      if (a.createdAt < b.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      return 0;
    }
    if (a.createdAt !== null) return -1;
    if (b.createdAt !== null) return 1;
    return 0;
  });
}
