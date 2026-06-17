// privacy-preview.test.ts
// ERR-014/016/017: correct '\n' newlines, BigInt-safe safeStringifyPreview.

import { describe, it, expect } from 'vitest';
import {
  buildPrivacyPreview,
  buildEmailText,
  DEFAULT_INCLUDED_SECTIONS,
  DEFAULT_EXCLUDED_CATEGORIES,
} from '../../feedback/privacy-preview.js';
import type { FeedbackReport } from '../../feedback/feedback-types.js';

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
    outputs: { markdown: '', emailText: '', githubIssueUrl: '' },
    ...overrides,
  };
}

describe('buildPrivacyPreview', () => {
  it('includes default included sections (versions, platform, feature flags, canary, user text, IDs)', () => {
    const preview = buildPrivacyPreview([]);
    expect(preview.includedSections).toContain('versions');
    expect(preview.includedSections).toContain('platform');
    expect(preview.includedSections).toContain('featureFlags');
    expect(preview.includedSections).toContain('canary');
    expect(preview.includedSections).toContain('userText');
    expect(preview.includedSections).toContain('contextIds');
  });

  it('includes default excluded categories (raw prompt, raw chat, raw trajectory, file contents, env vars, tokens, full paths, full stack traces)', () => {
    const preview = buildPrivacyPreview([]);
    expect(preview.excludedByDefault).toContain('rawPrompt');
    expect(preview.excludedByDefault).toContain('rawChat');
    expect(preview.excludedByDefault).toContain('rawTrajectory');
    expect(preview.excludedByDefault).toContain('fileContents');
    expect(preview.excludedByDefault).toContain('envVars');
    expect(preview.excludedByDefault).toContain('tokens');
    expect(preview.excludedByDefault).toContain('fullPaths');
    expect(preview.excludedByDefault).toContain('fullStackTraces');
  });

  it('appends caller-provided redactionNotes to preview.redactionNotes', () => {
    const preview = buildPrivacyPreview(['user text contained absolute path', 'tokens were redacted']);
    expect(preview.redactionNotes).toContain('user text contained absolute path');
    expect(preview.redactionNotes).toContain('tokens were redacted');
  });

  it('returns a fresh array (not the default mutable reference)', () => {
    const a = buildPrivacyPreview([]);
    const b = buildPrivacyPreview([]);
    expect(a.includedSections).not.toBe(b.includedSections);
    expect(a.excludedByDefault).not.toBe(b.excludedByDefault);
    expect(a.redactionNotes).not.toBe(b.redactionNotes);
  });
});

describe('buildEmailText', () => {
  it('contains type, title, description', () => {
    const report = makeReport();
    const email = buildEmailText(report);
    expect(email).toContain('bug');
    expect(email).toContain('Cannot open pain page');
    expect(email).toContain('Clicking the pain link throws TypeError');
  });

  it('uses real \\n newlines (not literal \\n)', () => {
    const report = makeReport();
    const email = buildEmailText(report);
    expect(email.split('\n').length).toBeGreaterThan(3);
    expect(email).not.toMatch(/\\n/);
  });

  it('includes privacy summary section', () => {
    const report = makeReport();
    const email = buildEmailText(report);
    expect(email).toMatch(/privacy/i);
  });

  it('BigInt values do not throw (ERR-017 — safeStringifyPreview is BigInt-safe)', () => {
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
      const email = buildEmailText(report);
      expect(email).toBeDefined();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
  });

  it('handles circular references in diagnosticSummary without throwing', () => {
    const circular: Record<string, unknown> = { kind: 'versions' };
    circular.self = circular;
    const report = makeReport({
      diagnosticSummary: {
        versions: circular as unknown as Record<string, string>,
        platform: { os: 'linux' },
        featureFlags: {},
        canary: { status: 'unavailable', unavailableReason: 'cycle detected' },
        recentEvents: [],
      },
    });
    let thrown: unknown = null;
    try {
      const email = buildEmailText(report);
      expect(email).toBeDefined();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeNull();
  });
});
