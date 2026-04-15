---
phase: 39-learning-loop
reviewed: 2026-04-14T19:00:00Z
depth: standard
files_reviewed: 6
files_reviewed_list:
  - packages/openclaw-plugin/src/core/correction-types.ts
  - packages/openclaw-plugin/src/core/correction-cue-learner.ts
  - packages/openclaw-plugin/src/service/subagent-workflow/index.ts
  - packages/openclaw-plugin/src/service/nocturnal-config.ts
  - packages/openclaw-plugin/src/service/evolution-worker.ts
  - packages/openclaw-plugin/src/hooks/prompt.ts
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 39: Code Review Report

**Reviewed:** 2026-04-14T19:00:00Z
**Depth:** standard
**Files Reviewed:** 6
**Status:** issues_found

## Summary

Reviewed 6 source files in the correction keyword learning loop (phase 39). The prior CR-01 (recording correction cues as false positives) has been correctly fixed -- `prompt.ts` now calls `recordTruePositive()` at line 363. This review found one new critical bug in the heartbeat counter interaction between `keyword_optimization` and `periodic` trigger mode, two warnings around shared cooldown quota contamination and keyword_optimization not counting no-update completions against its throttle, and two info items.

## Critical Issues

### CR-01: `keyword_optimization` trigger breaks when `trigger_mode` is `periodic` -- shared `heartbeatCounter` is reset by sleep_reflection

**File:** `packages/openclaw-plugin/src/service/evolution-worker.ts:2396,2408`
**Issue:** The `heartbeatCounter` variable is shared between `keyword_optimization` periodic triggering (line 2396) and `sleep_reflection` periodic triggering (line 2404-2408). When `sleepConfig.trigger_mode === 'periodic'`, the sleep_reflection path resets `heartbeatCounter = 0` every `period_heartbeats` cycles (default: 4). The `keyword_optimization` trigger fires when `heartbeatCounter % kwOptConfig.period_heartbeats === 0` (default: 24).

This creates an interaction bug: the keyword_optimization trigger depends on the counter reaching 24, but the counter resets to 0 every 4 cycles. The trigger only fires if `kwOptConfig.period_heartbeats` is an exact multiple of `sleepConfig.period_heartbeats`. With defaults (24 and 4), it works because 24 % 4 === 0. But if a user configures `period_heartbeats: 5` for sleep_reflection, the counter resets at 5, 10, 15, 20, 25... and never hits exactly 24, so `keyword_optimization` never fires.

In `idle` trigger mode (the default), this is not an issue because the counter is never reset.

**Fix:**
```typescript
// evolution-worker.ts -- Use separate counters for keyword_optimization and sleep_reflection
let heartbeatCounter = 0;
let keywordOptCounter = 0; // Independent counter for keyword_optimization

async function runCycle(): Promise<void> {
    const cycleStart = Date.now();
    heartbeatCounter++;
    keywordOptCounter++;

    // ... existing code ...

    // keyword_optimization: Uses its own independent counter
    if (kwOptConfig.enabled && keywordOptCounter > 0 && keywordOptCounter % kwOptConfig.period_heartbeats === 0) {
        logger?.info?.(`[PD:EvolutionWorker] keyword_optimization trigger at keywordOptCounter ${keywordOptCounter}`);
        enqueueKeywordOptimizationTask(wctx, logger).catch(/* ... */);
        keywordOptCounter = 0; // Reset only this counter
    }

    // sleep_reflection periodic: Only resets heartbeatCounter (unchanged)
    if (sleepConfig.trigger_mode === 'periodic') {
        if (heartbeatCounter >= sleepConfig.period_heartbeats) {
            shouldTrySleepReflection = true;
            heartbeatCounter = 0;
        }
    }
    // ...
}
```

## Warnings

### WR-01: Shared `recentRunTimestamps` quota pool contaminates `keyword_optimization` throttle with `sleep_reflection` runs

**File:** `packages/openclaw-plugin/src/core/correction-cue-learner.ts:251-257` and `packages/openclaw-plugin/src/service/nocturnal-runtime.ts:414-418`
**Issue:** `canRunKeywordOptimization()` calls `checkCooldown()` with `maxRunsPerWindow: 4`, which counts entries in `state.recentRunTimestamps`. However, this array is shared across all task types -- `sleep_reflection` runs also push timestamps via `recordRunStart()` (line 487 of nocturnal-runtime.ts). With the default `sleep_reflection.max_runs_per_day: 3`, the combined timestamps from 3 sleep_reflections + keyword_optimization runs can exhaust the keyword_optimization quota of 4, even if keyword_optimization itself has not run at all.

