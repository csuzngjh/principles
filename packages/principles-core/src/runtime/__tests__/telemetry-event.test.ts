import { describe, it, expect } from 'vitest';
import { validateTelemetryEvent } from '../../telemetry-event.js';

describe('TelemetryEvent schema — runner event registration', () => {
  it('accepts artificer_implementation_plan_generated event', () => {
    const event = {
      eventType: 'artificer_implementation_plan_generated',
      traceId: 'trace-001',
      timestamp: new Date().toISOString(),
      sessionId: 'session-001',
      payload: { implementationSummary: 'test', targetSurface: 'core', confidence: 0.9 },
    };
    const result = validateTelemetryEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.event?.eventType).toBe('artificer_implementation_plan_generated');
  });

  it('accepts evaluator_output_validated event', () => {
    const event = {
      eventType: 'evaluator_output_validated',
      traceId: 'trace-002',
      timestamp: new Date().toISOString(),
      sessionId: 'session-002',
      payload: { validated: true },
    };
    const result = validateTelemetryEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.event?.eventType).toBe('evaluator_output_validated');
  });

  it('accepts scribe_principle_draft_generated event', () => {
    const event = {
      eventType: 'scribe_principle_draft_generated',
      traceId: 'trace-003',
      timestamp: new Date().toISOString(),
      sessionId: 'session-003',
      payload: { draftTitle: 'Avoid X', draftContent: 'Do not do X' },
    };
    const result = validateTelemetryEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.event?.eventType).toBe('scribe_principle_draft_generated');
  });

  it('accepts evaluator_decision_recorded event', () => {
    const event = {
      eventType: 'evaluator_decision_recorded',
      traceId: 'trace-005',
      timestamp: new Date().toISOString(),
      sessionId: 'session-005',
      payload: { decision: 'approved', score: 0.9 },
    };
    const result = validateTelemetryEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.event?.eventType).toBe('evaluator_decision_recorded');
  });

  it('accepts diag_router_trusted_context_unavailable event (PRI-1146)', () => {
    const event = {
      eventType: 'diag_router_trusted_context_unavailable',
      traceId: 'diag_router-diagnosis_pain-001',
      timestamp: new Date().toISOString(),
      sessionId: 'session-p1-01',
      agentId: 'diagnostician',
      payload: { reason: 'ledger_unavailable' },
    };
    const result = validateTelemetryEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.event?.eventType).toBe('diag_router_trusted_context_unavailable');
  });

  it('accepts replay_review_source_invalid event (PRI-1146 G6)', () => {
    const event = {
      eventType: 'replay_review_source_invalid',
      traceId: 'cand-001',
      timestamp: new Date().toISOString(),
      sessionId: 'pd-cli-diagnose',
      payload: {
        candidateId: 'cand-001',
        reason: 'owning_output_not_v2',
        nextAction: 'Re-run the diagnosis so the candidate is minted from a V2 artifact.',
      },
    };
    const result = validateTelemetryEvent(event);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.event?.eventType).toBe('replay_review_source_invalid');
  });

  it('rejects unknown event type artificer_nonexistent_event', () => {
    const event = {
      eventType: 'artificer_nonexistent_event',
      traceId: 'trace-004',
      timestamp: new Date().toISOString(),
      sessionId: 'session-004',
      payload: {},
    };
    const result = validateTelemetryEvent(event);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
