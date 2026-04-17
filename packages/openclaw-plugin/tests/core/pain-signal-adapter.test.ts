import { describe, it, expect } from 'vitest';
import type { PainSignalAdapter } from '../../src/core/pain-signal-adapter.js';
import type { PainSignal } from '../../src/core/pain-signal.js';
import { validatePainSignal } from '../../src/core/pain-signal.js';

// ---------------------------------------------------------------------------
// Mock Framework Event
// ---------------------------------------------------------------------------

/** Simulated framework-specific event for testing */
interface MockToolCallEvent {
  toolName: string;
  success: boolean;
  errorMessage?: string;
  sessionId: string;
  agentId: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Test Adapter Implementation
// ---------------------------------------------------------------------------

/** Test adapter that translates MockToolCallEvent to PainSignal */
const mockAdapter: PainSignalAdapter<MockToolCallEvent> = {
  capture(event: MockToolCallEvent): PainSignal | null {
    // Per D-02: pure translation. Only failed tool calls produce signals.
    if (event.success) return null;

    // Return null for malformed events
    if (!event.toolName || !event.errorMessage) return null;

    return {
      source: 'tool_failure',
      score: 75,
      timestamp: event.timestamp,
      reason: `Tool ${event.toolName} failed: ${event.errorMessage}`,
      sessionId: event.sessionId,
      agentId: event.agentId,
      traceId: `test-${Date.now()}`,
      triggerTextPreview: event.errorMessage.slice(0, 100),
      domain: 'coding',
      severity: 'high',
      context: { toolName: event.toolName },
    };
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockToolFailure(overrides: Partial<MockToolCallEvent> = {}): MockToolCallEvent {
  return {
    toolName: 'edit_file',
    success: false,
    errorMessage: 'File not found: test.ts',
    sessionId: 'session-001',
    agentId: 'main',
    timestamp: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PainSignalAdapter', () => {
  it('captures a failed tool call as PainSignal', () => {
    const result = mockAdapter.capture(mockToolFailure());
    expect(result).not.toBeNull();
    expect(result!.source).toBe('tool_failure');
  });

  it('returns null for successful tool calls', () => {
    const result = mockAdapter.capture({ success: true } as MockToolCallEvent);
    expect(result).toBeNull();
  });

  it('returns null for malformed events missing toolName', () => {
    const result = mockAdapter.capture({
      success: false,
      toolName: '',
      errorMessage: 'err',
      sessionId: 's-1',
      agentId: 'a-1',
      timestamp: '2026-04-17T00:00:00.000Z',
    });
    expect(result).toBeNull();
  });

  it('returns null for malformed events missing errorMessage', () => {
    const result = mockAdapter.capture({
      success: false,
      toolName: 'edit',
      errorMessage: undefined,
      sessionId: 's-1',
      agentId: 'a-1',
      timestamp: '2026-04-17T00:00:00.000Z',
    });
    expect(result).toBeNull();
  });

  it('produces signals that pass validatePainSignal', () => {
    const signal = mockAdapter.capture(mockToolFailure());
    expect(signal).not.toBeNull();
    const result = validatePainSignal(signal!);
    expect(result.valid).toBe(true);
  });

  it('satisfies the PainSignalAdapter interface type contract', () => {
    const adapter: PainSignalAdapter<MockToolCallEvent> = mockAdapter;
    expect(typeof adapter.capture).toBe('function');
  });
});
