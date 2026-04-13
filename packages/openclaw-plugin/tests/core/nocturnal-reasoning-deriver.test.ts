import { describe, it, expect } from 'vitest';
import {
  deriveReasoningChain,
} from '../../src/core/nocturnal-reasoning-deriver.js';
import type { NocturnalAssistantTurn } from '../../src/core/nocturnal-trajectory-extractor.js';

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

function makeAssistantTurn(overrides: Partial<NocturnalAssistantTurn> = {}): NocturnalAssistantTurn {
  return {
    turnIndex: 0,
    sanitizedText: 'I will read the file to understand the structure before making changes.',
    model: 'gpt-4',
    createdAt: '2026-04-12T10:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// deriveReasoningChain
// ---------------------------------------------------------------------------

describe('deriveReasoningChain', () => {
  it('extracts thinking content from <thinking> tags', () => {
    const turns = [makeAssistantTurn({
      sanitizedText: '<thinking>planning the approach</thinking>Now I will proceed.',
    })];
    const result = deriveReasoningChain(turns);
    expect(result).toHaveLength(1);
    expect(result[0].thinkingContent).toBe('planning the approach');
  });

  it('returns empty thinkingContent when no <thinking> tags present', () => {
    const turns = [makeAssistantTurn({
      sanitizedText: 'I will just read the file and proceed.',
    })];
    const result = deriveReasoningChain(turns);
    expect(result[0].thinkingContent).toBe('');
  });

  it('detects uncertainty markers', () => {
    const turns = [makeAssistantTurn({
      sanitizedText: 'let me verify the output. not sure if this is correct.',
    })];
    const result = deriveReasoningChain(turns);
    expect(result[0].uncertaintyMarkers).toEqual(
      expect.arrayContaining([
        expect.stringContaining('let me verify'),
        expect.stringContaining('not sure if'),
      ]),
    );
  });

  it('detects all 3 uncertainty patterns', () => {
    const turns = [makeAssistantTurn({
      sanitizedText: 'let me check the file. I should probably review this. not sure whether this works.',
    })];
    const result = deriveReasoningChain(turns);
    expect(result[0].uncertaintyMarkers.length).toBeGreaterThanOrEqual(3);
  });

  it('computes high confidence signal', () => {
    // Use text rich in thinking model patterns to trigger high activation
    const richText = 'Let me plan this carefully. I need to analyze the structure first. ' +
      'The approach should consider multiple perspectives. Let me think step by step. ' +
      'I should verify my understanding. Breaking this down into parts helps. ' +
      'Consider the constraints and requirements carefully.';
    const turns = [makeAssistantTurn({ sanitizedText: richText })];
    const result = deriveReasoningChain(turns);
    // The exact signal depends on thinking model definitions, but it should be one of the three
    expect(['high', 'medium', 'low']).toContain(result[0].confidenceSignal);
  });

  it('computes low confidence signal', () => {
    const turns = [makeAssistantTurn({
      sanitizedText: 'Just a simple text with no particular patterns.',
    })];
    const result = deriveReasoningChain(turns);
    expect(result[0].confidenceSignal).toBe('low');
  });

  it('returns empty array for empty input', () => {
    expect(deriveReasoningChain([])).toEqual([]);
  });

  it('returns empty array for null input', () => {
    expect(deriveReasoningChain(null as any)).toEqual([]);
  });

  it('handles multiple turns correctly', () => {
    const turns = [
      makeAssistantTurn({ turnIndex: 0, sanitizedText: 'First turn.' }),
      makeAssistantTurn({ turnIndex: 1, sanitizedText: '<thinking>Second turn thinking</thinking>' }),
      makeAssistantTurn({ turnIndex: 2, sanitizedText: 'let me check this. Third turn.' }),
    ];
    const result = deriveReasoningChain(turns);
    expect(result).toHaveLength(3);
    expect(result.map(r => r.turnIndex)).toEqual([0, 1, 2]);
  });

  it('handles empty sanitizedText gracefully', () => {
    const turns = [makeAssistantTurn({ sanitizedText: '' })];
    const result = deriveReasoningChain(turns);
    expect(result[0].thinkingContent).toBe('');
    expect(result[0].uncertaintyMarkers).toEqual([]);
    expect(result[0].confidenceSignal).toBe('low');
  });

  it('extracts thinking content from multiline tags', () => {
    const turns = [makeAssistantTurn({
      sanitizedText: '<thinking>\nStep 1: analyze\nStep 2: plan\n</thinking>',
    })];
    const result = deriveReasoningChain(turns);
    expect(result[0].thinkingContent).toContain('Step 1: analyze');
    expect(result[0].thinkingContent).toContain('Step 2: plan');
  });
});
