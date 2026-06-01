import { describe, it, expect } from 'vitest';
import {
  parseDraftRecord,
  parseDraftSummary,
  parseEnvelopeReport,
  getErrorMessage,
} from '../../src/ui/pages/ReportProblemValidators.js';

// ---------------------------------------------------------------------------
// Validators used by the ReportProblemPage React component.
// The vitest config in this package uses the `node` environment, so we test
// the pure validators directly without rendering React.
// ---------------------------------------------------------------------------

const VALID_DRAFT = {
  id: 'draft-001',
  createdAt: '2026-06-01T12:00:00.000Z',
  type: 'bug',
  title: 'Test bug',
  userText: {
    description: 'Detailed description here',
    stepsToReproduce: '1. Do X\n2. See Y',
    expectedBehavior: 'Z',
    actualBehavior: 'W',
    userSeverity: 'high',
  },
  diagnosticSummary: {
    versions: { pd: '1.0.0' },
    platform: { os: 'win32' },
    featureFlags: {},
    canary: { status: 'available', summary: 'ok' },
    recentEvents: [{ type: 'click', at: '2026-06-01T11:59:00.000Z', summary: 'X' }],
  },
  privacy: {
    includedSections: ['versions'],
    excludedByDefault: ['rawPrompt'],
    redactionNotes: [],
  },
  outputs: {
    markdown: '# Markdown',
    emailText: 'Email text',
    githubIssueUrl: 'https://github.com/x/y/issues/new?body=...',
  },
};

describe('parseDraftRecord', () => {
  it('returns a DraftRecord for a well-formed payload', () => {
    const result = parseDraftRecord(VALID_DRAFT);
    expect(result).not.toBeNull();
    expect(result?.id).toBe('draft-001');
    expect(result?.type).toBe('bug');
    expect(result?.userText.userSeverity).toBe('high');
  });

  it('rejects non-object input', () => {
    expect(parseDraftRecord(null)).toBeNull();
    expect(parseDraftRecord(undefined)).toBeNull();
    expect(parseDraftRecord('string')).toBeNull();
    expect(parseDraftRecord(42)).toBeNull();
    expect(parseDraftRecord([])).toBeNull();
  });

  it('rejects missing required top-level fields', () => {
    const { id: _id, ...noId } = VALID_DRAFT;
    expect(parseDraftRecord(noId)).toBeNull();

    const { type: _type, ...noType } = VALID_DRAFT;
    expect(parseDraftRecord(noType)).toBeNull();
  });

  it('rejects invalid type values', () => {
    expect(parseDraftRecord({ ...VALID_DRAFT, type: 'invalid' })).toBeNull();
  });

  it('rejects non-string id/title/createdAt', () => {
    expect(parseDraftRecord({ ...VALID_DRAFT, id: 123 })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, title: null })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, createdAt: [] })).toBeNull();
  });

  it('rejects when userText.description is missing or non-string', () => {
    const { userText: { description: _d, ...rest } } = VALID_DRAFT;
    expect(parseDraftRecord({ ...VALID_DRAFT, userText: rest })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, userText: { description: 42 } })).toBeNull();
  });

  it('rejects when outputs is missing any required string field', () => {
    const { outputs: { markdown: _m, ...rest } } = VALID_DRAFT;
    expect(parseDraftRecord({ ...VALID_DRAFT, outputs: rest })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, outputs: { ...VALID_DRAFT.outputs, emailText: 0 } })).toBeNull();
  });

  it('rejects when privacy arrays are missing or malformed', () => {
    expect(parseDraftRecord({ ...VALID_DRAFT, privacy: {} })).toBeNull();
    expect(parseDraftRecord({ ...VALID_DRAFT, privacy: { ...VALID_DRAFT.privacy, includedSections: 'not-array' } })).toBeNull();
  });

  it('rejects when userText.userSeverity has an invalid value', () => {
    const r = parseDraftRecord({
      ...VALID_DRAFT,
      userText: { ...VALID_DRAFT.userText, userSeverity: 'critical' },
    });
    expect(r).not.toBeNull();
    expect(r?.userText.userSeverity).toBeUndefined();
  });

  it('tolerates missing optional userText sub-fields', () => {
    const r = parseDraftRecord({
      ...VALID_DRAFT,
      userText: { description: 'just description' },
    });
    expect(r).not.toBeNull();
    expect(r?.userText.stepsToReproduce).toBeUndefined();
    expect(r?.userText.expectedBehavior).toBeUndefined();
    expect(r?.userText.actualBehavior).toBeUndefined();
    expect(r?.userText.userSeverity).toBeUndefined();
  });

  it('tolerates a missing diagnosticSummary (canary is recorded as unavailable)', () => {
    const { diagnosticSummary: _d, ...rest } = VALID_DRAFT;
    const r = parseDraftRecord(rest);
    expect(r).not.toBeNull();
    expect(r?.diagnosticSummary.canary.status).toBe('unavailable');
    expect(r?.diagnosticSummary.canary.unavailableReason).toBeTruthy();
  });
});

describe('parseDraftSummary', () => {
  it('returns a summary for a well-formed value', () => {
    expect(parseDraftSummary({ id: 'a', createdAt: 'b', type: 'bug', title: 'c' })).toEqual({
      id: 'a',
      createdAt: 'b',
      type: 'bug',
      title: 'c',
    });
  });

  it('rejects any missing field', () => {
    expect(parseDraftSummary({ id: 'a', createdAt: 'b', type: 'bug' })).toBeNull();
    expect(parseDraftSummary({ id: 'a', createdAt: 'b', type: 'bug', title: 5 })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseDraftSummary(null)).toBeNull();
    expect(parseDraftSummary('x')).toBeNull();
    expect(parseDraftSummary([1, 2, 3])).toBeNull();
  });
});

describe('parseEnvelopeReport', () => {
  it('returns the report when envelope is well-formed', () => {
    const r = parseEnvelopeReport({ report: VALID_DRAFT });
    expect(r).not.toBeNull();
    expect(r?.id).toBe('draft-001');
  });

  it('returns null when envelope is not an object', () => {
    expect(parseEnvelopeReport(null)).toBeNull();
    expect(parseEnvelopeReport('x')).toBeNull();
  });

  it('returns null when report field is invalid', () => {
    expect(parseEnvelopeReport({ report: 'not-a-record' })).toBeNull();
  });
});

describe('getErrorMessage', () => {
  it('returns the error field on a failure-shaped result', () => {
    expect(getErrorMessage({ success: false, error: 'oops' }, 'fallback')).toBe('oops');
  });

  it('returns the fallback on a success-shaped result', () => {
    expect(getErrorMessage({ success: true, data: {} }, 'fallback')).toBe('fallback');
  });

  it('returns the fallback on null/undefined/non-objects', () => {
    expect(getErrorMessage(null, 'fallback')).toBe('fallback');
    expect(getErrorMessage(undefined, 'fallback')).toBe('fallback');
    expect(getErrorMessage('oops', 'fallback')).toBe('fallback');
  });

  it('returns the fallback when error is present but not a string', () => {
    expect(getErrorMessage({ success: false, error: 42 }, 'fallback')).toBe('fallback');
  });
});
