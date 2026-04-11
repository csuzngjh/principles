---
phase: 24-queue-store-extraction
plan: 01
status: complete
started: 2026-04-11
completed: 2026-04-11
---

# Plan 01: EvolutionQueueStore Core — Summary

## Objective
Create the EvolutionQueueStore class with all queue persistence logic, schema validation (write and read), lock management, migration, and deduplication.

## What Was Built

### EvolutionQueueStore Class (593 lines)
- **Constructor:** Takes `workspaceDir`, resolves queue path via `resolvePdPath`
- **Lock management:** All public methods auto-acquire/release file lock via `withLockAsync`
- **withLock<T>():** Atomic multi-step operations within single lock scope
- **Schema validation:** Permissive write validation (required fields only) and read validation (migration/corruption detection)
- **V2 migration:** `isLegacyQueueItem()`, `migrateQueueToV2()` as private methods
- **Dedup helpers:** `findRecentDuplicate()`, `hasRecentDuplicate()`, `hasEquivalentPromotedRule()`, `normalizePainDedupKey()`
- **Queue ops:** `load()`, `save()`, `add()`, `update()`, `purge()`, `registerSession()`
- **Corruption handling:** Backs up corrupted file, returns structured `QueueLoadResult` with reasons

### Error Types
- `QueueCorruptionError extends PdError` — corrupted queue file on read
- `QueueValidationError extends PdError` — malformed item on write

### Test Suite (389 lines, 32 tests)
- Schema validation (write/read)
- Lock management (auto-acquire/release)
- V2 migration
- Dedup helpers
- Purge/cleanup
- Corruption handling
- registerSession

## Key Files

| File | Action | Lines |
|------|--------|-------|
| `packages/openclaw-plugin/src/service/evolution-queue-store.ts` | Created | 593 |
| `packages/openclaw-plugin/src/config/errors.ts` | Modified | +38 |
| `packages/openclaw-plugin/tests/service/evolution-queue-store.test.ts` | Created | 389 |

## Requirements Addressed
- DECOMP-01: Queue persistence extracted into dedicated module
- CONTRACT-01: Write validation rejects malformed items
- CONTRACT-02: Read validation detects migration/corruption
- CONTRACT-06: Lock management centralized in store

## Deviations
None — all decisions from CONTEXT.md honored.

## Self-Check: PASSED
- All 32 tests pass
- TypeScript compilation clean (tsc --noEmit)
- No new dependencies added
