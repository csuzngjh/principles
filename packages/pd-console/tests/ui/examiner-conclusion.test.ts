import { describe, expect, it } from 'vitest';
import { deriveReportConclusion, deriveStudyListVerdict, estimatePercent } from '../../src/ui/utils/examiner-conclusion.js';

describe('deriveReportConclusion — the report page single derivation truth', () => {
  it('replay verification failure outranks everything', () => {
    expect(deriveReportConclusion({ verificationOk: false, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: 0.5 })).toBe('unverified');
  });

  it('no examiner block means no controlled result', () => {
    expect(deriveReportConclusion({ verificationOk: true, hasExaminer: false, estimateStatus: 'ESTIMABLE', estimateValue: 0.5 })).toBe('noControlled');
  });

  it('non-estimable or missing point estimate is insufficient', () => {
    expect(deriveReportConclusion({ verificationOk: true, hasExaminer: true, estimateStatus: 'BOUNDS_ONLY', estimateValue: null })).toBe('insufficient');
    expect(deriveReportConclusion({ verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: null })).toBe('insufficient');
  });

  it('direction follows the sign of the estimate', () => {
    expect(deriveReportConclusion({ verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: 0 })).toBe('noDifference');
    expect(deriveReportConclusion({ verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: 0.25 })).toBe('positive');
    expect(deriveReportConclusion({ verificationOk: true, hasExaminer: true, estimateStatus: 'ESTIMABLE', estimateValue: -0.25 })).toBe('negative');
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

  it('a report without an examiner block has no controlled result yet', () => {
    expect(deriveStudyListVerdict({ ...base, hasExaminerResult: false })).toBe('pending');
  });

  it('missing estimate data is insufficient, sign gives the direction', () => {
    expect(deriveStudyListVerdict({ ...base, pointEstimate: null })).toBe('insufficient');
    expect(deriveStudyListVerdict({ ...base, pointEstimate: { status: 'BOUNDS_ONLY', value: null } })).toBe('insufficient');
    expect(deriveStudyListVerdict({ ...base, pointEstimate: { status: 'ESTIMABLE', value: 0.5 } })).toBe('positive');
    expect(deriveStudyListVerdict({ ...base, pointEstimate: { status: 'ESTIMABLE', value: -0.5 } })).toBe('negative');
    expect(deriveStudyListVerdict(base)).toBe('noDifference');
  });
});

describe('estimatePercent', () => {
  it('formats magnitude only, null-safe', () => {
    expect(estimatePercent(0.1234)).toBe('12.3%');
    expect(estimatePercent(-0.5)).toBe('50.0%');
    expect(estimatePercent(null)).toBeNull();
  });
});
