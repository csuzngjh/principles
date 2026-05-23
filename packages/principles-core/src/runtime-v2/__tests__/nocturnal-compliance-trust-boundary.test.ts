import { describe, it, expect } from 'vitest';
import {
  groupEventsIntoSessions,
  type RawEventEntry,
  type SessionEvents,
} from '../nocturnal/nocturnal-compliance.js';
import {
  validatePainSignal,
} from '../types/pain-signal.js';

function makeEvent(overrides: Partial<RawEventEntry> & { type: RawEventEntry['type']; data: Record<string, unknown> }): RawEventEntry {
  return {
    ts: '2025-01-01T00:00:00Z',
    sessionId: 'test-session',
    ...overrides,
  };
}

function getSession(events: RawEventEntry[]): SessionEvents {
  const sessions = groupEventsIntoSessions(events);
  const session = sessions.get('test-session');
  expect(session).toBeDefined();
  return session as SessionEvents;
}

describe('nocturnal-compliance trust boundary', () => {
  describe('groupEventsIntoSessions — non-string toolName', () => {
    it('rejects numeric toolName, yields "unknown"', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'tool_call', data: { toolName: 42 } }),
      ];
      const session = getSession(events);
      expect(session.toolCalls[0]?.toolName).toBe('unknown');
    });

    it('rejects array toolName, yields "unknown"', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'tool_call', data: { toolName: ['Write'] } }),
      ];
      const session = getSession(events);
      expect(session.toolCalls[0]?.toolName).toBe('unknown');
    });
  });

  describe('groupEventsIntoSessions — non-string filePath', () => {
    it('rejects object filePath, yields undefined', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'tool_call', data: { toolName: 'Write', filePath: { malicious: true } } }),
      ];
      const session = getSession(events);
      expect(session.toolCalls[0]?.filePath).toBeUndefined();
    });

    it('rejects numeric filePath, yields undefined', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'tool_call', data: { toolName: 'Write', filePath: 123 } }),
      ];
      const session = getSession(events);
      expect(session.toolCalls[0]?.filePath).toBeUndefined();
    });
  });

  describe('groupEventsIntoSessions — score NaN/Infinity', () => {
    it('rejects NaN score, yields 0', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'pain_signal', data: { score: NaN, source: 'test' } }),
      ];
      const session = getSession(events);
      expect(session.painSignals[0]?.score).toBe(0);
    });

    it('rejects Infinity score, yields 0', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'pain_signal', data: { score: Infinity, source: 'test' } }),
      ];
      const session = getSession(events);
      expect(session.painSignals[0]?.score).toBe(0);
    });

    it('rejects -Infinity score, yields 0', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'pain_signal', data: { score: -Infinity, source: 'test' } }),
      ];
      const session = getSession(events);
      expect(session.painSignals[0]?.score).toBe(0);
    });
  });

  describe('groupEventsIntoSessions — invalid severity', () => {
    it('rejects unknown severity string, yields undefined', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'pain_signal', data: { score: 50, source: 'test', severity: 'critical' } }),
      ];
      const session = getSession(events);
      expect(session.painSignals[0]?.severity).toBeUndefined();
    });

    it('rejects numeric severity, yields undefined', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'pain_signal', data: { score: 50, source: 'test', severity: 3 } }),
      ];
      const session = getSession(events);
      expect(session.painSignals[0]?.severity).toBeUndefined();
    });
  });

  describe('groupEventsIntoSessions — malformed nested values', () => {
    it('does not crash and does not promote untrusted values', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'tool_call', data: { toolName: [1, 2, 3] } }),
        makeEvent({ type: 'pain_signal', data: { toolName: [1, 2, 3], score: 'high', source: 99 } }),
      ];
      const session = getSession(events);
      expect(session.toolCalls).toHaveLength(1);
      expect(session.toolCalls[0]?.toolName).toBe('unknown');
      expect(session.painSignals[0]?.source).toBe('unknown');
      expect(session.painSignals[0]?.score).toBe(0);
    });
  });

  describe('groupEventsIntoSessions — valid data preserved', () => {
    it('preserves all valid fields correctly', () => {
      const events: RawEventEntry[] = [
        makeEvent({ type: 'tool_call', data: { toolName: 'Write', filePath: '/foo.ts' } }),
        makeEvent({ type: 'pain_signal', data: { source: 'tool_failure', score: 0.8, severity: 'moderate', reason: 'test reason' } }),
        makeEvent({ type: 'gate_block', data: { toolName: 'bash', filePath: '/bar.sh', reason: 'dangerous command' } }),
        makeEvent({ type: 'plan_approval', data: { toolName: 'Read', filePath: '/baz.ts' } }),
      ];
      const session = getSession(events);

      expect(session.toolCalls[0]?.toolName).toBe('Write');
      expect(session.toolCalls[0]?.filePath).toBe('/foo.ts');

      expect(session.painSignals[0]?.source).toBe('tool_failure');
      expect(session.painSignals[0]?.score).toBe(0.8);
      expect(session.painSignals[0]?.severity).toBe('moderate');
      expect(session.painSignals[0]?.reason).toBe('test reason');

      expect(session.gateBlocks[0]?.toolName).toBe('bash');
      expect(session.gateBlocks[0]?.filePath).toBe('/bar.sh');
      expect(session.gateBlocks[0]?.reason).toBe('dangerous command');

      expect(session.planApprovals[0]?.toolName).toBe('Read');
      expect(session.planApprovals[0]?.filePath).toBe('/baz.ts');
    });
  });

  describe('validatePainSignal — malformed unknown input', () => {
    it('rejects null', () => {
      const result = validatePainSignal(null);
      expect(result.valid).toBe(false);
    });

    it('rejects string', () => {
      const result = validatePainSignal('string');
      expect(result.valid).toBe(false);
    });

    it('rejects number', () => {
      const result = validatePainSignal(42);
      expect(result.valid).toBe(false);
    });

    it('rejects array', () => {
      const result = validatePainSignal([]);
      expect(result.valid).toBe(false);
    });

    it('rejects undefined', () => {
      const result = validatePainSignal(undefined);
      expect(result.valid).toBe(false);
    });

    it('rejects boolean', () => {
      const result = validatePainSignal(true);
      expect(result.valid).toBe(false);
    });
  });
});

describe('plugin re-export compatibility', () => {
  it('exposes groupEventsIntoSessions from @principles/core/runtime-v2', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.groupEventsIntoSessions).toBe('function');
  });

  it('exposes validatePainSignal from @principles/core/runtime-v2', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.validatePainSignal).toBe('function');
  });

  it('exposes detectOpportunity from @principles/core/runtime-v2', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.detectOpportunity).toBe('function');
  });

  it('exposes computeCompliance from @principles/core/runtime-v2', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.computeCompliance).toBe('function');
  });
});
