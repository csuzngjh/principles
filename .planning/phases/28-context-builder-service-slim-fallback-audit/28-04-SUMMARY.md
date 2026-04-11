---
phase: "28"
plan: "04"
subsystem: evolution-worker
tags:
  - fallback-audit
  - CONTRACT-04
  - CONTRACT-05
  - fail-fast
  - fail-visible
dependency_graph:
  requires:
    - "28-01"
    - "28-02"
    - "28-03"
  provides:
    - CONTRACT-04
    - CONTRACT-05
tech_stack:
  added:
    - fallback-audit.ts
patterns:
  - Classification registry (fail-fast / fail-visible / removed)
  - EventLog skip/drop event wiring verification
key_files:
  created:
    - packages/openclaw-plugin/src/core/fallback-audit.ts
metrics:
  duration: ~
  completed: "2026-04-11"
---

# Phase 28 Plan 04: Fallback Audit Codification — Summary

## One-liner

Authoritative `FALLBACK_AUDIT` registry created in `fallback-audit.ts` classifying all 16 fallback points (4 fail-fast, 8 fail-visible, 4 removed) for CONTRACT-04 and CONTRACT-05, with lookup helpers and EventLog reason-string verification.

## Decisions Made

1. **FB-04 and FB-05 reclassified as fail-visible (per 28-REVIEWS.md Issue 3)**: Both `checkWorkspaceIdle` and `checkCooldown` errors are caught in `TaskContextBuilder.buildCycleContext`, default values returned, and `eventLog.recordSkip()` emitted. Pipeline continues — not fail-fast.

2. **FB-09, FB-10, FB-11 marked as removed (per 28-REVIEWS.md Issue 2)**: `processDetectionQueue` retired per D-05. All three fallback points no longer exist in the codebase.

3. **Classification rule codified**: "boundary entry" = fail-fast (workspace resolution, persistence init, queue write), "pipeline middle" = fail-visible (detection, snapshot building, dispatch, flush).

## Deviations from Plan

### Auto-fixed Issues

None — the plan was followed exactly as written.

### Plan-vs-Reality Gaps Found During Execution (Not Fixed)

**1. [Plan Gap - FB-15] `worker_status_write_failed` not wired to EventLog**
- **Found during:** Task 2 (EventLog wiring verification)
- **Issue:** Plan stated "Must find: `eventLog.recordSkip` call with `reason='worker_status_write_failed'`" but this call does not exist in `evolution-worker.ts`. The `writeWorkerStatus` function (L132-139) has a silent empty catch block.
- **Status:** NOT FIXED — this is a plan-vs-implementation gap, not a bug in new code. The `fallback-audit.ts` correctly documents FB-15 as fail-visible with `eventReason: 'worker_status_write_failed'`, but the actual EventLog call is absent from the source.
- **Impact:** FB-15 fail-visible degradation is not observable via EventLog.
- **Plan for resolution:** This gap should be addressed by the plan author — the plan incorrectly assumed the EventLog call existed.

**2. [Plan Gap - FB-16] `subagent_runtime_unavailable_sweep` not wired to EventLog**
- **Found during:** Task 2 (EventLog wiring verification)
- **Issue:** Plan stated "Must find: `eventLog.recordSkip` call with `reason='subagent_runtime_unavailable_sweep'`" in `workflow-orchestrator.ts` but this call does not exist. The `sweepExpired` fallback path (L250-266) logs a warning but emits no EventLog event.
- **Status:** NOT FIXED — same as FB-15, this is a plan-vs-implementation gap.
- **Impact:** FB-16 fail-visible degradation is not observable via EventLog.
- **Plan for resolution:** This gap should be addressed by the plan author.

## Task Results

### Task 1: Create fallback-audit.ts with all fallback classifications (revised)

**Status:** COMPLETE
**Commit:** `9e1d7dc`

Created `packages/openclaw-plugin/src/core/fallback-audit.ts` (253 lines) containing:
- `FallbackDisposition` type: `'fail-fast' | 'fail-visible' | 'removed'`
- `FallbackPoint` interface with id, name, location, guards, disposition, eventReason, fallbackBehavior
- `FALLBACK_AUDIT` array: 16 fallback points
  - 4 fail-fast: FB-01 (workspaceDir), FB-02 (stateDir), FB-03 (initPersistence), FB-06 (queue corruption)
  - 8 fail-visible: FB-04, FB-05, FB-07, FB-08, FB-13, FB-14, FB-15, FB-16
  - 4 removed: FB-09, FB-10, FB-11 (D-05), FB-12 (N/A)
- Lookup functions: `getFallback()`, `getFailFastFallbacks()`, `getFailVisibleFallbacks()`, `getRemovedFallbacks()`
- Diagnostic helper: `isKnownFallbackReason()`

### Task 2: Verify fail-visible fallbacks are wired to EventLog (revised)

**Status:** COMPLETE (with documented gaps)
**Commit:** N/A (verification only, no code changes)

Verified EventLog `recordSkip()` reason strings:

| Fallback | Reason String | File | Found |
|----------|--------------|------|-------|
| FB-04 | `checkWorkspaceIdle_error` | task-context-builder.ts | YES (L104) |
| FB-05 | `checkCooldown_error` | task-context-builder.ts | YES (L130) |
| FB-07 | `pain_detector_error` | evolution-worker.ts | YES (L233) |
| FB-08 | `heartbeat_trigger_unavailable` | evolution-worker.ts | YES (L280) |
| FB-13 | `dictionary_flush_failed` | evolution-worker.ts | YES (L322) |
| FB-14 | `session_flush_failed` | evolution-worker.ts | YES (L334) |
| FB-15 | `worker_status_write_failed` | evolution-worker.ts | NO (gap) |
| FB-16 | `subagent_runtime_unavailable_sweep` | workflow-orchestrator.ts | NO (gap) |

**6 of 8 fail-visible fallback points are correctly wired.** FB-15 and FB-16 gaps documented above.

## Verification Results

| Check | Expected | Actual |
|-------|----------|--------|
| File exists | `fallback-audit.ts` present | PASS |
| FB-ID count | 16 | PASS |
| fail-fast count | 4 | PASS |
| fail-visible count | 8 | PASS |
| removed count | 4 | PASS |
| FB-04/05 disposition | `fail-visible` | PASS |
| FB-09/10/11 disposition | `removed` | PASS |
| Lookup functions | 5 exported | PASS |
| EventLog wiring (FB-04/05/07/08/13/14) | Found | 6/6 PASS |
| EventLog wiring (FB-15/16) | Found | 0/2 GAP |

## Known Stubs

None — `fallback-audit.ts` is a pure read-only registry, no rendering stubs.

## Threat Flags

None — this is a read-only classification registry with no untrusted input surface.

## Self-Check

- `packages/openclaw-plugin/src/core/fallback-audit.ts` — FOUND
- Commit `9e1d7dc` — FOUND
- All 16 FB IDs present — PASS
- 4 fail-fast, 8 fail-visible, 4 removed — PASS
- FB-04/05 fail-visible — PASS
- FB-09/10/11 removed — PASS

## Self-Check: PASSED
