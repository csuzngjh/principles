---
phase: 00b-adapter-abstraction
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/openclaw-plugin/src/core/telemetry-event.ts
  - packages/openclaw-plugin/tests/core/telemetry-event.test.ts
autonomous: true
requirements:
  - SDK-OBS-05

must_haves:
  truths:
    - "TelemetryEvent TypeBox schema validates the 3 core event types: pain_detected, principle_candidate_created, principle_promoted"
    - "TelemetryEvent schema does not include PII fields"
    - "Existing EvolutionLogger output conforms to the TelemetryEvent schema"
  artifacts:
    - path: "packages/openclaw-plugin/src/core/telemetry-event.ts"
      provides: "TelemetryEvent TypeBox schema, type definition, and validateTelemetryEvent function"
      exports: ["TelemetryEventSchema", "TelemetryEvent", "TelemetryEventType", "validateTelemetryEvent"]
    - path: "packages/openclaw-plugin/tests/core/telemetry-event.test.ts"
      provides: "Schema validation tests for all 3 event types"
      min_lines: 80
  key_links:
    - from: "src/core/telemetry-event.ts"
      to: "src/core/evolution-logger.ts"
      via: "schema aligns with EvolutionLogEntry fields"
      pattern: "EvolutionStage.*pain_detected|principle_generated|completed"
---

<objective>
Define the TelemetryEvent TypeBox schema as a documentation artifact describing the shape of in-process evolution events.

Purpose: Establish a typed contract for telemetry events that existing EvolutionLogger output conforms to. Per D-07, this is a TypeBox schema definition -- no new TelemetryService, no changes to existing code. Per D-08, covers the 3 core events aligned with EvolutionHook.
Output: TypeBox schema file + validation tests.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md

<interfaces>
<!-- Existing outputs this plan must align with. -->

From packages/openclaw-plugin/src/core/evolution-logger.ts:
```typescript
export type EvolutionStage =
  | 'pain_detected'
  | 'queued'
  | 'started'
  | 'analyzing'
  | 'principle_generated'  // maps to 'principle_candidate_created' in telemetry
  | 'completed'            // maps to 'principle_promoted' in telemetry
  | 'failed';

export interface EvolutionLogEntry {
  traceId: string;
  stage: EvolutionStage;
  level: EvolutionLogLevel;
  message: string;
  summary: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
  taskId?: string;
  sessionId?: string;
}
```

From packages/openclaw-plugin/src/core/pain-signal.ts (TypeBox schema pattern to follow):
```typescript
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const PainSignalSchema = Type.Object({ ... });
export type PainSignal = Static<typeof PainSignalSchema>;

export function validatePainSignal(input: unknown): PainSignalValidationResult {
  // ... TypeBox Value.Errors, Value.Cast pattern
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create TelemetryEvent TypeBox schema</name>
  <files>packages/openclaw-plugin/src/core/telemetry-event.ts</files>
  <read_first>
    - packages/openclaw-plugin/src/core/pain-signal.ts (exact TypeBox pattern to replicate: schema + type + validation function)
    - packages/openclaw-plugin/src/core/evolution-logger.ts lines 17-49 (EvolutionStage + EvolutionLogEntry -- schema must align with these fields)
  </read_first>
  <action>
Create `packages/openclaw-plugin/src/core/telemetry-event.ts` with the following structure:

1. **File header**:
```typescript
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
```

2. **Imports** (same pattern as pain-signal.ts):
```typescript
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
```

3. **Event type union** (per D-08):
```typescript
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

