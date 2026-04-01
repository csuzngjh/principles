# Producer Report — Stage 03-Implement

## SUMMARY

Applied three targeted fixes to `empathy-observer-manager.ts` to resolve `user_empathy` data loss. All 22 tests pass (20 existing + 2 new). Change 3 (retry) is implemented but has no dedicated test due to mock timing constraints — the defensive wrapper only fires on truly unexpected errors.

## CHANGES

### File: `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`

1. **Change 1** (line ~288): Set `observedAt` before `reapBySession` in ok path — TTL cleanup works even on failure
2. **Change 2** (line ~391): Pass `finalized` to `cleanupState` — preserves `activeRuns` for subagent_ended fallback
3. **Change 3** (line ~214): Single retry with 2s delay for fire-and-forget `finalizeRun`

### File: `packages/openclaw-plugin/tests/service/empathy-observer-manager.test.ts`

2 new tests: observedAt set on failure, activeRuns preserved for fallback.

## EVIDENCE

22/22 tests pass (vitest). No regressions.

## CHECKS

CHECKS: evidence=verified;tests=22pass+2new;scope=pd-only;openclaw=no-changes
