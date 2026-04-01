# Reviewer-A Report — Stage 02-Fix-Plan

## VERDICT

**APPROVE**

The producer's analysis is accurate and the proposed fixes directly address the root cause of `user_empathy` data loss. All line references verified, logic gaps analyzed, and test coverage is adequate.

---

## BLOCKERS

None.

---

## FINDINGS

### 1. Root Cause Confirmed

The producer correctly identified the data loss path:

| Path | observedAt? | cleanupState(deleteFromActiveRuns) | Entry Preserved? |
|------|-------------|-------------------------------------|------------------|
| `!runId` (L239) | No | `true` (default) | ❌ Deleted |
| `waitForRun` throws (L259) | Yes | `false` | ✅ Preserved |
| `status='timeout'` (L270) | Yes | `false` | ✅ Preserved |
| `status='error'` (L281) | Yes | `false` | ✅ Preserved |
| **`status='ok'` (L285)** | **No** | **`true` (via L382)** | **❌ Deleted unconditionally** |

**Verified by reading `empathy-observer-manager.ts`**: L382 calls `cleanupState(parentSessionId, observerSessionKey)` unconditionally, regardless of `finalized` flag. When `getSessionMessages` throws inside `reapBySession`, `finalized=false` but `activeRuns` entry is still deleted.

### 2. Fix Logic Validated

**Change 1 — Set observedAt before reapBySession**:
- Location: Before L285 (`await this.reapBySession(...)`)
- Purpose: Enable TTL cleanup if `reapBySession` fails
- **VERIFIED**: Correct placement, ~3 lines added

**Change 2 — Conditional cleanupState**:
- Location: L382
- Proposed: `cleanupState(parentSessionId, observerSessionKey, finalized)`
- Purpose: When `finalized=false`, preserve `activeRuns` for `subagent_ended` fallback
- **VERIFIED**: The `reap()` fallback (L389-416) iterates `activeRuns` to find `parentSessionId`; preserving entry enables fallback recovery

**Change 3 — Single retry for finalizeRun**:
- Location: L217-219 (spawn's `.catch()` handler)
- Proposed: 2-second delay + single retry
- **VERIFIED**: Reasonable for transient failures; already fire-and-forget pattern

### 3. Line References Verified

| Claimed Location | Actual Location | Status |
|------------------|-----------------|--------|
| "Between line 283 and 285" | L285 is `await this.reapBySession` | ✓ Correct |
| "Line 382" | L382 is `this.cleanupState(...)` in reapBySession | ✓ Correct |
| "Lines 217-219" | L217-219 is `.catch()` in spawn | ✓ Correct |

### 4. Test Coverage Analysis

**Existing 29 tests**: No test covers `status='ok'` path when `reapBySession` fails.

**Producer's 3 new tests**:
1. `ok path sets observedAt even when reapBySession fails` — Covers Change 1
2. `ok path reapBySession failure preserves activeRuns so fallback can recover` — Covers Change 2
3. `finalizeRun retries once when first attempt fails` — Covers Change 3

**Gap identified**: No test for `reap()` fallback successfully recovering after `finalizeRun` failure path. However, existing test "uses original parentSessionId for business attribution even when session key is sanitized" covers the `activeRuns` lookup path. The fallback behavior is implicitly tested via the sanitized key test.

### 5. Edge Cases Reviewed

1. **TTL expiry + fallback**: If `observedAt` set but fallback never fires, 5-min TTL will clean up. Acceptable degraded mode.

2. **Double-reap prevention**: `isCompleted()` check at L296 prevents double-processing. Producer's Change 2 moves `markCompleted` inside `if (finalized)` — correct.

3. **Race condition**: `reap()` is called by `subagent_ended` hook. If `finalizeRun` succeeds, `isCompleted` returns true and `reap` skips. If `finalizeRun` fails, entry preserved for `reap` to recover. No race condition detected.

---

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Notes |
|------------|--------|-------|
| `status=ok` path deletes activeRuns unconditionally | **CONFIRMED** | L382 verified |
| `reapBySession` inner try-catch failure loses data | **CONFIRMED** | `finalized=false` but entry deleted |
| Fallback `reap()` needs activeRuns entry | **CONFIRMED** | L401-406 iterates Map |
| Fix 1 (observedAt) enables TTL cleanup | **VALIDATED** | `isActive()` L116-125 checks `observedAt` |
| Fix 2 (conditional cleanup) enables fallback | **VALIDATED** | Entry preserved when `finalized=false` |
| Fix 3 (retry) reduces transient failure loss | **PLAUSIBLE** | 2s delay reasonable; production data needed |

---

## NEXT_FOCUS

Implementation should proceed. Minor recommendation:
- Add explicit test for `reap()` fallback successfully recovering after `finalizeRun` failure path (optional, not blocking).

---

## CHECKS

CHECKS: criteria=met;blockers=0;verification=complete;scope=pd-only;tests=29+3
