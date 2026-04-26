---
phase: m6-05
reviewed: 2026-04-25T00:15:00Z
depth: standard
files_reviewed: 4
files_reviewed_list:
  - packages/principles-core/src/telemetry-event.ts
  - packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts
  - packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts
  - packages/pd-cli/src/commands/diagnose.ts
findings:
  critical: 1
  warning: 2
  info: 1
  total: 4
status: issues_found
---

# Phase m6-05: Code Review Report

**Reviewed:** 2026-04-25T00:15:00Z
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Phase m6-05 adds telemetry events (TELE-01~04) to the runtime-v2 adapter and runner. The implementation is generally sound with correct event emission points, but there are type safety concerns that should be addressed. The `telemetry-event.ts` schema correctly includes the 6 M6 runtime adapter event types (30 total). Event emission logic in `openclaw-cli-runtime-adapter.ts` and `diagnostician-runner.ts` is correct. However, there are unregistered telemetry events and a dangerous type cast that warrant attention.

## Critical Issues

### CR-01: Dangerous type cast bypasses TypeScript safety

**File:** `packages/pd-cli/src/commands/diagnose.ts:125`
**Issue:** Variable `runtimeAdapter` is initialized with `null as unknown as PDRuntimeAdapter` before the conditional block that properly assigns it. This dangerous type cast bypasses TypeScript's type safety and could mask initialization errors.
**Fix:**
```typescript
// Change from:
let runtimeAdapter: PDRuntimeAdapter = null as unknown as PDRuntimeAdapter;

// To proper initialization with a default or separate declaration:
let runtimeAdapter: PDRuntimeAdapter;
if (runtimeKind === 'openclaw-cli') {
  runtimeAdapter = new OpenClawCliRuntimeAdapter({...});
} else if (runtimeKind === 'test-double') {
  runtimeAdapter = new TestDoubleRuntimeAdapter({...});
} else {
  console.error(`error: unknown runtime kind '${runtimeKind}'`);
  process.exit(1);
}
```

## Warnings

### WR-01: Unregistered telemetry event emitted

**File:** `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts:291`
**Issue:** Event `diagnostician_cancel_run_failed` is emitted via `emitDiagnosticianEvent()` but is not defined in the `TelemetryEventType` union in `telemetry-event.ts`.
**Fix:** Either add `Type.Literal('diagnostician_cancel_run_failed')` to the TelemetryEventType union, or rename to an existing event type if this is a variant of an existing event.

### WR-02: Unregistered telemetry event emitted

**File:** `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts:360`
**Issue:** Event `diagnostician_mark_succeeded_failed` is emitted via `emitDiagnosticianEvent()` but is not defined in the `TelemetryEventType` union in `telemetry-event.ts`.
**Fix:** Either add `Type.Literal('diagnostician_mark_succeeded_failed')` to the TelemetryEventType union, or rename to an existing event type if this is a variant of an existing event.

## Info

### IN-01: Inconsistent event emitter usage

**File:** `packages/pd-cli/src/commands/diagnose.ts:133-143` and `packages/pd-cli/src/commands/diagnose.ts:175`
**Issue:** TELE-01 (`runtime_adapter_selected`) is emitted via the global `storeEmitter` singleton (line 133), while the runner receives a separate `eventEmitter = new StoreEventEmitter()` instance (line 175). Events may be emitted through different emitter instances, potentially causing some observers to miss events.
**Fix:** Consider using the same `eventEmitter` instance consistently, or ensure the global `storeEmitter` is properly routed to the runner's event observer chain.

---

_Reviewed: 2026-04-25T00:15:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
