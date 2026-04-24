# Phase m5-01 Plan m5-01-01 Summary: DDL for Artifact Registry Schema

## Overview

**Plan:** m5-01-01 — Artifact Registry Schema DDL
**Phase:** m5-01 (Artifact Registry Schema)
**Type:** feature
**Completed:** 2026-04-24
**Tasks:** 2/2
**Commits:** 1 (f88e9de2)

## One-liner

DDL for 3 tables (artifacts, commits, principle_candidates) with 7 FKs, 3 UNIQUE constraints, and 8 indexes, plus 12 schema conformance tests.

## Tasks

### Task 1: Add DDL for artifacts, commits, and principle_candidates tables

**Status:** committed
**Commit:** f88e9de2
**Files modified:**
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts`

**Summary:** Added `initSchema()` DDL blocks for three new tables:
- `artifacts`: stores committed diagnostician output with `run_id` FK to runs
- `commits`: atomic commit records linking run to artifact with `UNIQUE(run_id)` and `UNIQUE(idempotency_key)`
- `principle_candidates`: extracted principle recommendations with CASCADE FKs to artifacts, tasks, and runs

8 indexes created across the 3 tables (`idx_artifacts_task_id`, `idx_artifacts_run_id`, `idx_artifacts_artifact_kind`, `idx_commits_task_id`, `idx_commits_artifact_id`, `idx_candidates_status`, `idx_candidates_source_run_id`, `idx_candidates_task_id`).

### Task 2: Write 12 schema conformance tests

**Status:** committed (included in Task 1 commit)
**Files modified:**
- `packages/principles-core/src/runtime-v2/store/schema-conformance.test.ts`

**Summary:** Added `ArtifactRegistrySchema` test suite with 12 tests:
1. `artifacts table created with correct columns`
2. `commits table created with correct columns`
3. `principle_candidates table created with correct columns`
4. `all three tables created idempotently on re-open`
5. `all 8 indexes exist`
6. `deleting run cascades to artifacts, commits, and candidates`
7. `deleting task cascades to commits and candidates`
8. `deleting artifact cascades to commits and candidates`
9. `commits.run_id UNIQUE constraint prevents duplicate`
10. `commits.idempotency_key UNIQUE constraint prevents duplicate`
11. `principle_candidates.idempotency_key UNIQUE constraint prevents duplicate`
12. `existing tasks and runs tables unaffected`

## Deviations from Plan

### Bug Fixes Applied

**Rule 1 - Auto-fix: FK constraint mismatch in test data**

- **Found during:** Task 2 (test execution)
- **Issue:** Two tests failed with `FOREIGN KEY constraint failed` — the tests used mismatched IDs between the helper function output (`r-${suffix}`) and the manually inserted commit/candidate rows (`t-cascade-art` vs `t-cascade-artifact`)
- **Fix:**
  - `deleting artifact cascades to commits and candidates`: Fixed task_id/run_id/artifact_id references to use `cascade-artifact` suffix to match the insertTestChain helper output (`r-cascade-artifact` NOT `r-cascade-art`)
  - `commits.idempotency_key UNIQUE constraint`: Fixed run_id to `r-unique-ik` (matching insertTestChain) instead of `r-unique-ik-1`
- **Files modified:** `packages/principles-core/src/runtime-v2/store/schema-conformance.test.ts`
- **Commit:** f88e9de2

**Rule 2 - Auto-fix: Missing Database type import**

- **Found during:** TypeScript compilation check
- **Issue:** `insertTestChain` helper function used `Database.Database` as type annotation but `Database` was not imported
- **Fix:** Added `import type Database from 'better-sqlite3'` at top of test file
- **Commit:** f88e9de2

**Rule 3 - Auto-fix: Non-async insertTestChain helper**

- **Found during:** Test failure analysis
- **Issue:** `insertTestChain` was synchronous but called `taskStore.createTask()` and `runStore.createRun()` which are async methods. This caused the artifact to be inserted before the task/run actually existed in the DB.
- **Fix:** Made `insertTestChain` an `async` function with `await` for the store calls. Updated all 6 test functions that use it to `async` and `await` it.
- **Commit:** f88e9de2

## Verification

| Check | Result |
|-------|--------|
| Tests pass | 23/23 passed |
| TypeScript compiles | Yes |
| Pre-commit lint | Passed |

## Key Files

| File | Created/Modified |
|------|-----------------|
| `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` | Modified |
| `packages/principles-core/src/runtime-v2/store/schema-conformance.test.ts` | Modified |

## Decisions Made

1. **DDL insertion order:** artifacts (first), commits (second), principle_candidates (third) — matches dependency chain where commits references artifacts, and principle_candidates references both

2. **No FK from artifacts.task_id to tasks(task_id):** Schema spec only defines `artifacts.run_id → runs(run_id)` — the task_id column exists for query convenience but has no FK constraint

3. **Used `CREATE TABLE IF NOT EXISTS`:** Ensures idempotent schema initialization for existing databases

4. **Foreign key chain for cascade tests:** insertTestChain helper creates complete chain (task → run → artifact) using async store methods before raw SQL insert of artifacts table
