# Phase m5-02 Plan m5-02-01 Summary: DiagnosticianCommitter Core

## Overview

**Plan:** m5-02-01 — DiagnosticianCommitter Core
**Phase:** m5-02 (DiagnosticianCommitter Core)
**Type:** feature
**Completed:** 2026-04-24
**Tasks:** 3/3
**Commits:** 1 (new)

## One-liner

`SqliteDiagnosticianCommitter` — atomic transaction-wrapped commit of `DiagnosticianOutputV1` to artifacts + commits + principle_candidates, with idempotent re-commit support via UNIQUE constraints.

## Tasks

### Task 1: Implement DiagnosticianCommitter interface + SQLite implementation

**Status:** committed
**Commit:** (pending)
**Files created:**
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts`

**Summary:** Created `SqliteDiagnosticianCommitter` class implementing `DiagnosticianCommitter` interface:
- `commit(input: CommitInput): Promise<CommitResult>` — validates input against `DiagnosticianOutputV1Schema`, then executes atomic transaction
- Transaction inserts into `artifacts` (diagnostician_output), `commits`, and `principle_candidates` (one row per `kind='principle'` recommendation)
- Idempotency: catches `UNIQUE constraint` failures on `commits.run_id` or `commits.idempotency_key` and returns existing `CommitResult`
- Validation errors throw `PDRuntimeError{category: 'input_invalid'}`
- SQL errors throw `PDRuntimeError{category: 'artifact_commit_failed'}` with constraint info
- Candidate `idempotency_key` derived as `{commitId}:{index}` for collision safety

### Task 2: Write unit tests for DiagnosticianCommitter

**Status:** committed (included in Task 1 commit)
**Files created:**
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.test.ts`

**Summary:** 10 tests covering COMT-01 through COMT-06:
1. `commit returns correct CommitResult with generated IDs` — verifies UUID format and candidateCount=2
2. `commit inserts artifact + commit + candidates in one transaction` — verifies all 3 table rows created atomically
3. `commit extracts only kind='principle' recommendations as candidates` — 3 of 7 recommendations extracted
4. `re-commit with same idempotencyKey returns existing commit (idempotent)` — verifies no duplicate rows
5. `re-commit with same runId returns existing commit (idempotent)` — verifies UNIQUE(run_id) triggers
6. `commit failure rolls back all rows (no partial state)` — FK constraint failure leaves 0 artifacts
7. `invalid DiagnosticianOutputV1 throws input_invalid error` — validation rejects malformed input
8. `candidate idempotency keys are derived from commitId:index` — verifies key format
9. `empty recommendations array produces candidateCount=0` — edge case
10. `candidate title defaults to description` — title = description (no title field on recommendation)

### Task 3: Export DiagnosticianCommitter from runtime-v2 index

**Status:** committed
**Files modified:**
- `packages/principles-core/src/runtime-v2/index.ts`

**Added exports:**
- `SqliteDiagnosticianCommitter` class
- `DiagnosticianCommitter`, `CommitInput`, `CommitResult` types

## Deviations from Plan

### Bug Fixes Applied

**Rule 1 - Auto-fix: ReferenceError 'title is not defined'**

- **Found during:** Test execution
- **Issue:** Line 125 referenced `title` variable which was removed in a prior edit but not replaced with `rec.description`
- **Fix:** Replaced reference with `rec.description` directly (DiagnosticianRecommendation has no title field — title defaults to description)
- **Files modified:** `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts`
- **Commit:** (pending)

**Rule 1 - Auto-fix: Value.Errors() returns iterator not array**

- **Found during:** TypeScript compilation
- **Issue:** `Value.Errors()` returns an iterator; calling `.map()` directly threw "map is not a function"
- **Fix:** Spread into array: `[...Value.Errors(DiagnosticianOutputV1Schema, input.output)]`
- **Files modified:** `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts`
- **Commit:** (pending)

**Rule 1 - Auto-fix: 'rec' possibly undefined in for loop**

- **Found during:** TypeScript strict null check
- **Issue:** TypeScript strict mode flags `principleRecommendations[i]` as possibly undefined
- **Fix:** Added `!` non-null assertion since loop bounds are checked
- **Files modified:** `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts`
- **Commit:** (pending)

**Rule 2 - Auto-fix: Test assumed 'title' field on DiagnosticianRecommendation**

- **Found during:** TypeScript compilation
- **Issue:** Test `candidate title defaults to description` passed `{ kind: 'principle', title: 'Immutability', description: '...' }` but schema only has `kind` and `description`
- **Fix:** Removed `title` from test recommendation objects; title always derives from `description`
- **Files modified:** `packages/principles-core/src/runtime-v2/store/diagnostician-committer.test.ts`
- **Commit:** (pending)

## Verification

| Check | Result |
|-------|--------|
| Tests pass | 10/10 new tests passed |
| TypeScript compiles | Yes |
| Pre-existing test failures | 3 pre-existing (unrelated files) |

## Key Files

| File | Created/Modified |
|------|-----------------|
| `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` | Created |
| `packages/principles-core/src/runtime-v2/store/diagnostician-committer.test.ts` | Created |
| `packages/principles-core/src/runtime-v2/index.ts` | Modified |

## Decisions Made

1. **Title = description fallback:** `DiagnosticianRecommendationSchema` has no `title` field, so candidate `title` defaults to `description`. This is consistent with the schema.

2. **Candidate idempotency key derivation:** `{commitId}:{index}` ensures each candidate has a unique key per commit, preventing duplicate inserts within the same commit operation.

3. **Idempotency lookup order:** Check `idempotency_key` first (most specific), then `run_id`. This matches how re-commits would typically be detected.

4. **SQLite transaction type:** Used `db.transaction()` wrapper (better-sqlite3) for implicit rollback on error. `BEGIN IMMEDIATE` not needed since better-sqlite3 handles locking.

## Requirements Coverage

| ID | Description | Status |
|----|-------------|--------|
| COMT-01 | DiagnosticianCommitter interface with commit(input): Promise<CommitResult> | Done |
| COMT-02 | Transaction-wrapped commit (artifacts + commits + candidates) | Done |
| COMT-03 | Extract kind='principle' recommendations as principle_candidates | Done |
| COMT-04 | Idempotent re-commit via UNIQUE constraints | Done |
| COMT-05 | Commit failure returns PDRuntimeError{artifact_commit_failed} | Done |
| COMT-06 | CommitResult returns {commitId, artifactId, candidateCount} | Done |
