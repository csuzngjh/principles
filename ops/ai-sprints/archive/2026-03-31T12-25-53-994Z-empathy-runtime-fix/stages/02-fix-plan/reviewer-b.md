# Reviewer-B Report — Stage 02-Fix-Plan (Round 3)

## VERDICT

**REVISE**

## BLOCKERS

1. **Change 2 specification is ambiguous and could cause duplicate code**: Producer's "After" section shows `if (finalized) { this.markCompleted(observerSessionKey); }` at L382, but this block ALREADY EXISTS at L377-380. The actual change is ONLY: `cleanupState(parentSessionId, observerSessionKey, finalized)`. If implementer follows the "After" specification literally, they will create a duplicate `markCompleted` call.

2. **Test 3 timing is incorrect**: Retry delay is 2000ms (2 seconds), but test only waits 100ms before asserting `waitForRun` call count. Test will FAIL because retry hasn't executed yet.

## FINDINGS

### Root Cause Analysis — VERIFIED

| Path | observedAt set? | cleanupState delete? | Entry Preserved? |
|------|-----------------|----------------------|------------------|
| `!runId` (L239) | No | `true` (default) | Deleted |
| `waitForRun` throws (L265) | Yes | `false` | Preserved |
| `status='timeout'` (L276) | Yes | `false` | Preserved |
| `status='error'` (L287) | Yes | `false` | Preserved |
| **`status='ok'` (L285→L382)** | **No** | **`true` (default)** | **Deleted even when finalized=false** |

The producer correctly identified that L382 calls `cleanupState()` unconditionally, causing data loss when `reapBySession`'s inner try-catch fails (`finalized=false`).

### Change 1 — APPROVED

- **Location**: Before L285 (`await this.reapBySession(...)`)
- **Purpose**: Set `observedAt` before `reapBySession` so TTL cleanup can expire orphaned entries
- **Lines**: ~3
- **Validated**: Correct placement, enables `isActive()` TTL expiry (L116-125)

### Change 2 — NEEDS CLARIFICATION

- **Location**: L382
- **Current code**: `this.cleanupState(parentSessionId, observerSessionKey);`
- **Needed change**: `this.cleanupState(parentSessionId, observerSessionKey, finalized);`
- **Problem**: Producer's "After" shows duplicate `markCompleted` block that already exists at L377-380
- **Correct specification**: ONLY change `cleanupState` call to pass `finalized` parameter
- **Semantics**: When `finalized=true`, delete from activeRuns; when `finalized=false`, preserve entry for fallback

### Change 3 — APPROVED (test timing issue separate)

- **Location**: L217-219 (spawn's `.catch()` handler)
- **Purpose**: Single 2-second retry for transient failures
- **Lines**: ~8
- **Validated**: Minimal, appropriate for fire-and-forget pattern

### Test Coverage Analysis

- **Existing tests**: 20 (producer claimed 29 — **incorrect**)
- **Proposed new tests**: 3

| Test | Coverage | Issue |
|------|----------|-------|
| Test 1: observedAt before reapBySession | Change 1 | GOOD |
| Test 2: reapBySession failure preserves activeRuns | Change 2 | GOOD |
| Test 3: finalizeRun retry | Change 3 | **TIMING BROKEN** |

**Test 3 timing**: Retry delay = 2000ms, test wait = 100ms. Test will assert before retry fires.

### Scope Control

- PD-only changes: **CONFIRMED** (no OpenClaw modifications)
- Lines changed: ~13 production code
- No gold-plating detected
- **LOW regression risk**: cleanupState signature change uses default parameter, only L382 behavior changes

### Regression Risk — LOW

`cleanupState(parentSessionId, observerSessionKey, deleteFromActiveRuns = true)` signature with default parameter preserves behavior at all call sites except L382, which is the intended fix.

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Notes |
|------------|--------|-------|
| `status=ok` path deletes activeRuns unconditionally | **CONFIRMED** | L382 verified |
| `reapBySession` failure loses data when finalized=false | **CONFIRMED** | Entry deleted despite finalized=false |
| `reap()` fallback needs activeRuns entry | **CONFIRMED** | L401-406 iterates Map |
| Change 2 spec causes duplicate code | **UNRESOLVED** | Producer's "After" shows existing L377-380 code |
| Test 3 timing is sufficient | **DISPROVEN** | 100ms wait < 2000ms retry delay |

## NEXT_FOCUS

1. **Change 2**: Clarify that ONLY `cleanupState` call should be modified, NOT add new `if (finalized)` block
2. **Test 3**: Increase wait time to 2500ms+ OR mock setTimeout to avoid real delay in tests
3. **Documentation**: Correct test count claim (20, not 29)

## CHECKS

CHECKS: criteria=partial;blockers=2;verification=partial;scope=pd-only;tests=20+3new;timing=broken
