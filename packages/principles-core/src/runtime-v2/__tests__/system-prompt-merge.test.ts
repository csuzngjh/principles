import { describe, it, expect } from 'vitest';
import { mergeSystemPromptLayers } from '../system-prompt-merge.js';

describe('mergeSystemPromptLayers (PRI-633)', () => {
  it('joins layers with a blank line in the order given', () => {
    expect(mergeSystemPromptLayers('BASE', 'TOOL', 'APPEND')).toBe('BASE\n\nTOOL\n\nAPPEND');
  });

  it('keeps surviving layers byte-exact (no trimming of real content)', () => {
    const base = 'You are a Dreamer agent.\nCONSTRAINTS:\n- Output ONLY valid JSON\n';
    expect(mergeSystemPromptLayers(base, 'APPEND')).toBe(`${base}\n\nAPPEND`);
  });

  it('drops whitespace-only layers', () => {
    expect(mergeSystemPromptLayers('   ', 'BASE', '', 'APPEND')).toBe('BASE\n\nAPPEND');
  });

  it('returns undefined when every layer is absent/blank', () => {
    expect(mergeSystemPromptLayers()).toBeUndefined();
    expect(mergeSystemPromptLayers(undefined, '')).toBeUndefined();
    expect(mergeSystemPromptLayers('   ')).toBeUndefined();
    expect(mergeSystemPromptLayers(null)).toBeUndefined();
  });

  it('returns the single layer unchanged when only one survives', () => {
    expect(mergeSystemPromptLayers(undefined, 'ONLY')).toBe('ONLY');
  });
});
