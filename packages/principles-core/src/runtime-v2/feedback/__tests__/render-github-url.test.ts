/**
 * Render GitHub URL Tests — Feedback Pipeline URL Builder
 *
 * Tests the GitHub issue draft URL builder with privacy-preserving redaction.
 * This function is used to create feedback submission URLs.
 *
 * ERR checklist:
 * - ERR-001/005: no `as FeedbackType` cast; use isFeedbackType validator
 * - ERR-009/010: fail loud on invalid input
 * - ERR-014/016: bounded body (MAX_URL_BODY_LENGTH)
 */

import { describe, it, expect } from 'vitest';
import {
  buildGitHubIssueDraftUrl,
  MAX_URL_BODY_LENGTH,
  GITHUB_REPO,
} from '../render-github-url.js';

describe('buildGitHubIssueDraftUrl', () => {
  it('builds valid URL for bug feedback', () => {
    const result = buildGitHubIssueDraftUrl('Test bug', 'bug', 'Short summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain('github.com');
      expect(result.url).toContain(GITHUB_REPO);
      expect(result.url).toContain('/issues/new');
      expect(result.url).toContain('title=');
      // URL-encoded version of [bug]
      expect(result.url).toContain('%5Bbug%5D');
    }
  });

  it('builds valid URL for confusing feedback', () => {
    const result = buildGitHubIssueDraftUrl('Confusing message', 'confusing', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain('%5Bconfusing%5D');
    }
  });

  it('builds valid URL for privacy_concern feedback', () => {
    const result = buildGitHubIssueDraftUrl('Privacy issue', 'privacy_concern', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain('%5Bprivacy_concern%5D');
    }
  });

  it('builds valid URL for feature_request feedback', () => {
    const result = buildGitHubIssueDraftUrl('New feature', 'feature_request', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain('%5Bfeature_request%5D');
    }
  });

  it('builds valid URL for other feedback', () => {
    const result = buildGitHubIssueDraftUrl('General feedback', 'other', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain('%5Bother%5D');
    }
  });

  it('returns error for invalid feedback type', () => {
    const result = buildGitHubIssueDraftUrl('Title', 'invalid_type', 'Summary');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid feedback type');
      expect(result.nextAction).toContain('FeedbackType');
    }
  });

  it('returns error for non-string title', () => {
    // @ts-expect-error - testing non-string title for runtime validation
    const result = buildGitHubIssueDraftUrl(null, 'bug', 'Summary');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('title must be a string');
    }
  });

  it('returns error for non-string shortSummary', () => {
    // @ts-expect-error - testing non-string shortSummary for runtime validation
    const result = buildGitHubIssueDraftUrl('Title', 'bug', null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('shortSummary must be a string');
    }
  });

  it('redacts tokens in title', () => {
    const result = buildGitHubIssueDraftUrl('Bug with sk-abc123def456ghi789jkl012mno345pqr678', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // URL-encoded version of [REDACTED]
      expect(result.url).toContain('%5BREDACTED%5D');
      expect(result.url).not.toContain('sk-abc123');
    }
  });

  it('redacts paths in title', () => {
    const result = buildGitHubIssueDraftUrl('Bug at /home/alice/project', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // URL-encoded version of <redacted-path>
      expect(result.url).toContain('%3Credacted-path%3E');
      expect(result.url).not.toContain('/home/alice');
    }
  });

  it('redacts env vars in title', () => {
    const result = buildGitHubIssueDraftUrl('Bug with API_KEY=secret123', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // URL-encoded version of [REDACTED]
      expect(result.url).toContain('%5BREDACTED%5D');
      expect(result.url).not.toContain('secret123');
    }
  });

  it('redacts tokens in shortSummary', () => {
    const result = buildGitHubIssueDraftUrl('Title', 'bug', 'Summary with sk-abc123def456ghi789jkl012mno345pqr678');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // URL-encoded version of [REDACTED]
      expect(result.url).toContain('%5BREDACTED%5D');
      expect(result.url).not.toContain('sk-abc123');
    }
  });

  it('truncates title to 200 chars', () => {
    const longTitle = 'a'.repeat(300);
    const result = buildGitHubIssueDraftUrl(longTitle, 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const decodedTitle = decodeURIComponent(result.url.split('title=')[1]?.split('&')[0] ?? '');
      // [bug] (6 chars) + space (1 char) + 200 chars = 207 chars
      expect(decodedTitle.length).toBeLessThanOrEqual(207);
    }
  });

  it('truncates body to MAX_URL_BODY_LENGTH', () => {
    const longSummary = 'a'.repeat(1000);
    const result = buildGitHubIssueDraftUrl('Title', 'bug', longSummary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const decodedBody = decodeURIComponent(result.url.split('body=')[1] ?? '');
      expect(decodedBody.length).toBeLessThanOrEqual(MAX_URL_BODY_LENGTH);
    }
  });

  it('URL-encodes title correctly', () => {
    const result = buildGitHubIssueDraftUrl('Bug: test & more', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Check that special characters are encoded
      expect(result.url).not.toContain('Bug: test & more');
      // Check that colon and ampersand are encoded
      expect(result.url).toContain('%3A'); // colon
      expect(result.url).toContain('%26'); // ampersand
    }
  });

  it('URL-encodes body correctly', () => {
    const result = buildGitHubIssueDraftUrl('Title', 'bug', 'Summary with\nnewlines');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Newlines should be encoded as %0A
      expect(result.url).toContain('%0A');
    }
  });

  it('handles empty title', () => {
    const result = buildGitHubIssueDraftUrl('', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // URL-encoded version of [bug]
      expect(result.url).toContain('%5Bbug%5D');
    }
  });

  it('handles empty shortSummary', () => {
    const result = buildGitHubIssueDraftUrl('Title', 'bug', '');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toContain('body=');
    }
  });

  it('handles special characters in title', () => {
    const result = buildGitHubIssueDraftUrl('Bug <script>alert(1)</script>', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Should be URL-encoded, not raw HTML
      expect(result.url).not.toContain('<script>');
    }
  });

  it('handles unicode in title', () => {
    const result = buildGitHubIssueDraftUrl('Bug 测试 🎉', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBeDefined();
    }
  });

  it('handles unicode in shortSummary', () => {
    const result = buildGitHubIssueDraftUrl('Title', 'bug', 'Summary 测试 🎉');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBeDefined();
    }
  });

  it('constructs correct URL format', () => {
    const result = buildGitHubIssueDraftUrl('Test', 'bug', 'Summary');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const url = result.url;
      expect(url.startsWith('https://github.com/')).toBe(true);
      expect(url).toContain(`${GITHUB_REPO}/issues/new`);
      expect(url).toMatch(/title=[^&]+/);
      expect(url).toMatch(/body=.+/);
    }
  });

  it('preserves markdown structure in body', () => {
    const result = buildGitHubIssueDraftUrl('Title', 'bug', '## Header\n\n- Item 1\n- Item 2');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const decodedBody = decodeURIComponent(result.url.split('body=')[1] ?? '');
      expect(decodedBody).toContain('## Header');
      expect(decodedBody).toContain('- Item 1');
    }
  });

  it('handles all valid feedback types', () => {
    const types = ['bug', 'confusing', 'privacy_concern', 'feature_request', 'other'];
    for (const type of types) {
      const result = buildGitHubIssueDraftUrl('Title', type, 'Summary');
      expect(result.ok).toBe(true);
      if (result.ok) {
        // URL-encoded version of [type]
        expect(result.url).toContain(`%5B${encodeURIComponent(type)}%5D`);
      }
    }
  });

  it('returns error for number feedback type', () => {
    const result = buildGitHubIssueDraftUrl('Title', 42, 'Summary');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid feedback type');
    }
  });

  it('returns error for object feedback type', () => {
    const result = buildGitHubIssueDraftUrl('Title', {}, 'Summary');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid feedback type');
    }
  });

  it('returns error for undefined feedback type', () => {
    const result = buildGitHubIssueDraftUrl('Title', undefined, 'Summary');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('invalid feedback type');
    }
  });
});