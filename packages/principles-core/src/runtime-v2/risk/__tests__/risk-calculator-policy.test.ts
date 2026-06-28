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
});
