---
phase: 39-learning-loop
plan: 01
subsystem: keyword-learning
tags:
  - keyword-learning
  - correction-cue
  - fpr-tracking
  - confidence-score
  - throttle

# Dependency graph
requires:
  - phase: 38
    provides: CorrectionCueLearner class, CorrectionKeyword interface, nocturnal-runtime checkCooldown
provides:
  - FPR counter fields on CorrectionKeyword (hitCount, truePositiveCount, falsePositiveCount)
  - Weighted confidence scoring in match() using tp/(tp+fp+1) formula
  - recordFalsePositive() with x0.8 multiplicative weight decay
  - recordTruePositive() with atomic TP counter increment
  - Per-workspace daily throttle (4 calls/day) via canRunKeywordOptimization()
affects:
  - 39-learning-loop (subsequent plans consuming FP/TP feedback loop)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Weighted scoring: score = weight x (TP / (TP + FP + 1)) with +1 smoothing"
    - "Multiplicative weight decay: weight *= 0.8 on confirmed false positive"
    - "Per-workspace throttle via checkCooldown with maxRunsPerWindow=4"

key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/core/correction-cue-learner.ts

key-decisions:
  - "Aligned match() formula to plan spec tp/(tp+fp+1) over prior Bayesian (tp+1)/(tp+fp+2) for consistency with D-39-03/D-39-04"
  - "Removed Math.max(0.1) weight floor from recordFalsePositive per plan spec; keywords decay freely below 0.1"

patterns-established:
  - "In-store reference update: findIndex + spread copy before flush for mutation safety"
  - "Case-insensitive term matching in all record methods via .toLowerCase() comparison"

requirements-completed:
  - CORR-02
  - CORR-06
  - CORR-08
  - CORR-10

# Metrics
duration: 4min
completed: 2026-04-14
---

# Phase 39 Plan 01: FPR Counter Schema and Weighted Scoring Summary

**FPR-weighted confidence scoring with x0.8 decay on false positives and per-workspace 4/day optimization throttle for correction cue keywords**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-14T11:45:32Z
- **Completed:** 2026-04-14T11:50:01Z
- **Tasks:** 4
- **Files modified:** 1

## Accomplishments
- Aligned match() weighted score formula to plan spec: `weight x (TP / (TP + FP + 1))` with +1 smoothing
- Added in-store reference update pattern in match(), recordTruePositive(), recordFalsePositive() for mutation safety
- Removed Math.max(0.1) floor from recordFalsePositive weight decay, allowing keywords to decay freely
- Verified all four success criteria: FPR fields, weighted formula, recordFP/TP methods, per-workspace throttle

## Task Commits

Each task was committed atomically:

1. **Task 1: FPR counter fields** - Already present in `correction-types.ts` from prior phase, no new commit needed
2. **Task 2: Weighted score formula** - `78b71fa7` (feat) - aligned to tp/(tp+fp+1) formula, added store reference update
3. **Task 3: recordFalsePositive/recordTruePositive** - `78b71fa7` (feat) - removed weight floor, added store reference updates
4. **Task 4: Per-workspace throttle** - Already present from prior phase, verified in same commit

## Files Created/Modified
- `packages/openclaw-plugin/src/core/correction-cue-learner.ts` - Weighted scoring formula, recordFP/TP with store updates, throttle integration
- `packages/openclaw-plugin/src/core/correction-types.ts` - FPR counter fields (hitCount, truePositiveCount, falsePositiveCount) verified present from prior phase

## Decisions Made
- **Formula alignment:** Changed from Bayesian smoothing `(tp+1)/(tp+fp+2)` to plan-specified `tp/(tp+fp+1)` per locked decisions D-39-03/D-39-04. New keywords (TP=0, FP=0) now score 0 instead of 0.5, meaning seed keywords require at least one confirmed true positive before contributing to match scores.
- **Weight floor removal:** Removed `Math.max(0.1, ...)` from recordFalsePositive per D-39-17 ("keywords at very low weight can still match but contribute minimally"). The floor was preventing natural decay below 0.1.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Store reference updates for mutation safety**
- **Found during:** Task 2 (weighted score formula)
- **Issue:** Direct mutation of keyword objects in the loop could cause stale references if the store array is reindexed
- **Fix:** Added explicit `findIndex` + spread copy pattern after hitCount increments in match(), and in both recordTruePositive() and recordFalsePositive()
- **Files modified:** packages/openclaw-plugin/src/core/correction-cue-learner.ts
- **Verification:** TypeScript compilation passes
- **Committed in:** 78b71fa7

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Minor safety improvement for store mutation consistency. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- FPR counter schema and weighted scoring ready for consumption by subsequent 39-xx plans
- The correction cue learning loop can now track accuracy per keyword and decay weights on false positives
- Per-workspace throttle prevents runaway optimization calls

---
*Phase: 39-learning-loop*
*Completed: 2026-04-14*

## Self-Check: PASSED

- FOUND: packages/openclaw-plugin/src/core/correction-cue-learner.ts
- FOUND: packages/openclaw-plugin/src/core/correction-types.ts
- FOUND: .planning/phases/39-learning-loop/39-01-SUMMARY.md
- FOUND: commit 78b71fa7
