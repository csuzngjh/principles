---
phase: m3-04
milestone: v2.2 M3
status: context_gathered
gathered: "2026-04-22"
---

# Context: Degradation Policy (m3-04)

## Phase Goal

Graceful degradation on all error modes — no throws, safe fallbacks, warnings + telemetry.
The diagnostician context assembly pipeline must never crash; it returns best-effort payloads with quality notes.

## Requirements

- **RET-09**: Trajectory not found → safe fallback (no throw)
- **RET-10**: Degradation emits warnings + telemetry

## Current State

### Already Graceful (no changes needed)

| Component | Behavior | Evidence |
|-----------|----------|----------|
| SqliteTrajectoryLocator | Returns `{ candidates: [] }` for all "not found" cases | 6 locate modes, lines 54-204, never throws for data-not-found |
| SqliteHistoryQuery | Returns `{ entries: [], truncated: false }` when no runs exist | Interface contract (history-query.ts:57), no throw |
| SqliteRunStore.listRunsByTask | Returns `[]` for no runs | run-store.ts:46-47 |
| ambiguityNotes | Template-generated notes for empty history, truncation, empty text | sqlite-context-assembler.ts:90-111 |

### Throws That Need Degradation Wrapping

| Component | Trigger | Current | Category |
|-----------|---------|---------|----------|
| SqliteContextAssembler.assemble() | task not found | throws `storage_unavailable` | Must return degraded payload |
| SqliteContextAssembler.assemble() | task is not diagnostician | throws `input_invalid` | Must return degraded payload |
| SqliteContextAssembler.assemble() | schema validation fails | throws `storage_unavailable` | Must catch + return degraded |
| SqliteHistoryQuery.query() | cursor references deleted run | throws `input_invalid` | Must return safe page |
| SqliteHistoryQuery.query() | malformed cursor | throws `input_invalid` | Must return first page |
| Schema validation (all stores) | DB corruption | throws `storage_unavailable` | Must catch + degrade |

### Available Error Categories (unused but designed for this)

From `error-categories.ts`:
- `context_assembly_failed` — for when context assembly cannot produce a valid payload
- `history_not_found` — for when history retrieval finds nothing
- `trajectory_ambiguous` — for when trajectory lookup is ambiguous

### Telemetry Infrastructure

**StoreEventEmitter** (store/event-emitter.ts):
- `emitTelemetry()` validates against TelemetryEventSchema
- Singleton `storeEmitter` used across components
- Currently emits: lease_acquired, lease_released, lease_renewed, lease_expired, task_retried, task_failed, task_succeeded

**TelemetryEvent type** (telemetry-event.ts):
- 12 event types defined
- No degradation-specific events exist yet
- Need new event types for degradation scenarios

### M3 Exit Criteria Relevance

4. Workspace isolation: context never leaks across workspaces → m3-05
5. **Degradation policy: graceful fallback when history is incomplete → m3-04**
6. **Degraded mode: no crashes, only warnings, task can still proceed → m3-04**

## Key Decisions Needed

1. **Degradation wrapper pattern**: New `DegradationPolicy` wrapper component, or build degradation into existing components?
   - Option A: `ResilientContextAssembler` wraps `ContextAssembler` with try/catch → degraded payload
   - Option B: Modify `SqliteContextAssembler` directly to handle errors internally
   - **Recommendation**: Option A (composition over modification) — keeps existing components focused, adds resilience layer

2. **Degraded payload shape**: What does a degraded payload look like?
   - Must still satisfy `DiagnosticianContextPayloadSchema` for downstream compatibility
   - `ambiguityNotes` carries degradation info
   - Empty `conversationWindow`, synthetic `contextId`/`contextHash`, minimal `diagnosisTarget`

3. **Telemetry events**: What degradation events to emit?
   - New event type: `degradation_triggered` with component, trigger, fallback description
   - Or reuse existing `task_failed`?

4. **HistoryQuery cursor degradation**: When cursor is invalid, return first page silently or emit warning?

5. **Schema validation failures**: These indicate potential DB corruption. Catch and degrade, or still throw?
   - **Recommendation**: Catch + degrade + emit telemetry at ERROR level (corruption is serious)

## Assumptions

- Downstream consumers (diagnostician) can handle payloads with empty `conversationWindow` and populated `ambiguityNotes`
- A degraded payload is better than no payload (task can still proceed)
- Telemetry events for degradation must be cheap to emit (no external calls)
- Schema validation failures are rare but must not crash the pipeline
