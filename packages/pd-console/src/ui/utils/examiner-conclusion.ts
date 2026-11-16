/**
 * Examiner conclusion derivation — ONE truth for "what does the A/B result
 * mean" (P4). Both consumers must go through this module:
 *
 *   - ExaminerReportPage owner-summary (verified conclusion, full sentence)
 *   - ExaminerPage study list + principle answer card (preliminary direction)
 *
 * The functions are pure: they consume the raw report facts (point-estimate
 * status/value, replay-verification, examiner presence) and return a stable
 * code; the locale files turn codes into Owner-facing sentences. The list
 * variant deliberately does NOT know about replay verification — its wording
 * is always framed as "初步" (preliminary) by the callers' copy.
 */

/** Verified-conclusion code — maps 1:1 onto pages.examiner.ownerSummary.conclusion* keys. */
export type ReportConclusionCode =
  | 'unverified'
  | 'noControlled'
  | 'insufficient'
  | 'noDifference'
  | 'positive'
  | 'negative';

/** Study-list verdict code — maps onto pages.examiner.studies.verdict.* keys. */
export type StudyListVerdictCode =
  | 'noReport'
  | 'pending'
  | 'insufficient'
  | 'noDifference'
  | 'positive'
  | 'negative';

export interface ReportConclusionInput {
  verificationOk: boolean;
  hasExaminer: boolean;
  estimateStatus: string | null;
  estimateValue: number | null;
}

/** Same derivation the report page used to inline (ExaminerReportPage 105-115). */
export function deriveReportConclusion(input: ReportConclusionInput): ReportConclusionCode {
  if (!input.verificationOk) return 'unverified';
  if (!input.hasExaminer) return 'noControlled';
  if (input.estimateStatus !== 'ESTIMABLE' || input.estimateValue === null) return 'insufficient';
  if (input.estimateValue === 0) return 'noDifference';
  return input.estimateValue > 0 ? 'positive' : 'negative';
}

export interface StudyListVerdictInput {
  reportStatus: string | null;
  hasExaminerResult: boolean;
  pointEstimate: { status: string; value: number | null } | null;
}

/** Preliminary direction for a study-list row (no replay verification here). */
export function deriveStudyListVerdict(study: StudyListVerdictInput): StudyListVerdictCode {
  if (study.reportStatus === null) return 'noReport';
  if (!study.hasExaminerResult) return 'pending';
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
