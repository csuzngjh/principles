/**
 * Tests for extractToolResultPreview — trajectory v2 enhancement.
 *
 * Covers: null/undefined, string truncation, object with content array,
 * object without content (JSON stringify), error fallback, ERR-014 safety.
 */

import { describe, it, expect } from 'vitest';
import { extractToolResultPreview } from '../../src/hooks/after-tool-call-helpers.js';

describe('extractToolResultPreview', () => {
  it('returns null for null input', () => {
    expect(extractToolResultPreview(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(extractToolResultPreview(undefined)).toBeNull();
  });

  it('returns string directly when short enough', () => {
    const result = extractToolResultPreview('Error: file not found');
    expect(result).toBe('Error: file not found');
  });

  it('truncates long strings to 500 chars', () => {
    const longStr = 'x'.repeat(600);
    const result = extractToolResultPreview(longStr);
    expect(result).not.toBeNull();
    expect(result!.length).toBe(500); // 497 + '...'
    expect(result!.endsWith('...')).toBe(true);
  });

  it('extracts text from content array blocks', () => {
    const result = extractToolResultPreview({
      content: [
        { type: 'text', text: 'Error: ENOENT' },
        { type: 'text', text: 'file not found' },
      ],
    });
    expect(result).toBe('Error: ENOENT\nfile not found');
  });

  it('ignores non-text blocks in content array', () => {
    const result = extractToolResultPreview({
      content: [
        { type: 'image', data: 'base64...' },
        { type: 'text', text: 'Only this text' },
      ],
    });
    expect(result).toBe('Only this text');
  });

  it('falls back to JSON stringify when no content array', () => {
    const result = extractToolResultPreview({ exitCode: 1, error: 'ENOENT' });
    expect(result).not.toBeNull();
    expect(result).toContain('exitCode');
    expect(result).toContain('ENOENT');
  });

  it('returns null for empty object', () => {
    const result = extractToolResultPreview({});
    expect(result).toBeNull();
  });

  it('handles circular reference gracefully', () => {
    const obj: Record<string, unknown> = { key: 'value' };
    obj.self = obj;
    const result = extractToolResultPreview(obj);
    // Should not throw, returns either preview or fallback
    expect(result).not.toBeNull();
  });

  it('truncates JSON preview from large objects', () => {
    const bigObj: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) {
      bigObj[`field_${i}`] = 'x'.repeat(200);
    }
    const result = extractToolResultPreview(bigObj);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(500);
  });

  it('handles content array with invalid block types gracefully', () => {
    const result = extractToolResultPreview({
      content: [null, undefined, 'not_an_object', { type: 'text', text: 'valid' }],
    });
    expect(result).toBe('valid');
  });

  it('handles content array with all non-text blocks', () => {
    const result = extractToolResultPreview({
      content: [
        { type: 'image', data: 'base64' },
        { type: 'tool_use', id: '1', name: 'bash' },
      ],
    });
    // Falls back to JSON stringify since no text blocks found
    expect(result).not.toBeNull();
  });
});
