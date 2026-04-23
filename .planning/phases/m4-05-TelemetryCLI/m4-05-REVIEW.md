---
phase: m4-05
reviewed: 2026-04-23T12:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - packages/principles-core/src/telemetry-event.ts
  - packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts
  - packages/principles-core/src/runtime-v2/cli/diagnose.ts
  - packages/principles-core/src/runtime-v2/index.ts
  - packages/principles-core/src/runtime-v2/runner/__tests__/diagnose.test.ts
  - packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-telemetry.test.ts
findings:
  critical: 0
  warning: 2
  info: 1
  total: 3
status: issues_found
---

# Phase m4-05: Code Review Report

**Reviewed:** 2026-04-23T12:00:00Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

TelemetryCLI implementation (diagnose.ts CLI surface + DiagnosticianRunner + TelemetryEvent schema) reviewed for type safety, error handling, security, and test coverage. Code is generally well-structured with proper TypeScript typing and comprehensive test coverage. Two warnings and one info item identified.

## Critical Issues

None found.

## Warnings

### WR-01: TypeBox Value.Cast may silently coerce or drop invalid fields

**File:** `packages/principles-core/src/telemetry-event.ts:157`
**Issue:** `validateTelemetryEvent` uses `Value.Cast(TelemetryEventSchema, input)` to produce the typed event. TypeBox's `Value.Cast` can silently coerce values (e.g., coerce a string to a number) or drop fields it cannot coerce, returning a partial object rather than a validation error. This means an input that fails strict schema validation could still produce a cast result that does not fully conform to the schema.

**Fix:**
Use `Value.Decode` instead of `Value.Cast` for stricter validation, or verify the cast result against the schema:

```typescript
import { Value } from '@sinclair/typebox/value';

// Instead of Value.Cast which coerces silently:
const cast = Value.Cast(TelemetryEventSchema, input);

// Use Value.Decode which returns errors on coercion failures,
// then validate the decoded value:
const [decoded, errors] = Value.Decode(TelemetryEventSchema, input);
if (errors.length > 0) {
  return { valid: false, errors: errors.map(e => ...), event: undefined };
}
```

Or simply return the original `input` since it has already passed `Value.Errors`:

```typescript
// Value.Errors already validated - no need to cast
return {
  valid: true,
  errors: [],
  event: input as TelemetryEvent, // Already validated by Value.Errors above
};
```

### WR-02: Synthetic TaskRecord in handleLeaseOrPhaseError uses hardcoded retry values

**File:** `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts:314-322`
**Issue:** When `acquireLease` itself fails, `handleLeaseOrPhaseError` constructs a synthetic `TaskRecord` with hardcoded `attemptCount: 1` and `maxAttempts: 3`. These values are used in `retryOrFail` to evaluate whether to retry. If the actual task configuration differs, the retry decision will be incorrect.

```typescript
const task: TaskRecord = {
  taskId,
  taskKind: 'diagnostician',
  status: 'leased',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  attemptCount: 1,     // hardcoded - may not reflect actual attempt
  maxAttempts: 3,      // hardcoded - may not match real task config
};
```

**Fix:**
Either retrieve the actual task record before constructing a fallback (if the error indicates the task may already exist), or accept that lease failures are terminal by design and skip the retry evaluation:

```typescript
private async handleLeaseOrPhaseError(
  taskId: string,
  error: unknown,
): Promise<RunnerResult> {
  const classified = this.classifyError(error);
  // Lease failures are typically permanent (e.g., storage unavailable)
  // Fall back to permanent error handling rather than synthetic retry
  if (classified.category === 'storage_unavailable') {
    return {
      status: 'failed',
      taskId,
      errorCategory: classified.category,
      failureReason: classified.message,
      attemptCount: 1,
    };
  }
  // ... existing retry logic
}
```

## Info

### IN-01: cli/diagnose.run() ignores stateManager from options

**File:** `packages/principles-core/src/runtime-v2/cli/diagnose.ts:48-50`
**Issue:** The `run()` function receives a `stateManager` in its options but never uses it. The function delegates entirely to `options.runner.run(options.taskId)`. While this is not a bug (state management is correctly handled inside `DiagnosticianRunner`), the unused parameter is misleading.

```typescript
export async function run(options: DiagnoseRunOptions): Promise<RunnerResult> {
  return options.runner.run(options.taskId);  // stateManager unused
}
```

**Fix:** Remove `stateManager` from `DiagnoseRunOptions` interface if it is not used by the `run` function, or document why it is present (e.g., reserved for future use, or passed for future extension):

```typescript
// If stateManager is truly unused:
export interface DiagnoseRunOptions {
  taskId: string;
  runner: DiagnoseRunner;
}

// If kept for future use, add comment:
// stateManager: Reserved for future extensibility (e.g., direct store access)
```

---

_Reviewed: 2026-04-23T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_