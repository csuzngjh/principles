---
phase: "10-fix-noc15-stub-params"
plan: "01"
subsystem: infra
tags: [typescript, interface-compliance, nocturnal-trinity, stub-fallback]

# Dependency graph
requires: []
provides:
  - StubFallbackRuntimeAdapter with correct TrinityRuntimeAdapter method signatures
  - TypeScript compilation passes for nocturnal-workflow-manager.ts and nocturnal-trinity.ts
affects: [NOC-15]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - TrinityRuntimeAdapter interface compliance via correct method signatures
    - Stub adapter uses passed parameters directly (D-01, D-02) rather than stored constructor values

key-files:
  created: []
  modified:
    - packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts
    - packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts

key-decisions:
  - "D-01: invokeDreamer accepts (snapshot, principleId, maxCandidates) — uses passed params directly"
  - "D-02: invokePhilosopher accepts (dreamerOutput, principleId) — uses both params directly"
  - "D-03: Removed unused private realAdapter from StubFallbackRuntimeAdapter constructor"
  - "D-04: Updated test mock vi.fn<> signatures to match TrinityRuntimeAdapter interface"
  - "D-05: Stub implementation logic unchanged — calls invokeStub* functions with correct arguments"
  - "D-06: Only fixed method signatures and removed dead code — no other changes"

patterns-established: []

requirements-completed:
  - "NOC-15"

# Metrics
duration: 5min
completed: 2026-04-06
---

# Phase 10-01: Fix NOC-15 Stub Params Summary

**StubFallbackRuntimeAdapter now implements TrinityRuntimeAdapter interface correctly with matching method signatures**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-06T04:13:00Z
- **Completed:** 2026-04-06T04:18:00Z
- **Tasks:** 1 (atomic commit)
- **Files modified:** 2

## Accomplishments
- Fixed StubFallbackRuntimeAdapter.invokeDreamer signature to accept 3 params (snapshot, principleId, maxCandidates) matching TrinityRuntimeAdapter
- Fixed StubFallbackRuntimeAdapter.invokePhilosopher signature to accept 2 params (dreamerOutput, principleId) matching TrinityRuntimeAdapter
- Removed unused `private realAdapter: TrinityRuntimeAdapter` from StubFallbackRuntimeAdapter constructor
- Updated both caller sites to pass correct arguments when invoking stub adapter methods
- Updated test mock signatures to use correct vi.fn<> type annotations matching TrinityRuntimeAdapter interface

## Task Commits

Each task was committed atomically:

1. **Task 1: Fix StubFallbackRuntimeAdapter signatures, remove dead code, update callers and test mocks** - `c7ffbcd` (fix)

**Plan metadata:** `93b3bc9` (docs: complete plan)

## Files Created/Modified
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` - Fixed StubFallbackRuntimeAdapter class with correct method signatures; updated both stub adapter instantiation and invokeDreamer/invokePhilosopher call sites
- `packages/openclaw-plugin/tests/service/nocturnal-workflow-manager.test.ts` - Updated createMockRuntimeAdapter vi.fn<> signatures to match TrinityRuntimeAdapter interface

## Decisions Made
- None - plan executed exactly as written

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- Pre-existing TypeScript errors in evolution-reducer.ts and prompt.ts (unrelated to this fix)
- Pre-existing test infrastructure issue with better-sqlite3 database connection in test suite (19/19 tests pass for nocturnal-workflow-manager; 1 unrelated failure in test runner)

## Verification Results

- **TypeScript compilation:** `npx tsc --noEmit` exits 0 for nocturnal-workflow-manager.ts and nocturnal-trinity.ts (no errors in these files)
- **Unit tests:** 19 passed, 1 todo in nocturnal-workflow-manager.test.ts
- **StubFallbackRuntimeAdapter.invokeDreamer:** accepts (snapshot: NocturnalSessionSnapshot, principleId: string, maxCandidates: number)
- **StubFallbackRuntimeAdapter.invokePhilosopher:** accepts (dreamerOutput: DreamerOutput, principleId: string)
- **Unused realAdapter field:** removed from constructor
- **Both caller sites:** pass correct arguments to stub adapter methods

## Next Phase Readiness
- NOC-15 interface compliance fixed and verified
- Ready for next wave 1 worktree agent or phase continuation

---
*Phase: 10-fix-noc15-stub-params-01*
*Completed: 2026-04-06*
