---
phase: "45"
plan: "01"
subsystem: "queue-tests"
tags: [migrateToV2, legacy-queue, integration-tests, backward-compatibility]
dependency_graph:
  requires: []
  provides:
    - id: "QTEST-01"
      artifact: "packages/openclaw-plugin/tests/fixtures/legacy-queue-v1.json"
      exports: ["legacy queue items without taskKind field"]
    - id: "QTEST-02"
      artifact: "packages/openclaw-plugin/tests/core/evolution-migration.test.ts"
      exports: ["migrateToV2 integration tests, queue state transition tests"]
  affects:
    - "evolution-worker.ts"
    - "evolution-migration.test.ts"
tech_stack:
  added: [vi.useFakeTimers, os.tmpdir, fs.mkdtempSync]
  patterns: [legacy -> V2 migration, explicit expect assertions, temp file isolation]
key_files:
  created:
    - "packages/openclaw-plugin/tests/fixtures/legacy-queue-v1.json"
  modified:
    - "packages/openclaw-plugin/src/service/evolution-worker.ts"
    - "packages/openclaw-plugin/tests/core/evolution-migration.test.ts"
decisions:
  - id: "QTEST-D1"
    summary: "Exported migrateToV2, isLegacyQueueItem, migrateQueueToV2, loadEvolutionQueue, and LegacyEvolutionQueueItem from evolution-worker.ts to enable unit testing — Rule 3 auto-fix for blocking issue"
  - id: "QTEST-D2"
    summary: "All 14 tests pass with vi.useFakeTimers()/vi.useRealTimers() per project standard (D-10)"
  - id: "QTEST-D3"
    summary: "All assertions are explicit expect() with input/expected pairs — no toMatchInlineSnapshot or toMatchSnapshot (D-07, D-08)"
metrics:
  duration: "10 minutes"
  completed: "2026-04-15"
---

# Phase 45 Plan 01: Queue Migration Integration Tests Summary

## One-liner
Added migrateToV2 integration tests and queue state transition tests using legacy-queue-v1.json fixture, with all internal migration functions exported for testing.

## Completed Tasks

| Task | Name | Commit | Files |
|------|------|--------|-------|
| QTEST-01 | legacy-queue-v1.json fixture | `7b7b3e60` | `tests/fixtures/legacy-queue-v1.json` |
| QTEST-02 | migrateToV2 integration tests | `7b7b3e60` | `evolution-migration.test.ts` |
| QTEST-03 | queue state transition tests | `7b7b3e60` | `evolution-migration.test.ts` |

## What Was Built

### QTEST-01: legacy-queue-v1.json Fixture
Created `tests/fixtures/legacy-queue-v1.json` with 4 legacy queue items representing pre-V2 production data:
- `legacy-pain-001` — pending item (no started_at, completed_at)
- `legacy-pain-002` — in_progress item (has started_at, assigned_session_key, session_id)
- `legacy-pain-003` — completed item (has all timestamps and resolution)
- `legacy-pain-004` — failed item (for deduplication/testing failed state)

All items lack `taskKind`, `priority`, `retryCount`, `maxRetries`, and `lastError` fields — the exact shape that requires migration.

### QTEST-02: migrateToV2 Integration Tests
Extended `evolution-migration.test.ts` with 5 new tests in a `describe('migrateToV2')` block:
1. **DEFAULT_TASK_KIND applied** — verifies `pain_diagnosis` is assigned when `taskKind` is absent
2. **DEFAULT_PRIORITY applied** — verifies `medium` is assigned when `priority` is absent
3. **Original fields preserved** — full round-trip verification of all 17 fields
4. **Mixed legacy/V2 queue** — legacy items migrated, V2 items passed through unchanged
5. **isLegacyQueueItem predicate** — true for item without taskKind, false for item with taskKind

### QTEST-03: Queue State Transition Tests
Added `describe('Queue migration state transitions')` block with 7 tests covering the full `loadEvolutionQueue` pipeline:
1. **pending -> V2** — legacy pending item migrates with `status: 'pending'`
2. **in_progress -> V2** — legacy in_progress item migrates with `status: 'in_progress'`
3. **completed -> V2** — legacy completed item migrates with `status: 'completed'` and resolution preserved
4. **failed -> V2** — legacy failed item migrates with `status: 'failed'` and `failed_max_retries` resolution
5. **Missing optional fields** — minimal legacy item migrates with V2 defaults but undefined optional fields retained
6. **Empty queue** — `[]` file returns `[]`
7. **Corrupted JSON** — invalid JSON returns `[]` (graceful error handling)

### Deviations from Plan

**Rule 3 Auto-fix: Export internal functions for testing**
The plan did not account for `migrateToV2`, `isLegacyQueueItem`, `migrateQueueToV2`, `loadEvolutionQueue`, and `LegacyEvolutionQueueItem` being internal (non-exported). To enable testing per the plan's success criteria, these were exported from `evolution-worker.ts`. This is a necessary implementation change to fulfill the testing requirement.

**None** — all 3 tasks implemented as specified, with the above auto-fix applied.

## Known Stubs

**None** — all implementations are fully wired test coverage, no stubs.

## Threat Surface Scan

| Flag | File | Description |
|------|------|-------------|
| none | evolution-worker.ts | Only added `export` keywords — no behavioral change to migration logic |

## Test Verification

```
npm test -- tests/core/evolution-migration.test.ts

 RUN  v4.1.4 D:/Code/principles/packages/openclaw-plugin
 Test Files  1 passed (1)
      Tests  14 passed (14)
```

## Self-Check: PASSED

- [x] `legacy-queue-v1.json` created with 4 items, none having `taskKind`
- [x] `migrateToV2` integration tests cover DEFAULT_TASK_KIND, DEFAULT_PRIORITY, field preservation, mixed queue, and `isLegacyQueueItem`
- [x] Queue state transition tests cover pending, in_progress, completed, failed, missing fields, empty queue, corrupted JSON
- [x] All tests use `vi.useFakeTimers()` in `beforeEach`, `vi.useRealTimers()` in `afterEach`
- [x] All tests use `os.tmpdir()` + `fs.mkdtempSync()` for temp file isolation
- [x] All assertions are explicit `expect()` with input/expected pairs (no snapshots)
- [x] Commit `7b7b3e60` exists with all 3 files
