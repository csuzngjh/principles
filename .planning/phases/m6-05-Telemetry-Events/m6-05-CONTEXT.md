# Phase m6-05: Telemetry Events - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** Runtime telemetry events for observability — four TELE events (TELE-01~04) emitted at key runtime lifecycle points for `openclaw-cli` runtime.

**Scope anchor:** TELE-01~04 events emitted from CLI/Runner/Adapter during `pd diagnose run --runtime openclaw-cli` execution. TelemetryEventType union extended with new event types. StoreEventEmitter used as event bus.

</domain>

<decisions>
## Implementation Decisions

### TELE-01: `runtime_adapter_selected` — Emission Point

- **TELE-01-D01:** Event fires in CLI command handler (`handleDiagnoseRun()` in `packages/pd-cli/src/commands/diagnose.ts`) when `OpenClawCliRuntimeAdapter` is instantiated.
  - Rationale: CLI is the user-visible selection point — user explicitly chose `--runtime openclaw-cli`. External observability tools watching the CLI entry point see this event first.

### TELE-02: `runtime_invocation_started` — Relationship to `diagnostician_run_started`

- **TELE-02-D01:** Both `runtime_invocation_started` AND `diagnostician_run_started` are retained as separate event types.
  - `diagnostician_run_started` (DiagnosticianRunner): "diagnostician logic wants to run" — PD internal observer
  - `runtime_invocation_started` (OpenClawCliRuntimeAdapter): "CLI process actually spawned" — external/runtime observer
  - They fire at the same moment from different abstraction levels. Different consumers (PD internal vs. external monitoring) benefit from both.
  - Both fire inside DiagnosticianRunner's `run()` loop, in that order.

### TELE-03: `runtime_invocation_succeeded` / `runtime_invocation_failed`

- **TELE-03-D01:** Two separate event types: `runtime_invocation_succeeded` and `runtime_invocation_failed`.
  - Fire when `OpenClawCliRuntimeAdapter.startRun()` promise resolves (CLI process exits).
  - Payload includes `runtimeKind`, `errorCategory?` (for failed case).
  - `runtime_invocation_failed` is distinct from `diagnostician_run_failed` — adapter-level failure vs. runner-level failure mapping.
  - Rationale: Independent events enable monitoring dashboards to count success/failure directly without field filtering.

### TELE-04: `output_validation_succeeded` / `output_validation_failed`

- **TELE-04-D01:** Two separate event types added to TelemetryEventType union.
  - `output_validation_succeeded`: fires when `validator.validate()` returns `valid: true`
  - `output_validation_failed`: fires when `validator.validate()` returns `valid: false`
  - Existing `diagnostician_output_invalid` is retained for backward compatibility (already emitted by DiagnosticianRunner).
  - TELE-04 events are additive — DiagnosticianRunner continues to emit `diagnostician_output_invalid`; optionally also emit the new TELE-04 events for symmetry.

### EventEmitter Wiring

- **EE-D01:** `StoreEventEmitter` is passed to `OpenClawCliRuntimeAdapter` via constructor dependency injection (same pattern as DiagnosticianRunner).
  - `OpenClawCliRuntimeAdapter` constructor accepts `eventEmitter?: StoreEventEmitter` (optional, falls back to `storeEmitter` singleton if not provided — for backward compatibility).
  - Adapter emits events via `eventEmitter.emitTelemetry({ eventType: '...', traceId, timestamp, sessionId, payload })`.
  - Adapter does NOT import the global `storeEmitter` directly (except as fallback) — enables isolated testing with a mock emitter.

### Event Payload Standards

- **PAYLOAD-D01:** All TELE events include consistent fields:
  - `eventType`: event type string
  - `traceId`: taskId (for correlation)
  - `timestamp`: ISO 8601
  - `sessionId`: owner string (from runner options)
  - `agentId`: `'diagnostician'` or `'openclaw-cli-adapter'`
  - `payload`: `Record<string, unknown>` with event-specific fields

### TelemetryEventType Union Extension

- **TYPE-D01:** Add to `TelemetryEventType` union in `packages/principles-core/src/telemetry-event.ts`:
  - `runtime_adapter_selected`
  - `runtime_invocation_started`
  - `runtime_invocation_succeeded`
  - `runtime_invocation_failed`
  - `output_validation_succeeded`
  - `output_validation_failed`

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema & Protocol
- `packages/principles-core/src/telemetry-event.ts` — TelemetryEventSchema, TelemetryEventType union, validateTelemetryEvent()
- `packages/principles-core/src/runtime-v2/store/event-emitter.ts` — StoreEventEmitter.emitTelemetry(), storeEmitter singleton
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface, StartRunInput
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory enum

### Adapter & Runner
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — OpenClawCliRuntimeAdapter with startRun(), fetchOutput(), healthCheck(), getCapabilities()
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner with emitDiagnosticianEvent() private method (reference pattern for event emission)

### CLI Surface
- `packages/pd-cli/src/commands/diagnose.ts` — handleDiagnoseRun() where OpenClawCliRuntimeAdapter is instantiated

### Prior Phases
- `.planning/phases/m6-04-PD-CLI-Extension-Error-Mapping/m6-04-CONTEXT.md` — CLI routing decisions, HG-03 enforcement, error mapping
- `.planning/phases/m6-02-OpenClawCliRuntimeAdapter-Core/m6-02-CONTEXT.md` — OCRA decisions (D-01~D-06), error mapping (D-04)
- `.planning/phases/m6-03-DiagnosticianPromptBuilder-Workspace/m6-03-CONTEXT.md` — DiagnosticianPromptBuilder decisions

### M6 Telemetry Requirements
- `.planning/REQUIREMENTS.md` §Telemetry — TELE-01~04 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `StoreEventEmitter` (store/event-emitter.ts) — existing event bus with TelemetryEvent validation
- `DiagnosticianRunner.emitDiagnosticianEvent()` private method — pattern for emitting via eventEmitter
- `storeEmitter` global singleton — fallback event emitter for adapters that don't receive injected emitter
- Existing `diagnostician_*` events already emitted in DiagnosticianRunner — TELE events are additive

### Established Patterns
- Event emission via `eventEmitter.emitTelemetry({ eventType, traceId, timestamp, sessionId, agentId, payload })`
- TelemetryEvent validation happens inside `emitTelemetry()` — caller passes raw object
- `DiagnosticianRunnerDeps` interface already includes `eventEmitter: StoreEventEmitter`

### Integration Points
- `OpenClawCliRuntimeAdapter` constructor: add optional `eventEmitter` parameter
- `DiagnosticianRunner` already has eventEmitter — no change needed for TELE-04 events
- CLI command handler (`handleDiagnoseRun`) creates adapter — add TELE-01 emission there

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within m6-05 TELE-01~04 scope.
</deferred>

---

*Phase: m6-05-Telemetry-Events*
*Context gathered: 2026-04-24*
