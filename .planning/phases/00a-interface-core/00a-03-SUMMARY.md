---
phase: 00a-interface-core
plan: 03
subsystem: interface-core
tags: ["hallucination-detection", "principle-injection", "nocturnal", "quality", "budget"]

# Dependency graph
requires:
  - phase: 00a-01
    provides: PainSignal schema, StorageAdapter interface
provides:
  - validateExtraction() for hallucination detection in Trinity chain
  - selectPrinciplesForInjection() for budget-aware principle selection
  - InjectablePrinciple interface for cross-type principle handling
affects: ["nocturnal-trinity", "prompt-hook", "principle-injection"]

# Tech tracking
tech-stack:
  added: []
  patterns: ["keyword-overlap hallucination detection", "priority-weighted budget selection", "duck-typed principle interface"]

key-files:
  created:
    - path: "packages/openclaw-plugin/src/core/principle-injection.ts"
      provides: "selectPrinciplesForInjection, formatPrinciple, InjectablePrinciple, DEFAULT_PRINCIPLE_BUDGET"
    - path: "packages/openclaw-plugin/tests/core/principle-injection.test.ts"
      provides: "12 tests covering priority ordering, budget, P0 guarantee, breakdown"
  modified:
    - path: "packages/openclaw-plugin/src/core/nocturnal-trinity.ts"
      provides: "validateExtraction, HallucinationDetectionResult, integrated into runTrinityAsync and runTrinityWithStubs"
    - path: "packages/openclaw-plugin/src/hooks/prompt.ts"
      provides: "Updated to use selectPrinciplesForInjection with 4000-char budget"
    - path: "packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts"
      provides: "10 new tests for validateExtraction"

key-decisions:
  - "Used keyword-overlap heuristic for hallucination detection (balance of precision and simplicity vs LLM-based validation)"
  - "Force-include at least one P0 principle even when over budget (P0 principles are safety-critical)"
  - "Created InjectablePrinciple duck-typed interface to bridge evolution-types.Principle and principle-tree-schema.Principle"
  - "4000-char default budget for active principles, 1000-char sub-budget for probation principles"

patterns-established:
  - "Post-Scribe hallucination validation: validateExtraction runs after Scribe completes and rejects groundedness failures"
  - "Budget-aware injection: replace hardcoded slice() with priority-sorted, character-budgeted selection"

requirements-completed: ["SDK-QUAL-02", "SDK-QUAL-04"]

# Metrics
duration: 9min
completed: 2026-04-17
---

# Phase 00a Plan 03: Improve Quality and Reliability of Principle Extraction and Application Summary

Hallucination detection via keyword-overlap evidence validation in Trinity chain and budget-aware principle injection with P0>P1>P2 priority ordering replacing hardcoded slice().

## Performance

- **Duration:** 9 min
- **Started:** 2026-04-17T00:22:20Z
- **Completed:** 2026-04-17T00:31:45Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments
- Hallucination detection validates Scribe extractions against session snapshot evidence (tool failures, pain events, gate blocks, user corrections)
- Budget-aware principle selection replaces hardcoded slice(-3)/slice(0,5) with 4000-char budget respecting P0>P1>P2 priority
- Both stub and real runtime Trinity paths enforce hallucination detection before returning artifacts
- InjectablePrinciple interface bridges two incompatible Principle types across the codebase

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement hallucination detection** - `cb8165c0` (feat)
2. **Task 2: Create principle-injection.ts and update prompt.ts** - `81e6a810` (feat)

## Files Created/Modified
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` - Added validateExtraction() with HallucinationDetectionResult, integrated into both Trinity execution paths
- `packages/openclaw-plugin/src/core/principle-injection.ts` - New module with selectPrinciplesForInjection(), formatPrinciple(), InjectablePrinciple interface
- `packages/openclaw-plugin/src/hooks/prompt.ts` - Updated evolution principles injection to use budget-aware selection
- `packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts` - 10 new tests for validateExtraction (102 total pass)
- `packages/openclaw-plugin/tests/core/principle-injection.test.ts` - 12 new tests for principle injection

## Decisions Made
- **Keyword-overlap heuristic over LLM-based validation:** validateExtraction uses token matching between badDecision text and snapshot evidence tokens (tool names, file paths, error messages, pain reasons). Avoids an extra LLM call for validation while catching the most common hallucination pattern (fabricated events not in the session).
- **P0 force-include over budget:** Critical (P0) principles are always included even if they exceed the character budget, because they represent safety-critical rules that must be injected.
- **Duck-typed InjectablePrinciple:** The codebase has two incompatible Principle types (evolution-types.ts vs principle-tree-schema.ts). Rather than forcing a unified type, InjectablePrinciple defines the minimal shape needed (id, text, priority?, createdAt) and both types satisfy it structurally.
- **4000-char active / 1000-char probation budget:** Active principles get the primary budget; probation principles get a smaller sub-budget since they are contextual and lower confidence.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] InjectablePrinciple interface for type compatibility**
- **Found during:** Task 2 (principle-injection.ts integration with prompt.ts)
- **Issue:** evolution-reducer returns evolution-types.Principle (priority optional, different shape) which is incompatible with principle-tree-schema.Principle (priority required, many more fields). Direct import caused TS2345 errors.
- **Fix:** Created InjectablePrinciple duck-typed interface with only the 4 required fields (id, text, priority?, createdAt). Made priority optional with P1 default to match evolution-types.Principle.priority?: 'P0' | 'P1' | 'P2'.
- **Files modified:** principle-injection.ts, principle-injection.test.ts
- **Verification:** tsc --noEmit passes, all 114 tests pass

---

**Total deviations:** 1 auto-fixed (1 blocking type compatibility)
**Impact on plan:** Necessary for type safety. No scope creep.

## Issues Encountered
- Test "provides evidence preview for telemetry" initially failed because the badDecision text had insufficient keyword overlap with snapshot evidence tokens after stop-word filtering. Fixed by using more specific overlapping text in the test.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Hallucination detection ready for production use in nocturnal pipeline
- Budget-aware injection ready to replace hardcoded slicing in prompt hook
- Both features are backward compatible (existing behavior preserved when budget is large enough)

---
*Phase: 00a-interface-core*
*Completed: 2026-04-17*

## Self-Check: PASSED

- [x] `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` exists
- [x] `packages/openclaw-plugin/src/core/principle-injection.ts` exists
- [x] `packages/openclaw-plugin/src/hooks/prompt.ts` exists
- [x] `packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts` exists
- [x] `packages/openclaw-plugin/tests/core/principle-injection.test.ts` exists
- [x] `.planning/phases/00a-interface-core/00a-03-SUMMARY.md` exists
- [x] Commit `cb8165c0` found in git log
- [x] Commit `81e6a810` found in git log
- [x] TypeScript compilation passes (tsc --noEmit)
- [x] 102/102 nocturnal-trinity tests passing
- [x] 12/12 principle-injection tests passing
