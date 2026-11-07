// render-markdown.test.ts
// ERR-014/016/017: bounded output, correct '\n' newlines (not '\\n'), BigInt-safe.

import { describe, it, expect } from 'vitest';
import { renderReportMarkdown, MAX_MARKDOWN_LENGTH } from '../../feedback/render-markdown.js';
import type { FeedbackReport } from '../../feedback/feedback-types.js';

function makeReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: 'fb-test-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    type: 'bug',
    title: 'Cannot open pain page',
    userText: {
      description: 'Clicking the pain link throws TypeError',
      stepsToReproduce: '1. Go to Overview\n2. Click Pain',
      expectedBehavior: 'Page should open',
      actualBehavior: 'Page throws error',
      userSeverity: 'high',
    },
    diagnosticSummary: {
      versions: { '@principles/core': '1.0.0' },
      platform: { os: 'darwin', node: '20.0.0' },
      featureFlags: { 'mvp-core': true },
      canary: { status: 'available', summary: 'healthy' },
      recentEvents: [
        { type: 'pain_signal', at: '2026-06-01T00:00:00.000Z', summary: 'pain detected' },
      ],
    },
    contextRefs: [{ kind: 'page', id: 'overview' }],
    privacy: {
      includedSections: ['versions', 'platform', 'featureFlags', 'canary', 'userText'],
      excludedByDefault: ['rawPrompt', 'rawChat', 'fileContents', 'envVars', 'tokens', 'fullPaths', 'stackTraces'],
      redactionNotes: [],
    },
    outputs: { markdown: '', emailText: '', githubIssueUrl: '', mailtoUrl: '' },
    ...overrides,
  };
}

describe('renderReportMarkdown', () => {
  it('uses real \\n newlines, not literal \\n', () => {
    const report = makeReport();
    const md = renderReportMarkdown(report);
    // The markdown must contain actual newline characters separating sections
    expect(md.split('\n').length).toBeGreaterThan(5);
    // The rendered output must NOT contain escaped \n (which would render as backslash-n)
    expect(md).not.toMatch(/\\n/);
  });

  it('contains the type, title, and user-entered text', () => {
    const report = makeReport();
    const md = renderReportMarkdown(report);
    expect(md).toContain('bug');
    expect(md).toContain('Cannot open pain page');
    expect(md).toContain('Clicking the pain link throws TypeError');
  });

  it('contains diagnostics sections (versions, platform, canary)', () => {
    const report = makeReport();
    const md = renderReportMarkdown(report);
    expect(md).toContain('versions');
    expect(md).toContain('platform');
    expect(md).toContain('canary');
  });

  it('contains context refs', () => {
    const report = makeReport();
    const md = renderReportMarkdown(report);
    expect(md).toContain('overview');
  });

  it('is bounded to MAX_MARKDOWN_LENGTH characters', () => {
    const hugeSteps = 'step '.repeat(2000);
    const hugeDescription = 'desc '.repeat(2000);
    const report = makeReport({
      userText: {
        description: hugeDescription,
        stepsToReproduce: hugeSteps,
        expectedBehavior: 'x',
        actualBehavior: 'y',
        userSeverity: 'low',
      },
    });
    const md = renderReportMarkdown(report);
    expect(md.length).toBeLessThanOrEqual(MAX_MARKDOWN_LENGTH);
  });

  it('truncates oversized fields and records a redaction note in privacy.redactionNotes', () => {
    const hugeSteps = 'step '.repeat(2000);
    const report = makeReport({
      userText: {
        description: 'short',
        stepsToReproduce: hugeSteps,
        expectedBehavior: 'x',
        actualBehavior: 'y',
        userSeverity: 'low',
      },
    });
    const md = renderReportMarkdown(report);
    expect(md.length).toBeLessThanOrEqual(MAX_MARKDOWN_LENGTH);
    expect(report.privacy.redactionNotes.some((n: string) => n.includes('truncat') || n.includes('truncated'))).toBe(true);
  });

  it('BigInt values in diagnostics do not throw (ERR-017)', () => {
    const report = makeReport({
      diagnosticSummary: {
        versions: { count: BigInt(9999999999999) },
        platform: { os: 'linux' },
        featureFlags: {},
        canary: { status: 'unavailable', unavailableReason: 'offline' },
        recentEvents: [],
      },
    });
    let thrown: unknown = null;
    try {
      const md = renderReportMarkdown(report);
      expect(md).toBeDefined();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
  });

  it('reflects canary unavailable status in output without throwing', () => {
    const report = makeReport({
      diagnosticSummary: {
        versions: {},
        platform: { os: 'linux' },
        featureFlags: {},
        canary: { status: 'unavailable', unavailableReason: 'no network' },
        recentEvents: [],
      },
    });
    const md = renderReportMarkdown(report);
    expect(md).toContain('unavailable');
    expect(md).toContain('no network');
  });
});
