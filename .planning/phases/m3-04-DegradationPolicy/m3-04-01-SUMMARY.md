---
phase: m3-04
plan: m3-04-01
status: complete
completed: "2026-04-22"
---

# Summary: Degradation Policy

**Plan:** m3-04-01 — Degradation Policy
**Status:** Complete
**Commit:** b8852dbd

## What was built

- `ResilientContextAssembler` in `store/resilient-context-assembler.ts`
  - Wraps `ContextAssembler` with never-throws guarantee
  - Catches all errors, returns valid `DiagnosticianContextPayload` with degradation notes
  - Degraded payload: `<unknown>` workspaceDir, deterministic `SHA-256("degraded")` hash, empty conversationWindow
  - Severity mapping: `storage_unavailable` → `error`, others → `warning`
- `ResilientHistoryQuery` in `store/resilient-history-query.ts`
  - Wraps `HistoryQuery` with cursor fallback
  - Invalid/deleted cursor → silently returns first page
  - Non-cursor queries pass through unchanged (already graceful)
- `degradation_triggered` telemetry event type added to `TelemetryEventType` union
- 12 tests (8 for assembler + 4 for history query)
- Updated `index.ts` with new exports

## Key decisions

- Composition wrapper pattern (not modifying existing components)
- Degraded payload uses `<unknown>` sentinel for workspaceDir (satisfies `minLength: 1`)
- Deterministic `SHA-256("degraded")` contextHash marks degraded payloads
- `DegradationEmitOptions` interface solves max-params lint (4→1 parameter)
- Schema validation failures (potential DB corruption) emit `severity: 'error'`

## Key files

### created
- packages/principles-core/src/runtime-v2/store/resilient-context-assembler.ts
- packages/principles-core/src/runtime-v2/store/resilient-history-query.ts
- packages/principles-core/src/runtime-v2/store/resilient-context-assembler.test.ts
- packages/principles-core/src/runtime-v2/store/resilient-history-query.test.ts

### modified
- packages/principles-core/src/telemetry-event.ts
- packages/principles-core/src/runtime-v2/index.ts

## Test results

- 12/12 new tests pass
- 153/153 total runtime-v2 tests pass (0 regressions)
