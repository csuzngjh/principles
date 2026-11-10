/**
 * PRI-1146 P1-01: StoreEventEmitter must deliver the two newly registered
 * skip/degradation events verbatim — never silently rewriting them to
 * `degradation_triggered` — while the strict unregistered-event fallback stays
 * intact (negative control).
 */
import { describe, it, expect } from 'vitest';
import { StoreEventEmitter } from './event-emitter.js';
import type { TelemetryEvent } from '../../telemetry-event.js';

function makeEvent(eventType: string, payload: Record<string, unknown> = {}): TelemetryEvent {
  return {
    eventType,
    traceId: 'trace-001',
    timestamp: '2026-11-10T00:00:00.000Z',
    sessionId: 'session-001',
    payload,
  } as unknown as TelemetryEvent;
}

describe('StoreEventEmitter — PRI-1146 registered events pass through unchanged', () => {
  it('delivers diag_router_trusted_context_unavailable without a degradation rewrite', () => {
    const emitter = new StoreEventEmitter();
    const received: TelemetryEvent[] = [];
    emitter.onTelemetry((event) => received.push(event));

    expect(emitter.emitTelemetry(makeEvent('diag_router_trusted_context_unavailable', { reason: 'ledger_corrupt' }))).toBe(true);

    expect(received).toHaveLength(1);
    expect(received[0]?.eventType).toBe('diag_router_trusted_context_unavailable');
    expect(received[0]?.payload).toEqual({ reason: 'ledger_corrupt' });
    expect(received.some((event) => event.eventType === 'degradation_triggered')).toBe(false);
  });

  it('delivers replay_review_source_invalid on the named channel without a degradation rewrite', () => {
    const emitter = new StoreEventEmitter();
    const received: TelemetryEvent[] = [];
    emitter.onEventType('replay_review_source_invalid', (event) => received.push(event));

    expect(emitter.emitTelemetry(makeEvent('replay_review_source_invalid', {
      candidateId: 'cand-001',
      reason: 'owning_output_unparseable',
      nextAction: 'Re-run the diagnosis via the supported CLI command.',
    }))).toBe(true);

    expect(received).toHaveLength(1);
    expect(received[0]?.eventType).toBe('replay_review_source_invalid');
    expect(received[0]?.payload).toMatchObject({ candidateId: 'cand-001', reason: 'owning_output_unparseable' });
  });

  it('negative: an unregistered event type is still strictly rejected and degrades observably', () => {
    const emitter = new StoreEventEmitter();
    const received: TelemetryEvent[] = [];
    emitter.onTelemetry((event) => received.push(event));
    const namedChannel: TelemetryEvent[] = [];
    emitter.onEventType('diag_router_definitely_not_registered', (event) => namedChannel.push(event));

    emitter.emitTelemetry(makeEvent('diag_router_definitely_not_registered', { probe: true }));

    // Validation-invalid fallback: exactly one degradation event, and the
    // unregistered name never appears on the wire as an event type.
    expect(received).toHaveLength(1);
    expect(received[0]?.eventType).toBe('degradation_triggered');
    expect(received[0]?.payload).toMatchObject({
      component: 'StoreEventEmitter',
      trigger: 'invalid_event',
      fallback: 'dropped',
      severity: 'warning',
    });
    expect(namedChannel).toHaveLength(0);
    const deliveredTypes: string[] = received.map((event) => event.eventType);
    expect(deliveredTypes).not.toContain('diag_router_definitely_not_registered');
  });
});