export type TelemetryEventType = Static<typeof TelemetryEventType>;
```

4. **TelemetryEvent schema** (aligned with EvolutionLogEntry fields, per D-07):
```typescript
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
```

5. **Validation function** (same pattern as validatePainSignal):
```typescript
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
    event: Value.Cast(TelemetryEventSchema, input) as TelemetryEvent,
  };
}
```
  </action>
  <verify>
    <automated>cd packages/openclaw-plugin && npx vitest run tests/core/telemetry-event.test.ts -x 2>/dev/null; grep -q "export const TelemetryEventSchema" src/core/telemetry-event.ts</automated>
  </verify>
  <acceptance_criteria>
    - File `packages/openclaw-plugin/src/core/telemetry-event.ts` exists
    - Contains `export const TelemetryEventType` with 3 literal types: `pain_detected`, `principle_candidate_created`, `principle_promoted`
    - Contains `export const TelemetryEventSchema` with fields: `eventType`, `traceId`, `timestamp`, `sessionId`, `agentId` (optional), `payload`
    - Contains `export type TelemetryEvent = Static<typeof TelemetryEventSchema>`
    - Contains `export function validateTelemetryEvent(input: unknown): TelemetryEventValidationResult`
    - `agentId` is `Type.Optional(Type.String())` -- NOT required
    - Schema does not contain PII fields (no userName, email, or similar)
    - File header JSDoc documents the mapping to EvolutionLogger stages
    - Uses `.js` extension in imports (ESM convention)
  </acceptance_criteria>
  <done>TelemetryEvent TypeBox schema defined with 3 core event types, validation function, no PII fields, aligned with EvolutionLogEntry.</done>
</task>

<task type="auto">
  <name>Task 2: Create TelemetryEvent validation tests</name>
  <files>packages/openclaw-plugin/tests/core/telemetry-event.test.ts</files>
  <read_first>
    - packages/openclaw-plugin/src/core/telemetry-event.ts (schema being tested)
    - packages/openclaw-plugin/tests/core/pain-signal.test.ts (exact test pattern to replicate: schema acceptance, rejection, validation function)
  </read_first>
  <action>
Create `packages/openclaw-plugin/tests/core/telemetry-event.test.ts` following the exact pattern from pain-signal.test.ts:

1. **Imports**:
```typescript
import { describe, it, expect } from 'vitest';
import { TelemetryEventSchema, validateTelemetryEvent, type TelemetryEvent } from '../../src/core/telemetry-event.js';
import { Value } from '@sinclair/typebox/value';
```

2. **Test fixture helper**:
```typescript
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
```

3. **Test cases**:
   - `describe('TelemetryEventSchema')`:
     - `it('accepts a valid pain_detected event')`: `expect(Value.Check(TelemetryEventSchema, validEvent())).toBe(true)`
     - `it('accepts a valid principle_candidate_created event')`: `expect(Value.Check(TelemetryEventSchema, validEvent({ eventType: 'principle_candidate_created' }))).toBe(true)`
     - `it('accepts a valid principle_promoted event')`: `expect(Value.Check(TelemetryEventSchema, validEvent({ eventType: 'principle_promoted' }))).toBe(true)`
     - `it('accepts an event with optional agentId')`: `expect(Value.Check(TelemetryEventSchema, validEvent({ agentId: 'main' }))).toBe(true)`
     - `it('accepts an event with payload data')`: `expect(Value.Check(TelemetryEventSchema, validEvent({ payload: { toolName: 'edit_file', error: 'not found' } }))).toBe(true)`
     - `it('rejects an event with invalid eventType')`: `expect(Value.Check(TelemetryEventSchema, validEvent({ eventType: 'invalid_event' }))).toBe(false)`
     - `it('rejects an event missing traceId')`: `expect(Value.Check(TelemetryEventSchema, { ...validEvent(), traceId: undefined })).toBe(false)`
     - `it('rejects an event missing timestamp')`: `expect(Value.Check(TelemetryEventSchema, { ...validEvent(), timestamp: undefined })).toBe(false)`
     - `it('rejects an event missing sessionId')`: `expect(Value.Check(TelemetryEventSchema, { ...validEvent(), sessionId: undefined })).toBe(false)`
     - `it('rejects an event missing eventType')`: `expect(Value.Check(TelemetryEventSchema, { ...validEvent(), eventType: undefined })).toBe(false)`
     - `it('rejects an event missing payload')`: `expect(Value.Check(TelemetryEventSchema, { ...validEvent(), payload: undefined })).toBe(false)`
     - `it('rejects a non-object input')`: `expect(Value.Check(TelemetryEventSchema, 'not an object')).toBe(false)`

   - `describe('validateTelemetryEvent')`:
     - `it('returns valid:true for a valid event')`: Call with validEvent(), assert `result.valid === true` and `result.event` is defined.
     - `it('returns the typed event when valid')`: Call with validEvent({ traceId: 'test-123' }), assert `result.event?.traceId === 'test-123'`.
     - `it('returns valid:false for non-object input')`: Call with `"string"`, assert `result.valid === false` and `result.errors.length > 0`.
     - `it('returns valid:false for null input')`: Call with `null`, assert `result.valid === false`.
     - `it('returns valid:false for array input')`: Call with `[]`, assert `result.valid === false`.
     - `it('returns errors for missing required fields')`: Call with `{}`, assert `result.valid === false` and errors mention missing fields.
     - `it('returns errors for invalid eventType')`: Call with `{ ...validEvent(), eventType: 'not_a_real_event' }`, assert `result.valid === false`.
     - `it('accepts event without agentId (optional field)')`: Call with validEvent() (no agentId), assert `result.valid === true`.
  </action>
  <verify>
    <automated>cd packages/openclaw-plugin && npx vitest run tests/core/telemetry-event.test.ts -x</automated>
  </verify>
  <acceptance_criteria>
    - File `packages/openclaw-plugin/tests/core/telemetry-event.test.ts` exists
    - Test suite `describe('TelemetryEventSchema')` contains at least 10 test cases covering: all 3 event types accepted, optional agentId accepted, payload data accepted, invalid eventType rejected, missing required fields rejected
    - Test suite `describe('validateTelemetryEvent')` contains at least 5 test cases covering: valid event returns typed result, invalid inputs return errors
    - All tests pass: `npx vitest run tests/core/telemetry-event.test.ts -x` exits 0
  </acceptance_criteria>
  <done>TelemetryEvent schema tests pass -- all 3 event types validated, optional fields work, invalid inputs rejected, validateTelemetryEvent function behaves correctly.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| TelemetryEvent schema vs EvolutionLogger output | Schema is a contract; existing logger should produce conformant events |
| TelemetryEvent.payload field | Unstructured Record<string, unknown> -- framework adapter responsible for sanitization |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-0b-05 | Information Disclosure | TelemetryEvent payload | mitigate | Schema does not include PII fields; agentId is system identifier only (e.g., 'main', 'builder'). Framework adapter responsible for not including user data in payload. |
| T-0b-06 | Tampering | TelemetryEvent validation | accept | validateTelemetryEvent() is a documentation/contract tool, not a security boundary -- events are internal, not from external input |
</threat_model>

<verification>
```bash
cd packages/openclaw-plugin
npx vitest run tests/core/telemetry-event.test.ts -x
```
All tests pass.
</verification>

<success_criteria>
1. TelemetryEventSchema defines 3 core event types per D-08: pain_detected, principle_candidate_created, principle_promoted.
2. Schema fields align with EvolutionLogEntry per D-07: traceId, timestamp, sessionId, payload, optional agentId.
3. No PII fields in schema.
4. validateTelemetryEvent() follows validatePainSignal() pattern exactly.
5. All validation tests pass, TypeScript compiles cleanly.
</success_criteria>

<output>
After completion, create `.planning/phases/00b-adapter-abstraction/00b-03-SUMMARY.md`
</output>
