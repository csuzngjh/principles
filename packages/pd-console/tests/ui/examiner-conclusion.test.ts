import { describe, expect, it } from 'vitest';
import { deriveReportConclusion, deriveStudyListVerdict, estimatePercent, orderStudiesByNewest } from '../../src/ui/utils/examiner-conclusion.js';

describe('deriveReportConclusion — the report page single derivation truth', () => {
  const estimable = { hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: 0.5 } as const;

  it('REPORT_INVALID is unfit for conclusions even when replay verification succeeds', () => {
    expect(deriveReportConclusion({ reportStatus: 'REPORT_INVALID', verificationOk: true, ...estimable })).toBe('invalid');
    // and it outranks a failed replay too — invalid is the stronger statement.
    expect(deriveReportConclusion({ reportStatus: 'REPORT_INVALID', verificationOk: false, ...estimable })).toBe('invalid');
  });

  it('a non-READY status NEVER yields a direction, even with an ESTIMABLE positive estimate', () => {
    expect(deriveReportConclusion({ reportStatus: 'REPORT_PENDING', verificationOk: true, ...estimable })).toBe('pending');
    expect(deriveReportConclusion({ reportStatus: 'REPORT_INCONCLUSIVE', verificationOk: true, ...estimable })).toBe('inconclusive');
    expect(deriveReportConclusion({ reportStatus: 'SOME_FUTURE_STATUS', verificationOk: true, ...estimable })).toBe('inconclusive');
  });

  it('replay verification failure still outranks pending/inconclusive for a verifiable report', () => {
    expect(deriveReportConclusion({ reportStatus: 'REPORT_PENDING', verificationOk: false, ...estimable })).toBe('unverified');
  });

  it('no examiner block means no controlled result', () => {
    expect(deriveReportConclusion({ reportStatus: 'REPORT_READY', verificationOk: true, hasExaminer: false, estimateStatus: 'ESTIMABLE', estimateValue: 0.5 })).toBe('noControlled');
  });

  it('READY: non-estimable or missing point estimate is insufficient', () => {
    expect(deriveReportConclusion({ reportStatus: 'REPORT_READY', verificationOk: true, hasExaminer: true, estimateStatus: 'BOUNDS_ONLY', estimateValue: null })).toBe('insufficient');
    expect(deriveReportConclusion({ reportStatus: 'REPORT_READY', verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: null })).toBe('insufficient');
  });

  it('READY: direction follows the sign of the estimate', () => {
    expect(deriveReportConclusion({ reportStatus: 'REPORT_READY', verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: 0 })).toBe('noDifference');
    expect(deriveReportConclusion({ reportStatus: 'REPORT_READY', verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: 0.25 })).toBe('positive');
    expect(deriveReportConclusion({ reportStatus: 'REPORT_READY', verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: -0.25 })).toBe('negative');
  });
});

describe('deriveStudyListVerdict — preliminary direction for list rows', () => {
  const base = { reportStatus: 'REPORT_READY', hasExaminerResult: true, pointEstimate: { status: 'ESTIMABLE', value: 0 } };

  it('a metadata read problem outranks everything — never rendered as "nothing happened"', () => {
    expect(deriveStudyListVerdict({ ...base, problemCode: 'report_unreadable' })).toBe('problem');
    expect(deriveStudyListVerdict({ reportStatus: null, hasExaminerResult: false, pointEstimate: null, problemCode: 'manifest_unreadable' })).toBe('problem');
  });

  it('no report file is the first honest answer', () => {
    expect(deriveStudyListVerdict({ ...base, reportStatus: null })).toBe('noReport');
  });

  it('a metadata problem beats even an ESTIMABLE estimate on an INVALID report', () => {
    expect(deriveStudyListVerdict({ ...base, reportStatus: 'REPORT_INVALID', problemCode: 'manifest_unreadable' })).toBe('problem');
  });

  it('REPORT_INVALID is never a direction, even with an ESTIMABLE positive estimate', () => {
    expect(deriveStudyListVerdict({ ...base, reportStatus: 'REPORT_INVALID', pointEstimate: { status: 'ESTIMABLE', value: 0.5 } })).toBe('invalid');
  });

  it('PENDING / INCONCLUSIVE / unknown statuses map to their own honest codes', () => {
    expect(deriveStudyListVerdict({ ...base, reportStatus: 'REPORT_PENDING', pointEstimate: { status: 'ESTIMABLE', value: 0.5 } })).toBe('pending');
    expect(deriveStudyListVerdict({ ...base, reportStatus: 'REPORT_INCONCLUSIVE', pointEstimate: { status: 'ESTIMABLE', value: 0.5 } })).toBe('inconclusive');
    expect(deriveStudyListVerdict({ ...base, reportStatus: 'SOME_FUTURE_STATUS', pointEstimate: { status: 'ESTIMABLE', value: 0.5 } })).toBe('inconclusive');
  });

  it('READY: missing estimate data is insufficient, sign gives the direction', () => {
    expect(deriveStudyListVerdict({ ...base, pointEstimate: null })).toBe('insufficient');
    expect(deriveStudyListVerdict({ ...base, pointEstimate: { status: 'BOUNDS_ONLY', value: null } })).toBe('insufficient');
    expect(deriveStudyListVerdict({ ...base, pointEstimate: { status: 'ESTIMABLE', value: 0.5 } })).toBe('positive');
    expect(deriveStudyListVerdict({ ...base, pointEstimate: { status: 'ESTIMABLE', value: -0.5 } })).toBe('negative');
    expect(deriveStudyListVerdict(base)).toBe('noDifference');
  });
});

describe('orderStudiesByNewest — the answer card and the list share one ordering', () => {
  const study = (studyId: string, createdAt: string | null): never => ({ studyId, createdAt }) as never;

  it('sorts by createdAt descending, nulls last, equals keep relative order', () => {
    const ordered = orderStudiesByNewest([
      study('old', '2026-01-01T00:00:00Z'),
      study('undated-1', null),
      study('newest', '2026-03-01T00:00:00Z'),
      study('undated-2', null),
      study('mid', '2026-02-01T00:00:00Z'),
    ]);
    expect(ordered.map((s) => s.studyId)).toEqual(['newest', 'mid', 'old', 'undated-1', 'undated-2']);
  });

  it('historical studies dated only by report.generatedAt still order correctly', () => {
    const ordered = orderStudiesByNewest([
      study('hist-a', '2026-02-01T00:00:00Z'),
      study('hist-b', '2026-02-02T00:00:00Z'),
    ]);
    expect(ordered[0]?.studyId).toBe('hist-b');
  });
});

describe('estimatePercent', () => {
  it('formats magnitude only, null-safe', () => {
    expect(estimatePercent(0.1234)).toBe('12.3%');
    expect(estimatePercent(-0.5)).toBe('50.0%');
    expect(estimatePercent(null)).toBeNull();
  });
});
