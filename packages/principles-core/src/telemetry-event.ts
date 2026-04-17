/**
 * TelemetryEvent schema for the Evolution SDK.
 *
 * TypeBox schema describing the shape of in-process evolution events.
 * Per D-07, this is a documentation artifact -- the existing EvolutionLogger
 * output should conform to this schema. No new TelemetryService is created.
 *
 * Per D-08, covers the 3 core events aligned with EvolutionHook:
 * - pain_detected (maps to EvolutionStage 'pain_detected')
 * - principle_candidate_created (maps to EvolutionStage 'principle_generated')
 * - principle_promoted (maps to EvolutionStage 'completed')
 *
 * Injection and storage events are out of scope for this phase.
 */
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

// ---------------------------------------------------------------------------
// Event Type Union
// ---------------------------------------------------------------------------

/**
 * The 3 core telemetry event types, aligned with EvolutionHook methods.
 *
 * Mapping to existing EvolutionLogger stages:
 * - pain_detected -> EvolutionStage 'pain_detected'
 * - principle_candidate_created -> EvolutionStage 'principle_generated'
 * - principle_promoted -> EvolutionStage 'completed'
 */
export const TelemetryEventType = Type.Union([
  Type.Literal('pain_detected'),
  Type.Literal('principle_candidate_created'),
  Type.Literal('principle_promoted'),
]);

// eslint-disable-next-line @typescript-eslint/no-redeclare
export type TelemetryEventType = Static<typeof TelemetryEventType>;

// ---------------------------------------------------------------------------
// TelemetryEvent Schema
// ---------------------------------------------------------------------------

/**
 * Schema for an in-process telemetry event.
 *
 * Fields align with existing EvolutionLogEntry:
 * - traceId <-> EvolutionLogEntry.traceId
 * - timestamp <-> EvolutionLogEntry.timestamp
 * - sessionId <-> EvolutionLogEntry.sessionId
 * - payload <-> EvolutionLogEntry.metadata
 *
 * No PII fields. The agentId field is optional and contains only
 * system identifiers (e.g., 'main', 'builder'), never user data.
 */
export const TelemetryEventSchema = Type.Object({
  /** Event type (one of the 3 core types) */
  eventType: TelemetryEventType,
  /** Correlation trace ID for linking events across the pipeline */
  traceId: Type.String({ minLength: 1 }),
  /** ISO 8601 timestamp */
  timestamp: Type.String({ minLength: 1 }),
  /** Session identifier */
  sessionId: Type.String(),
  /** Agent identifier (system identifier only, no PII) */
  agentId: Type.Optional(Type.String()),
  /** Event-specific payload */
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type TelemetryEvent = Static<typeof TelemetryEventSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface TelemetryEventValidationResult {
  valid: boolean;
  errors: string[];
  event?: TelemetryEvent;
}

/**
 * Validates an arbitrary object against the TelemetryEvent schema.
 *
 * Returns a structured result with:
 * - `valid`: whether the input conforms to the schema
 * - `errors`: human-readable list of validation failures
 * - `event`: the typed event (only present when valid)
 */
export function validateTelemetryEvent(input: unknown): TelemetryEventValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { valid: false, errors: ['Input must be a non-null object'] };
  }

  const errors = [...Value.Errors(TelemetryEventSchema, input)];
  if (errors.length > 0) {
    return {
      valid: false,
      errors: errors.map(
        (e) => `${e.path ? `${e.path}: ` : ''}${e.message}`,
      ),
    };
  }

  return {
    valid: true,
    errors: [],
    event: Value.Cast(TelemetryEventSchema, input),
  };
}
