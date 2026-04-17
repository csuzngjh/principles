import { describe, it, expect } from 'vitest';
import { TelemetryEventSchema, validateTelemetryEvent, type TelemetryEvent } from '../../src/core/telemetry-event.js';
import { Value } from '@sinclair/typebox/value';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validEvent(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    eventType: 'pain_detected',
    traceId: 'trace-001',
    timestamp: '2026-04-17T00:00:00.000Z',
    sessionId: 'session-001',
    payload: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetryEventSchema', () => {
  it('accepts a valid pain_detected event', () => {
    expect(Value.Check(TelemetryEventSchema, validEvent())).toBe(true);
  });

  it('accepts a valid principle_candidate_created event', () => {
    expect(Value.Check(TelemetryEventSchema, validEvent({ eventType: 'principle_candidate_created' }))).toBe(true);
  });

  it('accepts a valid principle_promoted event', () => {
    expect(Value.Check(TelemetryEventSchema, validEvent({ eventType: 'principle_promoted' }))).toBe(true);
  });

  it('accepts an event with optional agentId', () => {
    expect(Value.Check(TelemetryEventSchema, validEvent({ agentId: 'main' }))).toBe(true);
  });

  it('accepts an event with payload data', () => {
    expect(Value.Check(TelemetryEventSchema, validEvent({ payload: { toolName: 'edit_file', error: 'not found' } }))).toBe(true);
  });

  it('rejects an event with invalid eventType', () => {
    expect(Value.Check(TelemetryEventSchema, validEvent({ eventType: 'invalid_event' as TelemetryEvent['eventType'] }))).toBe(false);
  });

  it('rejects an event missing traceId', () => {
    expect(Value.Check(TelemetryEventSchema, { ...validEvent(), traceId: undefined })).toBe(false);
  });

  it('rejects an event missing timestamp', () => {
    expect(Value.Check(TelemetryEventSchema, { ...validEvent(), timestamp: undefined })).toBe(false);
  });

  it('rejects an event missing sessionId', () => {
    expect(Value.Check(TelemetryEventSchema, { ...validEvent(), sessionId: undefined })).toBe(false);
  });

  it('rejects an event missing eventType', () => {
    expect(Value.Check(TelemetryEventSchema, { ...validEvent(), eventType: undefined })).toBe(false);
  });

  it('rejects an event missing payload', () => {
    expect(Value.Check(TelemetryEventSchema, { ...validEvent(), payload: undefined })).toBe(false);
  });

  it('rejects a non-object input', () => {
    expect(Value.Check(TelemetryEventSchema, 'not an object')).toBe(false);
  });
});

describe('validateTelemetryEvent', () => {
  it('returns valid:true for a valid event', () => {
    const result = validateTelemetryEvent(validEvent());
    expect(result.valid).toBe(true);
    expect(result.event).toBeDefined();
  });

  it('returns the typed event when valid', () => {
    const result = validateTelemetryEvent(validEvent({ traceId: 'test-123' }));
    expect(result.valid).toBe(true);
    expect(result.event?.traceId).toBe('test-123');
  });

  it('returns valid:false for non-object input', () => {
    const result = validateTelemetryEvent('string');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns valid:false for null input', () => {
    const result = validateTelemetryEvent(null);
    expect(result.valid).toBe(false);
  });

  it('returns valid:false for array input', () => {
    const result = validateTelemetryEvent([]);
    expect(result.valid).toBe(false);
  });

  it('returns errors for missing required fields', () => {
    const result = validateTelemetryEvent({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns errors for invalid eventType', () => {
    const result = validateTelemetryEvent({ ...validEvent(), eventType: 'not_a_real_event' });
    expect(result.valid).toBe(false);
  });

  it('accepts event without agentId (optional field)', () => {
    const result = validateTelemetryEvent(validEvent());
    expect(result.valid).toBe(true);
    expect(result.event?.agentId).toBeUndefined();
  });
});
