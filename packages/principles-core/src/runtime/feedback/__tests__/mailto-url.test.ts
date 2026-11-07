/**
 * buildMailtoUrl Tests — Feedback mailto: URL Builder
 *
 * Tests the mailto: URL builder for feedback reports.
 *
 * ERR checklist:
 * - ERR-001/005: no `as` casts; FeedbackReport constructed explicitly
 * - ERR-014/016: encoded body bounded to MAX_MAILTO_ENCODED_BODY_LENGTH (1800) + suffix
 */

import { describe, it, expect } from 'vitest';
import {
  buildMailtoUrl,
  buildEmailText,
  DEFAULT_INCLUDED_SECTIONS,
  DEFAULT_EXCLUDED_CATEGORIES,
} from '../privacy-preview.js';
import type { FeedbackReport } from '../feedback-types.js';

const MAINTAINER_EMAIL = 'csuzngjh@hotmail.com';
// Must mirror the constant in privacy-preview.ts. We assert the encoded body
// (not the raw body) stays within this budget — see ERR-014/016.
const MAX_MAILTO_ENCODED_BODY_LENGTH = 1800;
const TRUNCATED_SUFFIX = '\n\n…(truncated — use "Copy Email" in PD Console for the full report)';

function makeReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: 'fb-test-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    type: 'bug',
    title: 'Cannot open pain page',
    userText: {
      description: 'Clicking the pain link throws TypeError',
      userSeverity: 'high',
    },
    diagnosticSummary: {
      versions: { '@principles/core': '1.0.0' },
      platform: { os: 'darwin' },
      featureFlags: {},
      canary: { status: 'available' },
      recentEvents: [],
    },
    contextRefs: [],
    privacy: {
      includedSections: [...DEFAULT_INCLUDED_SECTIONS],
      excludedByDefault: [...DEFAULT_EXCLUDED_CATEGORIES],
      redactionNotes: [],
    },
    outputs: { markdown: '', emailText: '', githubIssueUrl: '', mailtoUrl: '' },
    ...overrides,
  };
}

describe('buildMailtoUrl', () => {
  it('returns empty string when maintainerEmail is empty', () => {
    const report = makeReport();
    expect(buildMailtoUrl(report, '')).toBe('');
  });

  it('returns empty string when maintainerEmail is not a string', () => {
    const report = makeReport();
    // @ts-expect-error — testing non-string input at runtime
    expect(buildMailtoUrl(report, undefined)).toBe('');
    // @ts-expect-error — testing non-string input at runtime
    expect(buildMailtoUrl(report, null)).toBe('');
  });

  it('builds mailto URL with the maintainer email', () => {
    const report = makeReport();
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    expect(url.startsWith(`mailto:${MAINTAINER_EMAIL}?`)).toBe(true);
    expect(url).toContain('subject=');
    expect(url).toContain('body=');
  });

  it('subject contains [PD feedback] [bug] prefix', () => {
    const report = makeReport({ type: 'bug', title: 'Something broke' });
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const subjectPart = url.split('subject=')[1]?.split('&body=')[0] ?? '';
    const decoded = decodeURIComponent(subjectPart);
    expect(decoded).toBe('[PD feedback] [bug] Something broke');
  });

  it('subject contains [PD feedback] prefix for each feedback type', () => {
    const types = ['bug', 'confusing', 'privacy_concern', 'feature_request', 'other'] as const;
    for (const type of types) {
      const report = makeReport({ type, title: 'Test title' });
      const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
      const subjectPart = url.split('subject=')[1]?.split('&body=')[0] ?? '';
      const decoded = decodeURIComponent(subjectPart);
      expect(decoded).toBe(`[PD feedback] [${type}] Test title`);
    }
  });

  it('URL-encodes special characters in subject (& ? newlines)', () => {
    const report = makeReport({ title: 'Bug: a & b ? c\nd' });
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const subjectPart = url.split('subject=')[1]?.split('&body=')[0] ?? '';
    const decoded = decodeURIComponent(subjectPart);
    // Decoded subject preserves the original special chars
    expect(decoded).toContain('&');
    expect(decoded).toContain('?');
    expect(decoded).toContain('\n');
    // Encoded subject must not contain raw & (query separator) or ? (fragment)
    expect(subjectPart).not.toContain('&');
    expect(subjectPart).toContain('%3F'); // ?
    expect(subjectPart).toContain('%0A'); // newline
  });

  it('URL-encodes special characters in body', () => {
    const report = makeReport({
      userText: { description: 'Line 1\nLine 2 & more ? yes' },
    });
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const bodyPart = url.split('body=')[1] ?? '';
    const decoded = decodeURIComponent(bodyPart);
    expect(decoded).toContain('Line 1\nLine 2 & more ? yes');
    // Encoded body should contain %0A for newlines and %26 for &
    expect(bodyPart).toContain('%0A');
    expect(bodyPart).toContain('%26');
  });

  it('truncates body so the encoded form stays within budget and appends …(truncated) when exceeded', () => {
    // Use multiple long fields so the email text definitely exceeds the
    // encoded-body budget. buildEmailText bounds each field to 1500 chars,
    // so we need several long fields to push the encoded body past 1800.
    const longText = 'x'.repeat(5000);
    const report = makeReport({
      userText: {
        description: longText,
        stepsToReproduce: longText,
        expectedBehavior: longText,
        actualBehavior: longText,
      },
    });
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const bodyPart = url.split('body=')[1] ?? '';
    const decoded = decodeURIComponent(bodyPart);
    // Suffix must be present (truncation path was taken)
    expect(decoded.endsWith(TRUNCATED_SUFFIX)).toBe(true);
    // The ENCODED body (with suffix) must respect the budget — this is the
    // invariant that protects Outlook desktop's ~2000-char mailto: limit.
    expect(bodyPart.length).toBeLessThanOrEqual(MAX_MAILTO_ENCODED_BODY_LENGTH);
  });

  it('does not truncate body when encoded form is within budget', () => {
    const report = makeReport();
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const bodyPart = url.split('body=')[1] ?? '';
    const decoded = decodeURIComponent(bodyPart);
    expect(decoded.endsWith(TRUNCATED_SUFFIX)).toBe(false);
  });

  it('body equals buildEmailText output when not truncated', () => {
    const report = makeReport();
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const bodyPart = url.split('body=')[1] ?? '';
    const decoded = decodeURIComponent(bodyPart);
    expect(decoded).toBe(buildEmailText(report));
  });

  it('redacts absolute paths in the subject (matches buildEmailText)', () => {
    const report = makeReport({ title: 'Bug at /home/alice/secret' });
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const subjectPart = url.split('subject=')[1]?.split('&body=')[0] ?? '';
    const decoded = decodeURIComponent(subjectPart);
    expect(decoded).toContain('<redacted-path>');
    expect(decoded).not.toContain('/home/alice');
  });

  it('preserves query order: subject= before body=', () => {
    const report = makeReport();
    const url = buildMailtoUrl(report, MAINTAINER_EMAIL);
    const subjectIdx = url.indexOf('subject=');
    const bodyIdx = url.indexOf('body=');
    expect(subjectIdx).toBeGreaterThan(-1);
    expect(bodyIdx).toBeGreaterThan(-1);
    expect(subjectIdx).toBeLessThan(bodyIdx);
  });
});
