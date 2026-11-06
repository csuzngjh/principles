/**
 * formatVersionSummary edge case tests.
 *
 * PRI-484 Task 28 follow-up — tests edge cases that were not covered in
 * the original intent-doc-version.test.ts:
 * - Empty content snapshot
 * - Very long content (>80 chars) with precise truncation
 * - Null/undefined handling
 * - Language-aware fallback for missing reason
 */
import { describe, it, expect } from 'vitest';
import { formatVersionSummary, type IntentDocVersion } from '../intent-doc-version.js';

describe('formatVersionSummary edge cases', () => {
  // ── Empty content ───────────────────────────────────────────────────────

  it('returns empty preview when contentSnapshot is empty', () => {
    const version: IntentDocVersion = {
      id: 'empty-1',
      lang: 'en',
      contentHash: 'sha256:abc',
      contentSnapshot: '',
      reason: 'Initial empty',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    expect(summary.preview).toBe('');
    expect(summary.label).toContain('v1');
    expect(summary.label).toContain('Initial empty');
  });

  it('returns title-only preview when contentSnapshot has only headers (no text)', () => {
    const version: IntentDocVersion = {
      id: 'headers-only',
      lang: 'en',
      contentHash: 'sha256:def',
      contentSnapshot: '# INTENT.md\n\n## 1. Why\n\n\n## 2. Desired Outcome\n\n',
      reason: 'Template only',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    // Only section headers (## 1., ## 2.) are stripped, title remains
    expect(summary.preview).toBe('# INTENT.md');
  });

  // ── Truncation boundary cases ───────────────────────────────────────────

  it('truncates exactly at 80 characters (boundary)', () => {
    const text80 = 'A'.repeat(80);
    const version: IntentDocVersion = {
      id: 'exact-80',
      lang: 'en',
      contentHash: 'sha256:ghi',
      contentSnapshot: `## 1. Why\n${text80}\n## 2. Desired Outcome\n`,
      reason: 'Exact 80 chars',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    // After stripping headers, we have exactly 80 chars
    expect(summary.preview).toBe(text80);
    expect(summary.preview.length).toBe(80);
    // No ellipsis because length is exactly 80
    expect(summary.preview.endsWith('...')).toBe(false);
  });

  it('truncates at 77 + "..." when content is 81 chars', () => {
    const text81 = 'A'.repeat(81);
    const version: IntentDocVersion = {
      id: 'over-80',
      lang: 'en',
      contentHash: 'sha256:jkl',
      contentSnapshot: `## 1. Why\n${text81}\n`,
      reason: 'Over 80 chars',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    expect(summary.preview).toBe('A'.repeat(77) + '...');
    expect(summary.preview.length).toBe(80);
  });

  it('truncates very long content (200 chars) to 80 chars with ellipsis', () => {
    const text200 = 'B'.repeat(200);
    const version: IntentDocVersion = {
      id: 'very-long',
      lang: 'en',
      contentHash: 'sha256:mno',
      contentSnapshot: `## 1. Why\n${text200}\n## 2. Desired Outcome\n`,
      reason: 'Very long',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    expect(summary.preview.endsWith('...')).toBe(true);
    expect(summary.preview.length).toBe(80);
    // Verify the truncated portion is correct
    expect(summary.preview.slice(0, 77)).toBe('B'.repeat(77));
  });

  // ── Language-aware fallback for missing reason ───────────────────────────

  it('uses zh-CN fallback "无备注" when lang=zh-CN and reason is null', () => {
    const version: IntentDocVersion = {
      id: 'zh-no-reason',
      lang: 'zh-CN',
      contentHash: 'sha256:pqr',
      contentSnapshot: '内容',
      reason: null,
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    expect(summary.label).toContain('无备注');
    expect(summary.label).not.toContain('(no note)');
  });

  it('uses en fallback "(no note)" when lang=en and reason is null', () => {
    const version: IntentDocVersion = {
      id: 'en-no-reason',
      lang: 'en',
      contentHash: 'sha256:stu',
      contentSnapshot: 'content',
      reason: null,
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    expect(summary.label).toContain('(no note)');
    expect(summary.label).not.toContain('无备注');
  });

  // ── Header stripping verification ─────────────────────────────────────────

  it('strips section header patterns but preserves title', () => {
    const version: IntentDocVersion = {
      id: 'headers-test',
      lang: 'en',
      contentHash: 'sha256:vwx',
      contentSnapshot: `# INTENT.md

## 1. Why

Why content here.

## 2. Desired Outcome

Outcome here.

## 3. Non-negotiables

NN content.

## 4. Stop / Escalation

Stop content.

## 5. Current Strategic Focus

Focus content.
`,
      reason: 'Full template',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    // Section headers (## 1., ## 2., etc.) are stripped, but title (# INTENT.md) remains
    expect(summary.preview).toContain('# INTENT.md');
    expect(summary.preview).not.toContain('## 1.');
    expect(summary.preview).not.toContain('## 2.');
    expect(summary.preview).not.toContain('## 3.');
    expect(summary.preview).not.toContain('## 4.');
    expect(summary.preview).not.toContain('## 5.');
    // Content should remain
    expect(summary.preview).toContain('Why content here');
    expect(summary.preview).toContain('Outcome here');
  });

  it('handles header variations (extra spaces)', () => {
    const version: IntentDocVersion = {
      id: 'header-spaces',
      lang: 'en',
      contentHash: 'sha256:yza',
      contentSnapshot: `##   1.   Why

Content.

## 2. Desired Outcome

More.
`,
      reason: 'Spaces in header',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    // Header regex should handle extra spaces
    expect(summary.preview).not.toContain('##');
    expect(summary.preview).toContain('Content');
  });
});