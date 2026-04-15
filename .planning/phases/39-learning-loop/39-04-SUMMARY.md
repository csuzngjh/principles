---
phase: 39-learning-loop
plan: 04
subsystem: keyword-learning
tags:
  - keyword-learning
  - correction-cue
  - gap-closure
  - trigger-mode
  - false-positive-rate

# Dependency graph
requires:
  - phase: 39-learning-loop/03
    provides: CorrectionCueLearner wiring in prompt.ts, keyword_optimization config, enqueueKeywordOptimizationTask function
provides:
  - Corrected true positive recording for correction cue detections (CR-01 fix)
  - trigger_mode-independent keyword_optimization periodic trigger
affects: [39-learning-loop, nocturnal-pipeline, correction-cue-detection]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Independent periodic trigger: keyword_optimization operates on its own config cycle outside trigger_mode gating"

key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/hooks/prompt.ts
    - packages/openclaw-plugin/src/service/evolution-worker.ts

key-decisions:
  - "CR-01: Correction cue detection is a true positive, not false positive. FP would apply x0.8 weight decay on correct matches."
  - "keyword_optimization trigger must be independent of trigger_mode since default mode is 'idle' not 'periodic'"

patterns-established:
  - "Dedicated periodic triggers (like keyword_optimization) should operate independently of sleep_reflection trigger_mode"

requirements-completed: []

# Metrics
duration: 4min
completed: 2026-04-14
---

# Phase 39 Plan 04: Gap Closure -- CR-01 Semantic Bug and trigger_mode Coverage Summary

**Fixed CR-01 semantic bug (recordFalsePositive -> recordTruePositive) and extracted keyword_optimization trigger outside trigger_mode guard for default idle mode reachability**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-14T13:57:11Z
- **Completed:** 2026-04-14T14:01:13Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments
- Fixed CR-01: correction cue detections now call recordTruePositive instead of recordFalsePositive, preventing x0.8 weight decay on correct keyword matches
- Extracted keyword_optimization periodic check outside trigger_mode === 'periodic' guard so it fires in default idle mode (every 24 heartbeats = 6 hours)
- TypeScript compilation verified clean after both changes

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix CR-01 -- change recordFalsePositive to recordTruePositive in prompt.ts** - `45a4435f` (fix)
2. **Task 2: Extract keyword_optimization trigger outside trigger_mode guard in evolution-worker.ts** - `abdf8d59` (fix)

## Files Created/Modified
- `packages/openclaw-plugin/src/hooks/prompt.ts` - Changed recordFalsePositive to recordTruePositive for correction cue detection, updated comment with CR-01 rationale
- `packages/openclaw-plugin/src/service/evolution-worker.ts` - Restructured heartbeat cycle to extract keyword_optimization check outside trigger_mode periodic guard

## Decisions Made
- **CR-01 true positive semantics:** A correction cue detection means the keyword correctly identified a dissatisfaction pattern. This is a confirmed match (true positive), not a false positive. The original D-39-07 decision conflated "user expressing dissatisfaction" (negative sentiment) with "false positive" (incorrect keyword match). These are orthogonal: a keyword can correctly match while the user expresses dissatisfaction.
- **Independent keyword_optimization trigger:** The keyword_optimization has its own dedicated config (kwOptConfig.enabled, kwOptConfig.period_heartbeats=24) and should operate independently of sleep_reflection's trigger_mode. Default trigger_mode is 'idle', so gating behind 'periodic' made the feature unreachable.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Both verification gaps from Phase 39 re-verification are now closed
- Correction cue detection pipeline correctly records true positives
- Keyword optimization trigger fires in all trigger modes (idle and periodic)
- Ready for any subsequent verification or integration testing

---
*Phase: 39-learning-loop*
*Completed: 2026-04-14*

## Self-Check: PASSED

- FOUND: packages/openclaw-plugin/src/hooks/prompt.ts
- FOUND: packages/openclaw-plugin/src/service/evolution-worker.ts
- FOUND: .planning/phases/39-learning-loop/39-04-SUMMARY.md
- FOUND: commit 45a4435f (Task 1)
- FOUND: commit abdf8d59 (Task 2)
