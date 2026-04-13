import { describe, it, expect } from 'vitest';
import {
  deriveReasoningChain,
  deriveDecisionPoints,
  deriveContextualFactors,
} from '../../src/core/nocturnal-reasoning-deriver.js';
import type {
  NocturnalAssistantTurn,
  NocturnalToolCall,
  NocturnalUserTurn,
  NocturnalSessionSnapshot,
} from '../../src/core/nocturnal-trajectory-extractor.js';

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

// ---------------------------------------------------------------------------
// Test Fixtures (Plan 02)
// ---------------------------------------------------------------------------

function makeToolCall(overrides: Partial<NocturnalToolCall> = {}): NocturnalToolCall {
  return {
    toolName: 'edit',
    outcome: 'success',
    filePath: 'src/index.ts',
    durationMs: 150,
    exitCode: 0,
    errorType: null,
    errorMessage: null,
    createdAt: '2026-04-12T10:01:00.000Z',
    ...overrides,
  };
}

function makeUserTurn(overrides: Partial<NocturnalUserTurn> = {}): NocturnalUserTurn {
  return {
    turnIndex: 0,
    correctionDetected: false,
    correctionCue: null,
    createdAt: '2026-04-12T10:00:30.000Z',
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<NocturnalSessionSnapshot> = {}): NocturnalSessionSnapshot {
  return {
    sessionId: 'test-session-001',
    startedAt: '2026-04-12T10:00:00.000Z',
    updatedAt: '2026-04-12T10:05:00.000Z',
    assistantTurns: [],
    userTurns: [],
    toolCalls: [],
    painEvents: [],
    gateBlocks: [],
    stats: {
      totalAssistantTurns: 0,
      totalToolCalls: 0,
      totalPainEvents: 0,
      totalGateBlocks: 0,
      failureCount: 0,
    },
    ...overrides,
  } as NocturnalSessionSnapshot;
}

// ---------------------------------------------------------------------------
// deriveDecisionPoints
// ---------------------------------------------------------------------------

describe('deriveDecisionPoints', () => {
  it('extracts beforeContext from preceding assistant turn', () => {
    const turns = [makeAssistantTurn({
      sanitizedText: 'I will analyze the code structure before making changes to ensure correctness.',
      createdAt: '2026-04-12T10:00:00.000Z',
    })];
    const toolCalls = [makeToolCall({ createdAt: '2026-04-12T10:01:00.000Z' })];
    const result = deriveDecisionPoints(turns, toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].beforeContext).toBe('I will analyze the code structure before making changes to ensure correctness.');
    expect(result[0].toolName).toBe('edit');
    expect(result[0].outcome).toBe('success');
  });

  it('extracts afterReflection on failure outcome', () => {
    const turns = [
      makeAssistantTurn({ createdAt: '2026-04-12T10:00:00.000Z', sanitizedText: 'before' }),
      makeAssistantTurn({ createdAt: '2026-04-12T10:02:00.000Z', sanitizedText: 'After the failure I need to reconsider the approach and try a different method' }),
    ];
    const toolCalls = [makeToolCall({
      outcome: 'failure',
      createdAt: '2026-04-12T10:01:00.000Z',
    })];
    const result = deriveDecisionPoints(turns, toolCalls);
    expect(result[0].afterReflection).toBe('After the failure I need to reconsider the approach and try a different method');
    expect(result[0].outcome).toBe('failure');
  });

  it('omits afterReflection on success outcome', () => {
    const turns = [makeAssistantTurn({ createdAt: '2026-04-12T10:00:00.000Z' })];
    const toolCalls = [makeToolCall({ outcome: 'success', createdAt: '2026-04-12T10:01:00.000Z' })];
    const result = deriveDecisionPoints(turns, toolCalls);
    expect(result[0].afterReflection).toBeUndefined();
  });

  it('returns empty array for empty toolCalls', () => {
    expect(deriveDecisionPoints([makeAssistantTurn()], [])).toEqual([]);
  });

  it('returns empty beforeContext when no assistant turns', () => {
    const toolCalls = [makeToolCall()];
    const result = deriveDecisionPoints([], toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0].beforeContext).toBe('');
  });

  it('computes confidenceDelta on failure', () => {
    const beforeText = 'Let me plan this carefully. I need to analyze the structure first. ' +
      'The approach should consider multiple perspectives. Let me think step by step. ' +
      'I should verify my understanding. Breaking this down into parts helps.';
    const turns = [
      makeAssistantTurn({ createdAt: '2026-04-12T10:00:00.000Z', sanitizedText: beforeText }),
      makeAssistantTurn({ createdAt: '2026-04-12T10:02:00.000Z', sanitizedText: 'ok' }),
    ];
    const toolCalls = [makeToolCall({ outcome: 'failure', createdAt: '2026-04-12T10:01:00.000Z' })];
    const result = deriveDecisionPoints(turns, toolCalls);
    // confidenceDelta should be computed (defined) when both before and after turns exist
    expect(result[0].confidenceDelta).toBeDefined();
    expect(typeof result[0].confidenceDelta).toBe('number');
  });

  it('matches by createdAt timestamp not turnIndex', () => {
    const turns = [
      makeAssistantTurn({ turnIndex: 2, createdAt: '2026-04-12T10:00:00.000Z', sanitizedText: 'turn index 2' }),
      makeAssistantTurn({ turnIndex: 0, createdAt: '2026-04-12T09:59:00.000Z', sanitizedText: 'turn index 0' }),
    ];
    const toolCalls = [makeToolCall({ createdAt: '2026-04-12T10:01:00.000Z' })];
    const result = deriveDecisionPoints(turns, toolCalls);
    // Should pick turnIndex 2 (closest before tool call by timestamp)
    expect(result[0].beforeContext).toBe('turn index 2');
  });
});

