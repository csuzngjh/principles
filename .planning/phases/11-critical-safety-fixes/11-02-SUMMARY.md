---
phase: "11-critical-safety-fixes"
plan: "02"
subsystem: evolution-worker
tags: [cleanup, legacy-removal, pain-processing]

# Dependency graph
requires: []
provides:
  - PAIN_CANDIDATES system completely removed from evolution-worker.ts
  - Evolution queue confirmed as single active pain→principle path
affects: [phase-12, phase-13]

# Tech tracking
tech-stack:
  added: []
  patterns: [legacy-system-removal]

key-files:
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts

key-decisions:
  - "D-08: Evolution queue is the single active pain→principle path — PAIN_CANDIDATES was disconnected fallback, deleted"

patterns-established: []

requirements-completed: [CLEAN-02]

# Metrics
duration: ~7min
completed: 2026-04-07
---

# Phase 11-02 Plan Summary

**PAIN_CANDIDATES legacy system removed from evolution-worker.ts — evolution queue now sole pain→principle path**

## Performance

- **Duration:** ~7 min
- **Started:** 2026-04-07T02:43:10Z
- **Completed:** 2026-04-07T02:50:09Z
- **Tasks:** 3 (all completed)
- **Files modified:** 1

## Accomplishments

- Deleted PainCandidateEntry interface (lines 126-132)
- Deleted PAIN_CANDIDATES_LOCK_SUFFIX and related sample size constants (lines 193, 197-200)
- Deleted helper functions: normalizePainCandidateText, shouldTrackPainCandidate, createPainCandidateFingerprint, summarizePainCandidateSample, isPendingPainCandidate (lines 217-257)
- Deleted trackPainCandidate function and its call site in processDetectionQueue (lines 1366, 1374-1412)
- Deleted processPromotion function and its call sites in runCycle (lines 1687, 1771, 1414-1474)

## Task Commits

Each task was committed atomically:

1. **Task 1: Delete PAIN_CANDIDATES constants, types, and helper functions** - `4803954` (refactor)
2. **Task 2: Delete trackPainCandidate call site and function definition** - `4803954` (same commit as Task 1 — cohesive deletion)
3. **Task 3: Delete processPromotion function and its call sites** - `4803954` (same commit as Tasks 1-2 — unified deletion)

## Files Created/Modified

- `packages/openclaw-plugin/src/service/evolution-worker.ts` - Removed 165 lines of PAIN_CANDIDATES system (17 lines added for comments)

## Decisions Made

- D-05 through D-12 were pre-decided in the plan. Execution followed the plan exactly.
- Per D-11/D-12: PAIN_CANDIDATES path references in path-resolver.ts and migration.ts were intentionally NOT deleted (harmless historical references; file no longer written; runtime-summary-service.ts reads gracefully handle missing files)

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

| Check | Result |
|-------|--------|
| `grep -c "PAIN_CANDIDATES_LOCK_SUFFIX\|PainCandidateEntry\|PAIN_CANDIDATE_MAX_SAMPLES"` | 0 (actual code, excluding comments) |
| `grep -c "trackPainCandidate"` | 0 (actual code, excluding comments) |
| `grep -c "processPromotion"` | 0 (actual code, excluding comments) |
| `npx tsc --noEmit -p packages/openclaw-plugin/tsconfig.json` | PASSED (no errors) |
| Evolution queue path intact | 9 references remain |

## Issues Encountered

None.

## Next Phase Readiness

- CLEAN-02 requirement completed (PAIN_CANDIDATES legacy path removed)
- Phase 11 remaining work: CLEAN-01 (normalizePath naming conflict in nocturnal-compliance.ts)
- Phase 12 (Code Deduplication) and Phase 13 (Cleanup and Investigation) can proceed independently

---
*Phase: 11-critical-safety-fixes*
*Completed: 2026-04-07*
