---
phase: m3-01-TrajectoryLocator
plan: 01
subsystem: database
tags: [sqlite, trajectory-locator, retrieval, typebox, better-sqlite3]

# Dependency graph
requires:
  - phase: m2-task-run-state-core
    provides: "SqliteConnection, runs table schema, idx_runs_task_id, idx_runs_started_at, idx_runs_status indexes"
provides:
  - "TrajectoryLocator abstract interface"
  - "SqliteTrajectoryLocator with 6 locate modes (painId, taskId, runId, timeRange, sessionId+workspace, executionStatus)"
  - "Comprehensive test suite (17 tests)"
  - "executionStatus field added to TrajectoryLocateQuerySchema"
affects: [m3-02, m3-03, m3-04, m3-05]

# Tech tracking
tech-stack:
  added: []
  patterns: ["routeQuery pattern for multi-mode dispatch (avoids init-declarations lint)", "createFixture pattern for test isolation (avoids no-non-null-assertion lint)"]

key-files:
  created:
    - packages/principles-core/src/runtime-v2/store/trajectory-locator.ts
    - packages/principles-core/src/runtime-v2/store/sqlite-trajectory-locator.ts
    - packages/principles-core/src/runtime-v2/store/sqlite-trajectory-locator.test.ts
  modified:
    - packages/principles-core/src/runtime-v2/context-payload.ts
    - packages/principles-core/src/runtime-v2/index.ts

key-decisions:
  - "sessionId locate mode returns all trajectories in workspace DB with confidence=0.5 since sessionId is not a column in runs/tasks tables"
  - "executionStatus added as optional field to TrajectoryLocateQuerySchema (stretch mode using idx_runs_status)"
  - "Used routeQuery private method to avoid let-based variable initialization (satisfies init-declarations lint rule)"

patterns-established:
  - "Route-query pattern: private routeQuery() method with early returns instead of let-variable mutation"
  - "createFixture() test pattern: factory function returning typed fixture object to avoid no-non-null-assertion"

requirements-completed: [RET-01, RET-02, RET-03]

# Metrics
duration: 13min
completed: 2026-04-22
---

# Phase m3-01: TrajectoryLocator Summary

**TrajectoryLocator interface + SqliteTrajectoryLocator with 6 locate modes and 17 passing tests**

## Performance

- **Duration:** 13 min
- **Started:** 2026-04-22T10:34:53Z
- **Completed:** 2026-04-22T10:48:18Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- TrajectoryLocator abstract interface with single locate() method
- SqliteTrajectoryLocator implementing 6 locate modes with parameterized SQL queries
- 17 tests covering all modes, confidence levels, edge cases, and query echo
- All SQL uses parameterized queries, validated by TypeBox Value.Check before return

## Task Commits

Each task was committed atomically:

1. **Task 1: Define TrajectoryLocator interface** - `8b5a6619` (feat)
2. **Task 2: Implement SqliteTrajectoryLocator with 6 locate modes** - `a7507677` (feat)
3. **Task 3: Write comprehensive test suite** - `c8edda31` (test)

## Files Created/Modified
- `packages/principles-core/src/runtime-v2/store/trajectory-locator.ts` - TrajectoryLocator abstract interface
- `packages/principles-core/src/runtime-v2/store/sqlite-trajectory-locator.ts` - SqliteTrajectoryLocator implementation with 6 modes
- `packages/principles-core/src/runtime-v2/store/sqlite-trajectory-locator.test.ts` - 17 test cases
- `packages/principles-core/src/runtime-v2/context-payload.ts` - Added executionStatus optional field to TrajectoryLocateQuerySchema
- `packages/principles-core/src/runtime-v2/index.ts` - Added TrajectoryLocator type and SqliteTrajectoryLocator class exports

## Decisions Made
- **sessionId mode returns workspace-scoped results with confidence=0.5**: sessionId is NOT a column in runs or tasks tables. Since workspace isolation is achieved via SqliteConnection DB file path, the session hint mode returns all trajectories in the connected workspace DB. This is the correct behavior given M2 schema constraints.
- **executionStatus added to TrajectoryLocateQuerySchema**: The stretch mode required a new optional field in the query schema. Added as Optional String to maintain backward compatibility. Uses the existing idx_runs_status index.
- **routeQuery pattern for lint compliance**: Instead of `let result` with if/else assignment, used a private `routeQuery()` method with early returns. Avoids `init-declarations` lint error while keeping clean dispatch logic.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added executionStatus field to TrajectoryLocateQuerySchema**
- **Found during:** Task 2 (implementing locate modes)
- **Issue:** Plan specified executionStatus as a stretch mode but TrajectoryLocateQuerySchema had no executionStatus field
- **Fix:** Added `executionStatus: Type.Optional(Type.String({ minLength: 1 }))` to the schema
- **Files modified:** packages/principles-core/src/runtime-v2/context-payload.ts
- **Committed in:** a7507677 (Task 2 commit)

**2. [Rule 3 - Blocking] Refactored let-variable dispatch to satisfy init-declarations lint**
- **Found during:** Task 2 (commit rejected by lint)
- **Issue:** `let result: TrajectoryLocateResult` with if/else branches failed init-declarations ESLint rule
- **Fix:** Extracted private `routeQuery()` method with early returns, `locate()` calls it and validates the const result
- **Files modified:** packages/principles-core/src/runtime-v2/store/sqlite-trajectory-locator.ts
- **Committed in:** a7507677 (Task 2 commit)

**3. [Rule 3 - Blocking] Rewrote test file to satisfy no-non-null-assertion lint**
- **Found during:** Task 3 (commit rejected by lint)
- **Issue:** Test variables using `let` with `!` assertions (e.g., `taskStore!.createTask()`) violated no-non-null-assertion rule
- **Fix:** Replaced let+beforeEach pattern with `createFixture()` factory function returning a typed TestFixture object. Each test destructures from the factory call.
- **Files modified:** packages/principles-core/src/runtime-v2/store/sqlite-trajectory-locator.test.ts
- **Committed in:** c8edda31 (Task 3 commit)

---

**Total deviations:** 3 auto-fixed (1 missing critical, 2 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and lint compliance. No scope creep.

## Issues Encountered
None beyond lint-related deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- TrajectoryLocator interface ready for consumption by m3-02 (History Query), m3-03 (Context Assembly), m3-04 (Degradation)
- SqliteTrajectoryLocator handles all 6 locate modes with parameterized SQL
- Test suite validates correctness of all modes including edge cases

---
*Phase: m3-01-TrajectoryLocator*
*Completed: 2026-04-22*

## Self-Check: PASSED

- All 4 created/modified files exist on disk
- All 3 task commits found in git history (8b5a6619, a7507677, c8edda31)
- 17/17 tests passing
- TypeScript compiles cleanly for principles-core/runtime-v2
- No OpenClaw imports in new files
- No LLM calls in new files
- All SQL uses parameterized queries