In practice, this is mitigated because the sleep_reflection quota is lower (3) and the keyword_optimization quota is 4, so at most 3 sleep runs consume 3 of the 4 slots. But if a user increases `max_runs_per_day` for sleep_reflection above 4, keyword_optimization would be completely blocked.

**Fix:** Either add a `taskKind` discriminator to `recentRunTimestamps` entries (e.g., store `{timestamp, kind}` objects and filter by kind), or give `keyword_optimization` its own dedicated throttle state file.

### WR-02: `keyword_optimization` task completes without counting against daily throttle when LLM returns no updates

**File:** `packages/openclaw-plugin/src/service/evolution-worker.ts:2035-2041`
**Issue:** When a `keyword_optimization` workflow completes successfully but the parsed result has no updates (`parsedResult?.updated` is falsy), the task is marked as `completed` (line 2043) but `learner.recordOptimizationPerformed()` is never called (line 2037 is inside the `if (parsedResult?.updated)` block). This means a no-update LLM run does not count against the daily 4-run throttle.

If the LLM consistently returns no-op results (e.g., due to a prompt issue), the system will keep enqueuing and running keyword_optimization tasks every 6 hours without ever incrementing the throttle counter, wasting resources.

**Fix:** Move `recordOptimizationPerformed()` outside the `if (parsedResult?.updated)` conditional so that all completed runs count against the throttle:
```typescript
// Always count against throttle when workflow completes
await learner.recordOptimizationPerformed();

if (parsedResult?.updated) {
    koService.applyResult(parsedResult);
    logger?.info?.(`[PD:EvolutionWorker] keyword_optimization applied mutations: ${parsedResult.summary}`);
} else {
    logger?.info?.(`[PD:EvolutionWorker] keyword_optimization completed with no updates`);
}
```

### WR-03: `match()` mutates store state as a side effect of a read operation

**File:** `packages/openclaw-plugin/src/core/correction-cue-learner.ts:172-173`
**Issue:** The `match()` method increments `keyword.hitCount` and updates `keyword.lastHitAt` on the internal store object. This means a pure query operation has write side effects. If `match()` is called but `flush()` is never called afterward (e.g., a caller only checks the result and does not trigger any recording path), the hitCount mutation stays in memory but is never persisted. The in-memory state silently diverges from disk.

This is a design concern rather than an active bug since current callers do eventually flush, but it makes the API contract fragile -- future callers who only call `match()` for scoring will silently accumulate un-persisted state.

**Fix:** Consider separating read and write concerns: have `match()` return results without mutation, and provide an explicit `recordHit(term)` method. Alternatively, document the side effect clearly in the method's JSDoc.

## Info

### IN-01: Dead code in `match()` -- redundant keyword copy loop

**File:** `packages/openclaw-plugin/src/core/correction-cue-learner.ts:178-184`
**Issue:** After incrementing `hitCount` directly on keyword objects in the first loop (line 172), the code iterates `matchedTerms` again to create shallow copies: `this.store.keywords[keywordIndex] = { ...kw }`. But `keyword` already references the same object in the array, so the mutation at line 172 already updated the array element. The spread copy is a no-op -- it creates a new object with the same values and replaces the reference with an identical copy.

**Fix:** Remove the second loop (lines 178-184) entirely. The mutations from the first loop are already applied to the store's keyword array. The comment "Persist hitCount updates in store for next flush" is misleading since `flush()` writes the entire `this.store` to disk regardless of whether objects were copied.

### IN-02: Legacy `detectCorrectionCue()` function coexists with `CorrectionCueLearner.match()`

**File:** `packages/openclaw-plugin/src/hooks/prompt.ts:88-112`
**Issue:** The old hardcoded `detectCorrectionCue()` function with 16 inline cue strings is still used in `handleBeforePromptBuild` (line 335), while the new `CorrectionCueLearner.match()` method exists separately. The new learner-based system is designed to replace this hardcoded list, but both are active simultaneously. The prompt hook uses `detectCorrectionCue()` for the correctionDetected flag and then calls `learner.recordTruePositive()` with the old function's result. The learner's own `match()` is never called in the prompt hook.

This means the new learner's growing keyword set (with LLM-discovered terms) is never consulted at prompt time -- only the original 16 hardcoded cues are checked.

**Fix:** This may be intentional for phase 39 incremental rollout, but should be tracked for follow-up: replace the `detectCorrectionCue()` call with `learner.match()` to use the learned keyword set for detection.

---

_Reviewed: 2026-04-14T19:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
