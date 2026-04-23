---
phase: m3-02-BoundedHistoryQuery
plan: 01
subsystem: database
tags: [sqlite, history-query, cursor-pagination, typebox, better-sqlite3]

# Dependency graph
requires:
  - phase: m2-task-run-state-core
    provides: "SqliteConnection, runs table schema, idx_runs_task_id, idx_runs_started_at indexes"
  - phase: m3-01-TrajectoryLocator
    provides: "TrajectoryLocator interface and pattern reference"
provides:
  - "HistoryQuery abstract interface with query(trajectoryRef, cursor?, options?) method"
  - "HistoryQueryCursorData for opaque cursor internal structure"
  - "HistoryQueryOptions for limit and time window customization"
  - "SqliteHistoryQuery with keyset cursor pagination and time window support"
  - "Constants: DEFAULT_HISTORY_PAGE_SIZE=50, MAX_HISTORY_PAGE_SIZE=200, DEFAULT_TIME_WINDOW_MS=86400000"
  - "Comprehensive test suite (19 tests)"
affects: [m3-03, m3-04, m3-05]

# Tech tracking
tech-stack:
  added: []
  patterns: ["keyset cursor pagination (started_at + run_id)", "entry-limit-to-run-limit conversion (ceil(entries/2))"]

key-files:
  created:
    - packages/principles-core/src/runtime-v2/store/history-query.ts
    - packages/principles-core/src/runtime-v2/store/sqlite-history-query.ts
    - packages/principles-core/src/runtime-v2/store/sqlite-history-query.test.ts
  modified:
    - packages/principles-core/src/runtime-v2/context-payload.ts
    - packages/principles-core/src/runtime-v2/index.ts

key-decisions:
  - "Limit semantics: limit controls entries count, not runs count. SQL fetches ceil(entries/2)+1 runs to fill entry pages and detect truncation."
  - "Error category: used 'input_invalid' (not 'invalid_input') to match PDErrorCategory union type"
  - "Static methods for pure functions: decodeCursor, buildCursor, mapRunToEntries are static to satisfy class-methods-use-this lint"
  - "QueryParams interface group to satisfy max-params lint (max 3 parameters per method)"

patterns-established:
  - "Entry-limit-to-run-limit conversion: ceil(entryLimit/2) + 1 for SQL LIMIT, then slice entries to exact limit"
  - "QueryParams/CursorQueryParams interfaces for parameter grouping"

requirements-completed: [RET-04, RET-05, RET-06]

# Metrics
duration: 11min
completed: 2026-04-22
---

# Phase m3-02: Bounded History Query Summary

**HistoryQuery interface + SqliteHistoryQuery with keyset cursor pagination, time-window scoping, and 19 passing tests**

## Performance

- **Duration:** 11 min
- **Started:** 2026-04-22T11:57:07Z
- **Completed:** 2026-04-22T12:08:39Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- HistoryQuery abstract interface with query(trajectoryRef, cursor?, options?) method
- HistoryQueryCursorData and HistoryQueryOptions types with constants
- SqliteHistoryQuery with keyset cursor pagination (started_at + run_id)
- Time window filter with default 24h lookback and custom overrides
- Entry-limit semantics: limit controls entries, SQL fetches ceil(entries/2)+1 runs
- Each RunRecord maps to 2 HistoryQueryEntry items (system + assistant roles)
- 19 tests covering all behaviors including cursor roundtrip, error cases, schema validation
- All SQL uses parameterized queries, validated by TypeBox Value.Check before return

## Task Commits

Each task was committed atomically:

1. **Task 1: Define HistoryQuery interface + cursor/options types** - `e40d3648` (feat)
2. **Task 2: Implement SqliteHistoryQuery with cursor pagination** - `951588a5` (feat)
3. **Task 3: Write comprehensive test suite** - `4f40cb1c` (test)

## Files Created/Modified
- `packages/principles-core/src/runtime-v2/store/history-query.ts` - HistoryQuery interface, HistoryQueryCursorData, HistoryQueryOptions, constants
- `packages/principles-core/src/runtime-v2/store/sqlite-history-query.ts` - SqliteHistoryQuery with cursor pagination and time windows
- `packages/principles-core/src/runtime-v2/store/sqlite-history-query.test.ts` - 19 test cases
- `packages/principles-core/src/runtime-v2/context-payload.ts` - Added nextCursor optional field to HistoryQueryResultSchema
- `packages/principles-core/src/runtime-v2/index.ts` - Added SqliteHistoryQuery, HistoryQuery types, constants exports

