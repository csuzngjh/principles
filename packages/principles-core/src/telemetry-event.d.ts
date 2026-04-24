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
import { type Static } from '@sinclair/typebox';
/**
 * The 21 telemetry event types: 3 core evolution + 8 M2 state transition + 1 M3 degradation + 8 M4 diagnostician.
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
 */
export declare const TelemetryEventType: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"pain_detected">, import("@sinclair/typebox").TLiteral<"principle_candidate_created">, import("@sinclair/typebox").TLiteral<"principle_promoted">, import("@sinclair/typebox").TLiteral<"lease_acquired">, import("@sinclair/typebox").TLiteral<"lease_released">, import("@sinclair/typebox").TLiteral<"lease_renewed">, import("@sinclair/typebox").TLiteral<"lease_expired">, import("@sinclair/typebox").TLiteral<"task_retried">, import("@sinclair/typebox").TLiteral<"task_failed">, import("@sinclair/typebox").TLiteral<"task_succeeded">, import("@sinclair/typebox").TLiteral<"run_started">, import("@sinclair/typebox").TLiteral<"run_completed">, import("@sinclair/typebox").TLiteral<"degradation_triggered">, import("@sinclair/typebox").TLiteral<"diagnostician_task_leased">, import("@sinclair/typebox").TLiteral<"diagnostician_context_built">, import("@sinclair/typebox").TLiteral<"diagnostician_run_started">, import("@sinclair/typebox").TLiteral<"diagnostician_run_failed">, import("@sinclair/typebox").TLiteral<"diagnostician_output_invalid">, import("@sinclair/typebox").TLiteral<"diagnostician_task_succeeded">, import("@sinclair/typebox").TLiteral<"diagnostician_task_retried">, import("@sinclair/typebox").TLiteral<"diagnostician_task_failed">]>;
export type TelemetryEventType = Static<typeof TelemetryEventType>;
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
export declare const TelemetryEventSchema: import("@sinclair/typebox").TObject<{
    /** Event type (one of the 3 core types) */
    eventType: import("@sinclair/typebox").TUnion<[import("@sinclair/typebox").TLiteral<"pain_detected">, import("@sinclair/typebox").TLiteral<"principle_candidate_created">, import("@sinclair/typebox").TLiteral<"principle_promoted">, import("@sinclair/typebox").TLiteral<"lease_acquired">, import("@sinclair/typebox").TLiteral<"lease_released">, import("@sinclair/typebox").TLiteral<"lease_renewed">, import("@sinclair/typebox").TLiteral<"lease_expired">, import("@sinclair/typebox").TLiteral<"task_retried">, import("@sinclair/typebox").TLiteral<"task_failed">, import("@sinclair/typebox").TLiteral<"task_succeeded">, import("@sinclair/typebox").TLiteral<"run_started">, import("@sinclair/typebox").TLiteral<"run_completed">, import("@sinclair/typebox").TLiteral<"degradation_triggered">, import("@sinclair/typebox").TLiteral<"diagnostician_task_leased">, import("@sinclair/typebox").TLiteral<"diagnostician_context_built">, import("@sinclair/typebox").TLiteral<"diagnostician_run_started">, import("@sinclair/typebox").TLiteral<"diagnostician_run_failed">, import("@sinclair/typebox").TLiteral<"diagnostician_output_invalid">, import("@sinclair/typebox").TLiteral<"diagnostician_task_succeeded">, import("@sinclair/typebox").TLiteral<"diagnostician_task_retried">, import("@sinclair/typebox").TLiteral<"diagnostician_task_failed">]>;
    /** Correlation trace ID for linking events across the pipeline */
    traceId: import("@sinclair/typebox").TString;
    /** ISO 8601 timestamp */
    timestamp: import("@sinclair/typebox").TString;
    /** Session identifier */
    sessionId: import("@sinclair/typebox").TString;
    /** Agent identifier (system identifier only, no PII) */
    agentId: import("@sinclair/typebox").TOptional<import("@sinclair/typebox").TString>;
    /** Event-specific payload */
    payload: import("@sinclair/typebox").TRecord<import("@sinclair/typebox").TString, import("@sinclair/typebox").TUnknown>;
}>;
export type TelemetryEvent = Static<typeof TelemetryEventSchema>;
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
export declare function validateTelemetryEvent(input: unknown): TelemetryEventValidationResult;
//# sourceMappingURL=telemetry-event.d.ts.map