// render-github-url.test.ts
// ERR-001/005: no `as FeedbackType` cast; use isFeedbackType validator.
// ERR-014/016: correct '\n' newlines, bounded body.
// Redacts title before embedding in URL.

import { describe, it, expect } from 'vitest';
import {
  buildGitHubIssueDraftUrl,
  MAX_URL_BODY_LENGTH,
  GITHUB_REPO,
} from '../../feedback/render-github-url.js';

describe('buildGitHubIssueDraftUrl', () => {
  it('returns a valid GitHub issue URL with type prefix in title', () => {
    const result = buildGitHubIssueDraftUrl('Cannot open page', 'bug', 'short summary');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain(`https://github.com/${GITHUB_REPO}/issues/new`);
    expect(result.url).toContain('title=');
    expect(result.url).toContain('bug');
    expect(result.url).toContain('Cannot%20open%20page');
  });

  it('redacts absolute paths in title before embedding', () => {
    const result = buildGitHubIssueDraftUrl(
      'Error at C:\\Users\\alice\\secret\\path.ts',
      'bug',
      'short summary',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The raw path should NOT be in the URL
    expect(result.url).not.toContain('C%3A%5CUsers%5Calice');
    // The redacted marker should be present
    expect(result.url).toContain('redacted-path');
  });

  it('binds the body to MAX_URL_BODY_LENGTH', () => {
    const longSummary = 'x'.repeat(5000);
    const result = buildGitHubIssueDraftUrl('title', 'bug', longSummary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The body=... portion of the URL must not exceed the bound
    const bodyMatch = /[?&]body=([^&]*)/.exec(result.url);
    expect(bodyMatch).not.toBeNull();
    if (bodyMatch === null) return;
    const raw = bodyMatch[1] ?? '';
    const bodyValue = decodeURIComponent(raw);
    expect(bodyValue.length).toBeLessThanOrEqual(MAX_URL_BODY_LENGTH);
  });

  it('preserves \\n newlines in body (encoded as %0A) instead of literal \\n', () => {
    const summary = 'line one\nline two\nline three';
    const result = buildGitHubIssueDraftUrl('title', 'bug', summary);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The body must contain %0A (encoded newline), not literal \n chars
    expect(result.url).toContain('%0A');
    expect(result.url).not.toMatch(/(?<!\\)\\\\n/); // no escaped backslash-n
  });

  it('returns structured error for invalid type — does NOT throw or use `as` cast', () => {
    const result = buildGitHubIssueDraftUrl('title', 'not-a-valid-type' as unknown as 'bug', 'summary');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeDefined();
    expect(result.nextAction).toBeDefined();
    expect(typeof result.nextAction).toBe('string');
  });

  it('handles empty summary without throwing', () => {
    const result = buildGitHubIssueDraftUrl('title', 'bug', '');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.url).toContain('https://github.com/');
  });

  it('redacts env-like values in title (OPENAI_API_KEY=sk-... does not appear in URL)', () => {
    const result = buildGitHubIssueDraftUrl(
      'Crash with OPENAI_API_KEY=sk-abc1234567890123456789abcdef in env',
      'bug',
      'short summary',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The secret value must be redacted; the key name may remain but the token must not
    expect(result.url).not.toContain('sk-abc1234567890123456789abcdef');
    expect(result.url).toContain('%5BREDACTED%5D');
  });

  it('redacts env-like values in body (OPENAI_API_KEY=sk-... does not appear in URL)', () => {
    const result = buildGitHubIssueDraftUrl(
      'title',
      'bug',
      'details: OPENAI_API_KEY=sk-abc1234567890123456789abcdef leaked',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The secret value must be redacted; the key name may remain but the token must not
    expect(result.url).not.toContain('sk-abc1234567890123456789abcdef');
    expect(result.url).toContain('%5BREDACTED%5D');
  });

  it('returns structured error when shortSummary is not a string', () => {
    const nullResult = buildGitHubIssueDraftUrl('title', 'bug', null as unknown as string);
    expect(nullResult.ok).toBe(false);
    if (nullResult.ok) return;
    expect(nullResult.error).toBe('shortSummary must be a string');
    expect(nullResult.nextAction).toBe('provide a string value for shortSummary');

    const numResult = buildGitHubIssueDraftUrl('title', 'bug', 42 as unknown as string);
    expect(numResult.ok).toBe(false);
    if (numResult.ok) return;
    expect(numResult.error).toBe('shortSummary must be a string');
    expect(numResult.nextAction).toBe('provide a string value for shortSummary');
  });
});
