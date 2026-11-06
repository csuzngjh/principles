import { describe, it, expect } from 'vitest';
import { estimateLineChanges } from '../risk-calculator-policy.js';

describe('estimateLineChanges', () => {
  it('should estimate line changes correctly for write_file', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: 'line1\nline2\nline3' },
    });
    expect(lines).toBe(3);
  });

  it('should estimate line changes correctly for replace', () => {
    const lines = estimateLineChanges({
      toolName: 'replace',
      params: { new_string: 'a\nb\nc\nd\ne' },
    });
    expect(lines).toBe(5);
  });

  it('should estimate 50 for delete_file', () => {
    const lines = estimateLineChanges({
      toolName: 'delete_file',
      params: {},
    });
    expect(lines).toBe(50);
  });

  it('should return 0 for unknown tool', () => {
    const lines = estimateLineChanges({
      toolName: 'unknown_tool',
      params: {},
    });
    expect(lines).toBe(0);
  });

  it('should handle empty content for write_file', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: '' },
    });
    expect(lines).toBe(1);
  });

  it('should handle apply_patch tool', () => {
    const lines = estimateLineChanges({
      toolName: 'apply_patch',
      params: { patch: '+line1\n-line2\n+line3\n context' },
    });
    expect(lines).toBe(3);
  });

  // Regression: apply_patch must NOT count --- / +++ file headers as changes.
  // See CodeRabbit review on PR #1094 (P2): unified-diff headers overcounted by 2.
  it('should exclude --- / +++ file headers from apply_patch line count', () => {
    const lines = estimateLineChanges({
      toolName: 'apply_patch',
      params: {
        patch: '--- a/file.txt\n+++ b/file.txt\n+line1\n-line2\n context',
      },
    });
    // Only +line1 and -line2 are actual changes; --- and +++ are file headers.
    expect(lines).toBe(2);
  });

  // Regression: non-string params must NOT throw. See rc-2-no-as-bypass.
  it('should return 0 (not throw) when params.content is a number', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: 12345 },
    });
    expect(lines).toBe(1); // '' split by '\n' gives [''], length 1
  });

  it('should return 0 (not throw) when params.content is an object', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: { foo: 'bar' } },
    });
    expect(lines).toBe(1);
  });

  it('should return 0 (not throw) when params.content is an array', () => {
    const lines = estimateLineChanges({
      toolName: 'write_file',
      params: { content: ['a', 'b'] },
    });
    expect(lines).toBe(1);
  });

  it('should return 0 (not throw) when params.new_string is null', () => {
    const lines = estimateLineChanges({
      toolName: 'replace',
      params: { new_string: null },
    });
    expect(lines).toBe(1);
  });

  it('should return 0 (not throw) when params.patch is a number', () => {
    const lines = estimateLineChanges({
      toolName: 'apply_patch',
      params: { patch: 999 },
    });
    expect(lines).toBe(0);
  });
});
