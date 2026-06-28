import { describe, it, expect } from 'vitest';
import {
  computeVersionDiff,
  formatVersionSummary,
  type IntentDocVersion,
} from '../intent-doc-version.js';

describe('computeVersionDiff', () => {
  it('returns 5 section entries with changed=false for identical content', () => {
    const content = '## 1. Why\nsame\n## 2. Desired Outcome\nsame\n';
    const diff = computeVersionDiff(content, content);
    expect(diff).toHaveLength(5);
    expect(diff.every(d => d.changed === false)).toBe(true);
  });

  it('detects changed sections', () => {
    const old = '## 1. Why\nold text\n## 2. Desired Outcome\nsame\n';
    const next = '## 1. Why\nnew text\n## 2. Desired Outcome\nsame\n';
    const diff = computeVersionDiff(old, next);
    const whyDiff = diff.find(d => d.section === 'why');
    expect(whyDiff?.changed).toBe(true);
  });

  it('detects unchanged sections alongside changed ones', () => {
    const old = '## 1. Why\nold\n## 2. Desired Outcome\nsame content here\n';
    const next = '## 1. Why\nnew\n## 2. Desired Outcome\nsame content here\n';
    const diff = computeVersionDiff(old, next);
    const desiredDiff = diff.find(d => d.section === 'desiredOutcome');
    expect(desiredDiff?.changed).toBe(false);
  });

  it('treats missing section as empty string for comparison', () => {
    const old = '## 1. Why\nhas content\n';
    const next = '## 1. Why\nhas content\n## 2. Desired Outcome\nnew\n';
    const diff = computeVersionDiff(old, next);
    const desiredDiff = diff.find(d => d.section === 'desiredOutcome');
    expect(desiredDiff?.changed).toBe(true);
  });
});

describe('formatVersionSummary', () => {
  it('formats version with index and preview', () => {
    const version: IntentDocVersion = {
      id: 'abc-123',
      lang: 'zh-CN',
      contentHash: 'sha256:def',
      contentSnapshot: '## 1. Why\n这是很长的内容，需要被截断到80个字符以内显示预览。',
      reason: '初始创建',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    expect(summary.label).toContain('初始创建');
    expect(summary.label).toContain('v1');
    expect(summary.preview.length).toBeLessThanOrEqual(80);
  });

  it('handles missing reason', () => {
    const version: IntentDocVersion = {
      id: 'abc-456',
      lang: 'zh-CN',
      contentHash: 'sha256:ghi',
      contentSnapshot: 'content',
      reason: null,
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 1);
    expect(summary.label).toContain('v2');
  });

  it('truncates long previews with ellipsis', () => {
    const longText = 'A'.repeat(200);
    const version: IntentDocVersion = {
      id: 'abc-789',
      lang: 'en',
      contentHash: 'sha256:jkl',
      contentSnapshot: longText,
      reason: 'edit',
      createdAt: '2026-06-28T10:00:00.000Z',
    };
    const summary = formatVersionSummary(version, 0);
    expect(summary.preview.length).toBeLessThanOrEqual(80);
    expect(summary.preview.endsWith('...')).toBe(true);
  });
});
