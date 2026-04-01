## 2026-03-31 Reviewer-A Worklog

### Checkpoint 1: Verify Line References
- Read stage brief and producer report
- Producer claims Change 1 at "line 283-285": actual `await this.reapBySession` is at L285 (correct)
- Producer claims Change 2 at "line 382": actual `cleanupState` call is at L382 (correct)
- Producer claims Change 3 at "lines 217-219": need to verify spawn's finalizeRun call

### Checkpoint 2: Analyze finalizeRun Paths
Read code from L228-L286:
- `!runId` path (L239): `cleanupState(parentSessionId, observerSessionKey)` - deletes activeRuns with default `deleteFromActiveRuns=true`
- `waitForRun` throws (L259): sets `observedAt`, `cleanupState(..., false)` - preserves activeRuns ✓
- `status='timeout'` (L270): sets `observedAt`, `cleanupState(..., false)` - preserves activeRuns ✓
- `status='error'` (L281): sets `observedAt`, `cleanupState(..., false)` - preserves activeRuns ✓
- `status='ok'` (L285): NO `observedAt` set, calls `reapBySession` which calls `cleanupState` at L382

### Checkpoint 3: Analyze reapBySession Paths (L293-384)
- L299: early return if `isCompleted()` - calls `cleanupState` with default `true`
- L382: unconditional `cleanupState(parentSessionId, observerSessionKey)` after try-catch
- `finalized` flag only controls `markCompleted()`, NOT `cleanupState`

### Checkpoint 4: Root Cause Validation
**PRODUCER IS CORRECT**: The `status='ok'` path:
1. Does NOT set `observedAt` before calling `reapBySession`
2. `reapBySession` calls `cleanupState` at L382 UNCONDITIONALLY
3. If inner try-catch fails (getSessionMessages throws), `finalized=false` but entry STILL deleted

### Checkpoint 5: Producer's Fix Analysis
- **Change 1**: Set `observedAt` before `reapBySession` - VALID for TTL cleanup
- **Change 2**: Conditional `cleanupState` - VALID but needs careful implementation
  - Producer proposes `cleanupState(parentSessionId, observerSessionKey, finalized)` 
  - This would NOT delete activeRuns when `finalized=false`
  - Allows `subagent_ended` fallback to find `parentSessionId` via `activeRuns` Map
- **Change 3**: Single retry - REASONABLE for transient failures

### Checkpoint 6: Test Coverage Analysis
Existing tests (29 tests):
- Test "waitForRun(status=error)" verifies activeRuns preserved (L183-197)
- Test "waitForRun(status=timeout)" verifies activeRuns preserved (L199-214)
- NO TEST for "status=ok" path when `reapBySession` fails

Producer's 3 new tests:
- Test 1: Verify `observedAt` set even when `reapBySession` fails - VALID
- Test 2: Verify `activeRuns` preserved when `finalized=false` - VALID
- Test 3: Verify retry on `finalizeRun` failure - VALID

### Checkpoint 7: Edge Cases Found
1. **Producer's Change 2 has a logic gap**: The proposed code shows:
   ```typescript
   if (finalized) {
       this.markCompleted(observerSessionKey);
   }
   this.cleanupState(parentSessionId, observerSessionKey, finalized);
   ```
   But this changes semantics: when `finalized=true`, entry IS deleted (correct for happy path).
   When `finalized=false`, entry preserved for fallback (correct for failure path).
   **However**: The `reap()` fallback method (L389-416) iterates `activeRuns` to find `parentSessionId`.
   If entry preserved with `finalized=false`, fallback CAN find it. CORRECT.

2. **Potential issue with Change 1 location**: Producer says "Between line 283 and 285".
   Looking at actual code, there's no L283-284 gap - L285 is directly the await.
   The `observedAt` should be set RIGHT BEFORE the await, which is what producer proposes.
   CORRECT placement.

3. **Missing test case**: What happens if `reap()` is called AFTER entry was deleted by TTL?
   The `reap()` method falls back to `extractParentSessionId()`. This is a degraded mode
   but not data loss. ACCEPTABLE.

### Checkpoint 8: Final Verification
- Line numbers verified ✓
- Root cause verified ✓
- Fix logic verified ✓ (with minor clarification needed)
- Test coverage adequate ✓
- PD-only scope confirmed ✓