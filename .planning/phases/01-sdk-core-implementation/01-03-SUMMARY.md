---
phase: "01"
plan: "03"
subsystem: sdk-core
tags:
  - sdk
  - adapter
  - coding
  - openclaw
dependency_graph:
  requires:
    - "01-01"
  provides:
    - "OpenClawPainAdapter implementation"
  affects:
    - packages/principles-core
tech_stack:
  added:
    - OpenClawPainAdapter class
  patterns:
    - PainSignalAdapter pattern for framework-specific adapters
key_files:
  created:
    - packages/principles-core/src/adapters/coding/openclaw-event-types.ts
    - packages/principles-core/src/adapters/coding/openclaw-pain-adapter.ts
    - packages/principles-core/src/adapters/coding/index.ts
    - packages/principles-core/tests/adapters/coding/openclaw-pain-adapter.test.ts
decisions:
  - "OpenClawPainAdapter uses sessionId as traceId proxy since OpenClaw events don't have traceId"
  - "agentId defaults to 'unknown' (not empty string) to satisfy PainSignalSchema minLength:1"
---
# Phase 01 Plan 03: OpenClawPainAdapter Summary

## One-liner
Implemented OpenClawPainAdapter (Coding domain adapter) with capture() method translating OpenClaw tool failure events to PainSignals.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Create OpenClaw event type shims | 59ef259d | src/adapters/coding/openclaw-event-types.ts |
| 2 | Implement OpenClawPainAdapter | 59ef259d | src/adapters/coding/openclaw-pain-adapter.ts |
| 3 | Create coding adapter barrel export | 59ef259d | src/adapters/coding/index.ts |
| 4 | Create unit tests | 59ef259d | tests/adapters/coding/openclaw-pain-adapter.test.ts |

## What Was Built

### openclaw-event-types.ts
- Minimal type shim for `PluginHookAfterToolCallEvent`
- Duplicated from openclaw-plugin (principles-core cannot import from openclaw-plugin)

### OpenClawPainAdapter
- Implements `PainSignalAdapter<PluginHookAfterToolCallEvent>`
- `capture()` returns PainSignal for tool failures, null otherwise
- Score derivation from error characteristics:
  - EACCES/permission denied: 95 (critical)
  - ENOENT: 80 (high)
  - EISDIR: 85 (high)
  - SyntaxError/ParseError: 82 (high)
  - TypeError: 75 (high)
  - ReferenceError: 72 (high)
  - Timeout: 60 (medium)
  - Network errors: 65 (medium)
  - EEXIST/ENOTEMPTY: 55 (medium)
  - Default: 50 (medium)

### Tests (13 test cases)
- Non-failure returns null
- ENOENT gets score 80, high severity
- Permission denied gets score 95, critical severity
- Timeout gets score 60, medium severity
- Malformed event (missing toolName) returns null
- Output passes validatePainSignal()
- domain is 'coding'
- severity derived correctly
- sessionId/agentId defaults
- Provided sessionId/agentId used
- context includes toolName

## Verification

- [x] Build succeeds
- [x] All 13 tests pass
- [x] SDK-ADP-07 requirement satisfied

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] agentId and traceId empty strings fail PainSignalSchema validation**
- **Found during:** Running tests
- **Issue:** adapter captured() returned agentId: '' and traceId: '' which fail minLength:1 schema validation
- **Fix:** Changed defaults to 'unknown' instead of ''
- **Files modified:** packages/principles-core/src/adapters/coding/openclaw-pain-adapter.ts
- **Commit:** 59ef259d

**2. [Rule 2 - Missing critical functionality] Test expected invalid empty string for agentId**
- **Found during:** Test run after fix
- **Issue:** Test expected agentId: '' but schema requires minLength:1
- **Fix:** Updated test expectation to 'unknown'
- **Files modified:** packages/principles-core/tests/adapters/coding/openclaw-pain-adapter.test.ts
- **Commit:** 59ef259d

## Self-Check: PASSED

- [x] OpenClawPainAdapter implemented
- [x] 13 tests pass
- [x] Commit 59ef259d exists
