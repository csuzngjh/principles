/**
 * Tests for extractAssistantEnhancedFields — trajectory v2 enhancement.
 *
 * Covers: null/undefined, non-object, array, missing fields,
 * valid stopReason, content with thinking blocks, redacted_thinking.
 */

import { describe, it, expect } from 'vitest';
import { extractAssistantEnhancedFields } from '../../src/hooks/llm.js';

describe('extractAssistantEnhancedFields', () => {
  it('returns nulls for null input', () => {
    const result = extractAssistantEnhancedFields(null);
    expect(result).toEqual({ stopReason: null, thinkingBlocksCount: null });
  });

  it('returns nulls for undefined input', () => {
    const result = extractAssistantEnhancedFields(undefined);
    expect(result).toEqual({ stopReason: null, thinkingBlocksCount: null });
  });

  it('returns nulls for string input', () => {
    const result = extractAssistantEnhancedFields('not an object');
    expect(result).toEqual({ stopReason: null, thinkingBlocksCount: null });
  });

  it('returns nulls for number input', () => {
    const result = extractAssistantEnhancedFields(42);
    expect(result).toEqual({ stopReason: null, thinkingBlocksCount: null });
  });

  it('returns nulls for array input', () => {
    const result = extractAssistantEnhancedFields([{ type: 'thinking' }]);
    expect(result).toEqual({ stopReason: null, thinkingBlocksCount: null });
  });

  it('returns nulls for empty object', () => {
    const result = extractAssistantEnhancedFields({});
    expect(result).toEqual({ stopReason: null, thinkingBlocksCount: null });
  });

  it('extracts stopReason when it is a string', () => {
    const result = extractAssistantEnhancedFields({ stopReason: 'end_turn' });
    expect(result.stopReason).toBe('end_turn');
    expect(result.thinkingBlocksCount).toBeNull();
  });

  it('returns null stopReason when it is not a string', () => {
    const result = extractAssistantEnhancedFields({ stopReason: 123 });
    expect(result.stopReason).toBeNull();
  });

  it('extracts stopReason=length for truncation detection', () => {
    const result = extractAssistantEnhancedFields({ stopReason: 'length' });
    expect(result.stopReason).toBe('length');
  });

  it('counts thinking blocks in content array', () => {
    const result = extractAssistantEnhancedFields({
      stopReason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'Let me analyze...' },
        { type: 'text', text: 'Here is the answer' },
        { type: 'thinking', thinking: 'One more thing...' },
      ],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.thinkingBlocksCount).toBe(2);
  });

  it('counts redacted_thinking blocks', () => {
    const result = extractAssistantEnhancedFields({
      content: [
        { type: 'redacted_thinking', data: 'base64...' },
        { type: 'text', text: 'Answer' },
      ],
    });
    expect(result.thinkingBlocksCount).toBe(1);
  });

  it('counts mixed thinking and redacted_thinking blocks', () => {
    const result = extractAssistantEnhancedFields({
      content: [
        { type: 'thinking', thinking: 'a' },
        { type: 'redacted_thinking', data: 'b' },
        { type: 'tool_use', id: 'c', name: 'bash' },
      ],
    });
    expect(result.thinkingBlocksCount).toBe(2);
  });

  it('returns 0 when content array has no thinking blocks', () => {
    const result = extractAssistantEnhancedFields({
      content: [
        { type: 'text', text: 'Just text' },
        { type: 'tool_use', id: '1', name: 'write' },
      ],
    });
    expect(result.thinkingBlocksCount).toBe(0);
  });

  it('returns null thinkingBlocksCount when content is not an array', () => {
    const result = extractAssistantEnhancedFields({
      stopReason: 'end_turn',
      content: 'not an array',
    });
    expect(result.stopReason).toBe('end_turn');
    expect(result.thinkingBlocksCount).toBeNull();
  });

  it('handles content array with non-object elements gracefully', () => {
    const result = extractAssistantEnhancedFields({
      content: [null, undefined, 'string', 42, { type: 'thinking' }],
    });
    expect(result.thinkingBlocksCount).toBe(1);
  });
});
