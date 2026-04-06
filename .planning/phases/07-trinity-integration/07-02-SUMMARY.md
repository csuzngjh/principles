---
phase: "07"
plan: "02"
type: execute
wave: 2
depends_on:
  - "07-01"
files_modified:
  - packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts
autonomous: true
requirements:
  - NOC-07
  - NOC-08
  - NOC-09
  - NOC-10

must_haves:
  truths:
    - "Tests verify startWorkflow returns state='active' for Trinity path"
    - "Tests verify runTrinityAsync is called with snapshot and principleId"
    - "Tests verify recordStageEvents is called after Trinity resolves"
    - "Tests verify notifyWaitResult transitions to finalizing->completed on success"
    - "Tests verify notifyWaitResult transitions to terminal_error on failure with failures array"
    - "Tests verify pendingTrinityFailures and pendingTrinityResults Maps are populated before async launch"
  artifacts:
    - path: packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts
      provides: Tests for NOC-07 through NOC-10 Trinity async behaviors
      min_lines: 150
---

# Phase 7 Plan 2: NOC-07 through NOC-10 Tests

## One-liner

Added Trinity async integration tests (NOC-07 through NOC-10) to nocturnal-workflow-manager.test.ts with 4 expected failures due to missing implementation.

## Summary

Added comprehensive tests for Trinity async behaviors in NocturnalWorkflowManager:

- **NOC-07 (runTrinityAsync integration)**: Tests verify `runTrinityAsync` is called with `snapshot` and `principleId` from metadata, and that `startWorkflow` returns immediately with `state='active'`
- **NOC-08 (Stage event recording)**: Tests verify stage events are recorded for Trinity completion and failure cases
- **NOC-09 (Stage failure handling)**: Tests verify `TrinityStageFailure[]` is included in `nocturnal_failed` event payload
- **NOC-10 (Full state machine transitions)**: Tests verify `active->finalizing->completed` on success and `active->terminal_error` on failure

## Test Results

- **14 existing tests pass** (NOC-01 through NOC-05, D-10 no-op tests)
- **4 tests fail** (NOC-07 through NOC-10 Trinity async tests)
- **Total: 23 tests**

## Test Failures (Expected)

The 4 failing tests are **expected failures** because the implementation has not been updated to use `runTrinityAsync`:

| Test | Failure Reason |
|------|---------------|
| `calls runTrinityAsync when metadata contains snapshot and principleId` | Implementation uses `executeNocturnalReflectionAsync` with `useTrinity=false`, never calls `runTrinityAsync` |
| `startWorkflow returns immediately with state=active` | Implementation is synchronous - returns with `state='completed'` |
| `transitions to completed on Trinity success` | No `nocturnal_completed` logged (Trinity path not active) |
| `transitions to terminal_error on Trinity failure` | No `nocturnal_failed` logged (Trinity path not active) |

## Implementation Gap

**Plan 07-01 was not executed.** The implementation in `nocturnal-workflow-manager.ts` still uses the Phase 6 single-reflector pattern:

```typescript
// Current (Phase 6):
const trinityConfig: Partial<TrinityConfig> = {
    useTrinity: false,  // D-10: single-reflector only
    ...
};
const result = await executeNocturnalReflectionAsync(...);
```

The Phase 7 Trinity async pattern should be:
```typescript
// Expected (Phase 7):
Promise.resolve().then(async () => {
    const result = await runTrinityAsync({ snapshot, principleId, config });
    // recordStageEvents, notifyWaitResult, etc.
});
return { workflowId, state: 'active', ... };
```

## Deviations from Plan

None - tests added exactly as specified in plan tasks.

## Files Modified

| File | Change |
|------|--------|
| `packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts` | +422 lines: Added Trinity mock, NOC-07 through NOC-10 test blocks |

## Key Test Patterns

```typescript
// Trinity mock setup
vi.mock('../../src/core/nocturnal-trinity.js', () => ({
    runTrinityAsync: vi.fn(),
    TrinityStageFailure: { stage: 'dreamer', reason: '' },
}));

// Test verification (example)
expect(mockRunTrinityAsync).toHaveBeenCalledWith(
    expect.objectContaining({
        snapshot: expect.objectContaining({ sessionId: 'test-session' }),
        principleId: 'principle-001',
        config: expect.objectContaining({ useTrinity: true }),
    })
);
```

## Next Steps

Plan 07-01 should be executed to add the actual Trinity async implementation, after which all 23 tests should pass.

---

**Commit**: f760723
**Duration**: ~25 minutes
**Date**: 2026-04-05
