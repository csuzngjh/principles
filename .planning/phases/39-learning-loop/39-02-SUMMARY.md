---
phase: 39-learning-loop
plan: "02"
subsystem: keyword-learning
tags:
  - keyword-learning
  - correction-cue
  - optimization-workflow
  - workflow-manager

# Dependency graph
requires:
  - phase: 39
    plan: 01
    provides: FPR-weighted scoring, recordFP/TP API, per-workspace throttle
provides:
  - CorrectionObserverWorkflowManager class extending WorkflowManagerBase
  - correctionObserverWorkflowSpec with LLM prompt template and result parsing
  - createCorrectionObserverWorkflowManager factory function
  - CorrectionObserverPayload/Result/WorkflowSpec types
  - Barrel exports from subagent-workflow/index.ts
affects:
  - evolution-worker.ts (consumes CorrectionObserverWorkflowManager for keyword_optimization tasks)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "WorkflowManagerBase extension pattern for LLM optimization dispatch"
    - "Prompt template with keyword store summary, recent messages, and trajectory history"
    - "JSON extraction with regex fallback (reuse from EmpathyObserver)"

key-files:
  created:
    - packages/openclaw-plugin/src/service/correction-observer-types.ts
    - packages/openclaw-plugin/src/service/correction-observer-workflow-manager.ts
  modified:
    - packages/openclaw-plugin/src/service/subagent-workflow/index.ts

key-decisions:
  - "Used ../correction-observer-* import paths from subagent-workflow/index.ts since files reside in parent service directory"
  - "trajectoryHistory field added to CorrectionObserverPayload beyond plan spec for FPR trend analysis (D-40-08)"

requirements-completed:
  - CORR-07
  - CORR-09

# Metrics
duration: 3min
completed: 2026-04-14
---

# Phase 39 Plan 02: CorrectionObserverWorkflowManager Summary

**LLM-driven keyword optimization workflow manager extending WorkflowManagerBase with prompt template, result parsing, and barrel exports for correction observer dispatch**

## Performance

- **Duration:** 3 min
- **Started:** 2026-04-14T12:00:35Z
- **Completed:** 2026-04-14T12:03:12Z
- **Tasks:** 3
- **Files modified:** 1 (barrel exports)
- **Files verified:** 2 (pre-existing type and manager files)

## Accomplishments
- Verified correction-observer-types.ts has all required type exports (CorrectionObserverPayload, CorrectionObserverResult, CorrectionObserverWorkflowSpec)
- Verified correction-observer-workflow-manager.ts has complete WorkflowManagerBase extension with prompt template, surface degrade checks, and factory function
- Enabled barrel exports in subagent-workflow/index.ts (previously commented out with TODO)
- Fixed import paths from `./correction-observer-*` to `../correction-observer-*` since files reside in parent service directory
- TypeScript compilation passes cleanly

## Task Commits

1. **Task 1: Create correction-observer-types.ts** - Pre-existing (f74cb0d1), verified present with all required types
2. **Task 2: Create correction-observer-workflow-manager.ts** - Pre-existing (d0f08975), verified present with complete implementation
3. **Task 3: Add barrel exports to subagent-workflow/index.ts** - `8d75f153` (feat) - uncommented exports, fixed import paths

## Files Created/Modified
- `packages/openclaw-plugin/src/service/correction-observer-types.ts` - Types: CorrectionObserverPayload, CorrectionObserverResult, CorrectionObserverWorkflowSpec (pre-existing, verified)
- `packages/openclaw-plugin/src/service/correction-observer-workflow-manager.ts` - WorkflowManagerBase extension, prompt template, factory (pre-existing, verified)
- `packages/openclaw-plugin/src/service/subagent-workflow/index.ts` - Added barrel exports for CorrectionObserverWorkflowManager and types

## Decisions Made
- **Import path fix:** The correction-observer files live in `src/service/` while index.ts is in `src/service/subagent-workflow/`. Used `../correction-observer-*` paths instead of `./correction-observer-*` to correctly resolve the parent directory.
- **trajectoryHistory enhancement:** The existing CorrectionObserverPayload includes a `trajectoryHistory` field beyond the plan spec, supporting D-40-08 FPR trend analysis. Kept as-is since it enhances the optimization quality without breaking the spec.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Import path resolution for barrel exports**
- **Found during:** Task 3 (barrel exports)
- **Issue:** The commented-out exports used `./correction-observer-workflow-manager.js` but the files are in the parent directory, not in `subagent-workflow/`
- **Fix:** Changed import paths to `../correction-observer-workflow-manager.js` and `../correction-observer-types.js`
- **Files modified:** packages/openclaw-plugin/src/service/subagent-workflow/index.ts
- **Verification:** TypeScript compilation passes
- **Committed in:** 8d75f153

---

**Total deviations:** 1 auto-fixed (1 blocking path issue)
**Impact on plan:** Minimal. Correct import path resolution required for barrel exports to work.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- CorrectionObserverWorkflowManager ready for consumption by evolution-worker.ts keyword_optimization task dispatch
- The workflow manager can receive keyword store summaries, recent messages, and trajectory history for LLM optimization
- Barrel exports enable clean imports from subagent-workflow module

---
*Phase: 39-learning-loop*
*Completed: 2026-04-14*

## Self-Check: PASSED

- FOUND: packages/openclaw-plugin/src/service/correction-observer-types.ts
- FOUND: packages/openclaw-plugin/src/service/correction-observer-workflow-manager.ts
- FOUND: packages/openclaw-plugin/src/service/subagent-workflow/index.ts
- FOUND: commit 8d75f153
