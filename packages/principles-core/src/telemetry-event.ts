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
 * The 24 telemetry event types: 3 core evolution + 8 M2 state transition + 1 M3 degradation + 8 M4 diagnostician + 3 M5 commit.
 *
 * Core evolution events (aligned with EvolutionHook methods):
 * - pain_detected -> EvolutionStage 'pain_detected'
 * - principle_candidate_created -> EvolutionStage 'principle_generated'
 * - principle_promoted -> EvolutionStage 'completed'
 *
 * M2 state transition events (task/run lifecycle):
 * - lease_acquired, lease_released, lease_renewed, lease_expired
 * - task_retried, task_failed, task_succeeded
 * - run_started, run_completed
 *
 * M3 degradation events:
 * - degradation_triggered — graceful degradation fallback activated
 *
 * M4 diagnostician runner events:
 * - diagnostician_task_leased — runner acquired lease on a task
 * - diagnostician_context_built — context assembly completed
 * - diagnostician_run_started — runtime invocation started
 * - diagnostician_run_failed — runtime execution failed
 * - diagnostician_output_invalid — output validation failed
 * - diagnostician_task_succeeded — task marked succeeded
 * - diagnostician_task_retried — task sent to retry_wait
 * - diagnostician_task_failed — task permanently failed
 *
 * M5: Artifact commit + candidate registration events:
 * - diagnostician_artifact_committed — artifact + candidates committed successfully
 * - diagnostician_artifact_commit_failed — commit attempt threw
 * - principle_candidate_registered — individual candidate registered
 */
export const TelemetryEventType = Type.Union([
  Type.Literal('pain_detected'),
  Type.Literal('principle_candidate_created'),
  Type.Literal('principle_promoted'),
  // M2: Task/Run state transition events
  Type.Literal('lease_acquired'),
  Type.Literal('lease_released'),
  Type.Literal('lease_renewed'),
  Type.Literal('lease_expired'),
  Type.Literal('task_retried'),
  Type.Literal('task_failed'),
  Type.Literal('task_succeeded'),
  Type.Literal('run_started'),
  Type.Literal('run_completed'),
// M3: Degradation events
  Type.Literal('degradation_triggered'),
  // M4: Diagnostician runner events
  Type.Literal('diagnostician_task_leased'),
  Type.Literal('diagnostician_context_built'),
  Type.Literal('diagnostician_run_started'),
  Type.Literal('diagnostician_run_failed'),
  Type.Literal('diagnostician_output_invalid'),
  Type.Literal('diagnostician_task_succeeded'),
  Type.Literal('diagnostician_task_retried'),
  Type.Literal('diagnostician_task_failed'),
  // M5: Artifact commit events
  Type.Literal('diagnostician_artifact_committed'),
  Type.Literal('diagnostician_artifact_commit_failed'),
  Type.Literal('principle_candidate_registered'),
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

  const raw = input as Record<string, unknown>;

  // Validate ISO 8601 timestamp format
  if (
    typeof raw.timestamp === 'string' &&
    isNaN(Date.parse(raw.timestamp))
  ) {
    return { valid: false, errors: ['timestamp must be a valid ISO 8601 date string'] };
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