## Decisions Made
- **Limit controls entries, not runs**: The `limit` option in HistoryQueryOptions controls the number of HistoryQueryEntry items returned, not the number of runs. Since each run produces 2 entries, the SQL LIMIT is computed as `ceil(entryLimit/2) + 1` (extra run for truncation detection). Entries are then sliced to the exact limit.
- **Error category `input_invalid`**: Plan used `invalid_input` but PDErrorCategory union type defines `input_invalid`. Used the correct enum value.
- **Static methods for pure functions**: `decodeCursor`, `buildCursor`, and `mapRunToEntries` are static methods since they don't use `this`. Satisfies `class-methods-use-this` lint rule.
- **QueryParams interface for parameter grouping**: Used `QueryParams` and `CursorQueryParams` interfaces instead of 4-5 method parameters. Satisfies `max-params` lint rule.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed error category name: invalid_input -> input_invalid**
- **Found during:** Task 2 (TypeScript compilation)
- **Issue:** Plan specified `PDRuntimeError('invalid_input')` but PDErrorCategory has `input_invalid`, not `invalid_input`
- **Fix:** Changed all 4 occurrences to use `'input_invalid'`
- **Files modified:** packages/principles-core/src/runtime-v2/store/sqlite-history-query.ts
- **Committed in:** 951588a5 (Task 2 commit)

**2. [Rule 3 - Blocking] Refactored to satisfy 5 lint errors**
- **Found during:** Task 2 (commit rejected by lint)
- **Issue:** `init-declarations` (let nextCursor), `max-params` (4-5 params), `class-methods-use-this` (2 methods)
- **Fix:** Used const ternary for nextCursor, QueryParams/CursorQueryParams interfaces for param grouping, static methods for pure functions
- **Files modified:** packages/principles-core/src/runtime-v2/store/sqlite-history-query.ts
- **Committed in:** 951588a5 (Task 2 commit)

**3. [Rule 1 - Bug] Fixed limit semantics: entries vs runs**
- **Found during:** Task 3 (test failures)
- **Issue:** `effectiveLimit` was used directly as SQL LIMIT on runs, but plan specifies limit controls entries count. 5 runs with limit=4 returned 8 entries instead of 4.
- **Fix:** Changed SQL LIMIT to `ceil(entryLimit/2) + 1`, then slice entries array to exact limit. Truncation detection based on entries count.
- **Files modified:** packages/principles-core/src/runtime-v2/store/sqlite-history-query.ts
- **Committed in:** 4f40cb1c (Task 3 commit)

**4. [Rule 1 - Bug] Fixed executionStatus test value: 'completed' -> 'succeeded'**
- **Found during:** Task 3 (test failures - RunRecordSchema validation)
- **Issue:** Test used `executionStatus: 'completed'` but RunExecutionStatusSchema allows `succeeded`, not `completed`
- **Fix:** Changed default executionStatus in test helper to `'succeeded'`
- **Files modified:** packages/principles-core/src/runtime-v2/store/sqlite-history-query.test.ts
- **Committed in:** 4f40cb1c (Task 3 commit)

**5. [Rule 3 - Blocking] Fixed test lint errors: unused imports, prefer-destructuring**
- **Found during:** Task 3 (commit rejected by lint)
- **Issue:** Unused imports DEFAULT_HISTORY_PAGE_SIZE/MAX_HISTORY_PAGE_SIZE, prefer-destructuring on array index access
- **Fix:** Removed unused imports, changed `const x = arr[0]` to `const [x] = arr` and `const x = arr[1]` to `const [, x] = arr`
- **Files modified:** packages/principles-core/src/runtime-v2/store/sqlite-history-query.test.ts
- **Committed in:** 4f40cb1c (Task 3 commit)

---

**Total deviations:** 5 auto-fixed (2 bugs, 3 blocking)
**Impact on plan:** All auto-fixes necessary for correctness and lint compliance. No scope creep.

## Issues Encountered
None beyond lint and type-safety deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- HistoryQuery interface ready for consumption by m3-03 (Context Assembly), m3-04 (Degradation)
- SqliteHistoryQuery handles cursor pagination with keyset pattern, time window filtering
- Test suite validates correctness of all behaviors including edge cases

## Self-Check: PASSED

- All 5 created/modified files exist on disk
- All 3 task commits found in git history (e40d3648, 951588a5, 4f40cb1c)
- 19/19 tests passing
- TypeScript compiles cleanly for principles-core/runtime-v2
- No OpenClaw imports in new files
- No LLM calls in new files
- All SQL uses parameterized queries

---
*Phase: m3-02-BoundedHistoryQuery*
*Completed: 2026-04-22*
