import { describe, it, expect } from 'vitest';
import type { EvolutionHook, PrincipleCreatedEvent, PrinciplePromotedEvent } from '../../src/core/evolution-hook.js';
import { noOpEvolutionHook } from '../../src/core/evolution-hook.js';
import type { PainSignal } from '../../src/core/pain-signal.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validPainSignal(overrides: Partial<PainSignal> = {}): PainSignal {
  return {
    source: 'tool_failure',
    score: 75,
    timestamp: '2026-04-17T00:00:00.000Z',
    reason: 'File not found',
    sessionId: 'session-001',
    agentId: 'main',
    traceId: 'trace-001',
    triggerTextPreview: 'File not found: test.ts',
    domain: 'coding',
    severity: 'high',
    context: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EvolutionHook', () => {
  it('implements all 3 methods', () => {
    const calls: string[] = [];
    const hook: EvolutionHook = {
      onPainDetected(signal: PainSignal): void { calls.push(`pain:${signal.source}`); },
      onPrincipleCreated(event: PrincipleCreatedEvent): void { calls.push(`created:${event.id}`); },
      onPrinciplePromoted(event: PrinciplePromotedEvent): void { calls.push(`promoted:${event.id}`); },
    };

    hook.onPainDetected(validPainSignal());
    hook.onPrincipleCreated({ id: 'p-1', text: 'Test principle', trigger: 'tool failure' });
    hook.onPrinciplePromoted({ id: 'p-1', from: 'candidate', to: 'active' });

    expect(calls).toEqual(['pain:tool_failure', 'created:p-1', 'promoted:p-1']);
  });

  it('onPainDetected receives a PainSignal', () => {
    let received: PainSignal | undefined;
    const hook: EvolutionHook = {
      ...noOpEvolutionHook,
      onPainDetected(signal: PainSignal): void { received = signal; },
    };

    const signal = validPainSignal();
    hook.onPainDetected(signal);
    expect(received).toEqual(signal);
  });

  it('onPrincipleCreated receives a PrincipleCreatedEvent', () => {
    let received: PrincipleCreatedEvent | undefined;
    const hook: EvolutionHook = {
      ...noOpEvolutionHook,
      onPrincipleCreated(event: PrincipleCreatedEvent): void { received = event; },
    };

    const event = { id: 'p-1', text: 'Test principle', trigger: 'tool failure' };
    hook.onPrincipleCreated(event);
    expect(received).toEqual(event);
  });

  it('onPrinciplePromoted receives a PrinciplePromotedEvent', () => {
    let received: PrinciplePromotedEvent | undefined;
    const hook: EvolutionHook = {
      ...noOpEvolutionHook,
      onPrinciplePromoted(event: PrinciplePromotedEvent): void { received = event; },
    };

    const event = { id: 'p-1', from: 'candidate', to: 'active' };
    hook.onPrinciplePromoted(event);
    expect(received).toEqual(event);
  });
});

describe('noOpEvolutionHook', () => {
  it('implements all 3 methods as no-ops', () => {
    expect(() => {
      noOpEvolutionHook.onPainDetected(validPainSignal());
      noOpEvolutionHook.onPrincipleCreated({ id: 'p-1', text: 'Test', trigger: 'test' });
      noOpEvolutionHook.onPrinciplePromoted({ id: 'p-1', from: 'candidate', to: 'active' });
    }).not.toThrow();
  });

  it('can be spread to override individual methods', () => {
    const calls: string[] = [];
    const hook: EvolutionHook = {
      ...noOpEvolutionHook,
      onPainDetected(_signal: PainSignal): void { calls.push('pain'); },
    };

    hook.onPainDetected(validPainSignal());
    hook.onPrincipleCreated({ id: 'p-1', text: 'Test', trigger: 'test' });

    expect(calls).toEqual(['pain']);
  });
});

describe('PrincipleCreatedEvent', () => {
  it('has required fields: id, text, trigger', () => {
    const event: PrincipleCreatedEvent = { id: 'p-1', text: 'Always verify', trigger: 'tool failure' };
    expect(event.id).toBe('p-1');
    expect(event.text).toBe('Always verify');
    expect(event.trigger).toBe('tool failure');
  });
});

describe('PrinciplePromotedEvent', () => {
  it('has required fields: id, from, to', () => {
    const event: PrinciplePromotedEvent = { id: 'p-1', from: 'candidate', to: 'active' };
    expect(event.id).toBe('p-1');
    expect(event.from).toBe('candidate');
    expect(event.to).toBe('active');
  });
});