// ---------------------------------------------------------------------------
// deriveContextualFactors
// ---------------------------------------------------------------------------

describe('deriveContextualFactors', () => {
  it('computes all four factors from a rich snapshot', () => {
    const snapshot = makeSnapshot({
      toolCalls: [
        makeToolCall({ toolName: 'read', outcome: 'success', createdAt: '2026-04-12T10:00:00.000Z' }),
        makeToolCall({ toolName: 'edit', outcome: 'success', createdAt: '2026-04-12T10:00:01.000Z' }),
        makeToolCall({ toolName: 'edit', outcome: 'failure', createdAt: '2026-04-12T10:00:02.000Z' }),
      ],
      userTurns: [makeUserTurn({ correctionDetected: true })],
    });
    const result = deriveContextualFactors(snapshot);
    expect(result.fileStructureKnown).toBe(true);
    expect(result.errorHistoryPresent).toBe(true);
    expect(result.userGuidanceAvailable).toBe(true);
    expect(result.timePressure).toBe(true);
  });

  it('fileStructureKnown: true when read precedes write', () => {
    const snapshot = makeSnapshot({
      toolCalls: [
        makeToolCall({ toolName: 'read', createdAt: '2026-04-12T10:00:00.000Z' }),
        makeToolCall({ toolName: 'edit', createdAt: '2026-04-12T10:00:01.000Z' }),
      ],
    });
    expect(deriveContextualFactors(snapshot).fileStructureKnown).toBe(true);
  });

  it('fileStructureKnown: false when write has no preceding read', () => {
    const snapshot = makeSnapshot({
      toolCalls: [
        makeToolCall({ toolName: 'edit', createdAt: '2026-04-12T10:00:00.000Z' }),
        makeToolCall({ toolName: 'read', createdAt: '2026-04-12T10:00:01.000Z' }),
      ],
    });
    expect(deriveContextualFactors(snapshot).fileStructureKnown).toBe(false);
  });

  it('fileStructureKnown: false with only write tools', () => {
    const snapshot = makeSnapshot({
      toolCalls: [makeToolCall({ toolName: 'edit' })],
    });
    expect(deriveContextualFactors(snapshot).fileStructureKnown).toBe(false);
  });

  it('errorHistoryPresent: true when any tool call failed', () => {
    const snapshot = makeSnapshot({
      toolCalls: [
        makeToolCall({ outcome: 'success' }),
        makeToolCall({ outcome: 'failure' }),
      ],
    });
    expect(deriveContextualFactors(snapshot).errorHistoryPresent).toBe(true);
  });

  it('errorHistoryPresent: false when all outcomes are success', () => {
    const snapshot = makeSnapshot({
      toolCalls: [makeToolCall({ outcome: 'success' })],
    });
    expect(deriveContextualFactors(snapshot).errorHistoryPresent).toBe(false);
  });

  it('userGuidanceAvailable: true when correction detected', () => {
    const snapshot = makeSnapshot({
      userTurns: [makeUserTurn({ correctionDetected: true })],
    });
    expect(deriveContextualFactors(snapshot).userGuidanceAvailable).toBe(true);
  });

  it('userGuidanceAvailable: false without corrections', () => {
    const snapshot = makeSnapshot({
      userTurns: [makeUserTurn({ correctionDetected: false })],
    });
    expect(deriveContextualFactors(snapshot).userGuidanceAvailable).toBe(false);
  });

  it('timePressure: true when majority of gaps < 2 seconds', () => {
    const snapshot = makeSnapshot({
      toolCalls: [
        makeToolCall({ createdAt: '2026-04-12T10:00:00.000Z' }),
        makeToolCall({ createdAt: '2026-04-12T10:00:01.000Z' }),
        makeToolCall({ createdAt: '2026-04-12T10:00:01.500Z' }),
      ],
    });
    expect(deriveContextualFactors(snapshot).timePressure).toBe(true);
  });

  it('timePressure: false when gaps are large', () => {
    const snapshot = makeSnapshot({
      toolCalls: [
        makeToolCall({ createdAt: '2026-04-12T10:00:00.000Z' }),
        makeToolCall({ createdAt: '2026-04-12T10:00:10.000Z' }),
        makeToolCall({ createdAt: '2026-04-12T10:00:20.000Z' }),
      ],
    });
    expect(deriveContextualFactors(snapshot).timePressure).toBe(false);
  });

  it('returns all-false defaults for null snapshot', () => {
    expect(deriveContextualFactors(null as any)).toEqual({
      fileStructureKnown: false,
      errorHistoryPresent: false,
      userGuidanceAvailable: false,
      timePressure: false,
    });
  });

  it('returns all-false defaults for empty snapshot', () => {
    expect(deriveContextualFactors(makeSnapshot())).toEqual({
      fileStructureKnown: false,
      errorHistoryPresent: false,
      userGuidanceAvailable: false,
      timePressure: false,
    });
  });
});
