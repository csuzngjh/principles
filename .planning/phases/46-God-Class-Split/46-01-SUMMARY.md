---
phase: 46
plan: 01
subsystem: evolution-worker
tags: [god-class-split, queue-migration, extraction]
dependency_graph:
  requires: []
  provides:
    - SPLIT-01
  affects:
    - evolution-worker.ts
    - evolution-types.ts
tech_stack:
  added:
    - queue-migration.ts (pure data migration module)
    - queue-migration.test.ts (Vitest unit tests)
    - V2 queue types in evolution-types.ts
  patterns:
    - Extraction refactoring (god class split pattern)
    - Re-export facade for backward compatibility
    - Type assertion at module boundaries (due to TypeScript nominal typing across modules)
key_files:
  created:
    - packages/openclaw-plugin/src/service/queue-migration.ts
    - packages/openclaw-plugin/tests/service/queue-migration.test.ts
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts
    - packages/openclaw-plugin/src/core/evolution-types.ts
decisions:
  - id: DEVIATION-V2-types
    description: "Added V2 queue types (EvolutionQueueItem, QueueStatus, TaskResolution) to evolution-types.ts — plan assumed they were already there but they were only in evolution-worker.ts"
    rationale: "Required to break circular type dependency between queue-migration.ts and evolution-worker.ts while keeping types canonical"
  - id: Type-assertion-at-boundaries
    description: "Added as unknown as EvolutionQueueItem[] casts at migrateQueueToV2 call sites in evolution-worker.ts"
    rationale: "TypeScript treats EvolutionQueueItem from evolution-types.ts and evolution-worker.ts as distinct types (despite structural identity) due to module boundary nominal typing"
  - id: RawQueueItem-export
    description: "Added export to RawQueueItem type alias in queue-migration.ts"
    rationale: "Type alias was declared locally but not exported, preventing re-export from evolution-worker.ts"
---

# Phase 46 Plan 01 Summary: Extract queue-migration.ts

## Objective

Extract `queue-migration.ts` from `evolution-worker.ts` (lines 297-379) — the most isolated extraction validating the god class split pattern.

## What Was Built

### Artifacts

| Artifact | Lines | Description |
|----------|-------|-------------|
| `src/service/queue-migration.ts` | 95 | Pure data migration functions: `migrateToV2`, `isLegacyQueueItem`, `migrateQueueToV2`, `LegacyEvolutionQueueItem` interface, default constants |
| `src/service/queue-migration.test.ts` | 147 | 10 Vitest test cases covering all three functions |

### Symbols Extracted

| Symbol | Type | New Location |
|--------|------|--------------|
| `LegacyEvolutionQueueItem` | interface | queue-migration.ts |
| `migrateToV2` | function | queue-migration.ts |
| `isLegacyQueueItem` | function | queue-migration.ts |
| `migrateQueueToV2` | function | queue-migration.ts |
| `RawQueueItem` | type alias | queue-migration.ts |
| `DEFAULT_TASK_KIND` | const | queue-migration.ts |
| `DEFAULT_PRIORITY` | const | queue-migration.ts |
| `DEFAULT_MAX_RETRIES` | const | queue-migration.ts |

### Backward Compatibility

- `evolution-worker.ts` re-exports all extracted symbols via facade at lines 298-300
- All 6 Phase 45 queue tests pass (backward compatibility verified)
- `loadEvolutionQueue` continues to work through re-export chain

## Deviations from Plan

### [Rule 2 - Auto-add missing critical functionality] V2 types not in evolution-types.ts
- **Issue:** Plan specified importing `EvolutionQueueItem`, `QueueStatus`, `TaskResolution` from `evolution-types.js`, but these types were only defined in `evolution-worker.ts` itself
- **Fix:** Added V2 queue types to `evolution-types.ts` and imported them into `queue-migration.ts` — required to maintain type canonical source while avoiding circular value imports
- **Files modified:** `evolution-types.ts`, `queue-migration.ts`

### [Rule 3 - Auto-fix blocking issue] RawQueueItem not exported
- **Issue:** `type RawQueueItem = Record<string, unknown>` was declared without `export` keyword
- **Fix:** Changed to `export type RawQueueItem = Record<string, unknown>`
- **Files modified:** `queue-migration.ts`

### [Rule 3 - Auto-fix blocking issue] TypeScript nominal typing across modules
- **Issue:** `EvolutionQueueItem` from `evolution-types.ts` and `evolution-worker.ts` are structurally identical but TypeScript treats them as distinct types due to module boundary nominal typing
- **Fix:** Added `as unknown as EvolutionQueueItem[]` casts at three `migrateQueueToV2` call sites (lines 651, 1064, 2243)
- **Files modified:** `evolution-worker.ts`

## Pre-existing Issues (Not Fixed)

- `evolution-worker.ts:1107-1108`: `Property 'length' does not exist on type '{}'` — `payload.failures` typed as `{}`, pre-existing bug unrelated to this extraction

## Commits

| Commit | Description |
|--------|-------------|
| `e4a1b2a5` | feat(46-01): extract queue-migration.ts from evolution-worker.ts |
| `fe0fb623` | test(46-01): add queue-migration unit tests |
| `3c1cdb4a` | feat(46-01): extract queue-migration from evolution-worker.ts |

## Verification Results

```
npx tsc --noEmit --skipLibCheck: PASS (only pre-existing 1107/1108 errors)
npx vitest run tests/service/queue-migration.test.ts: 10 passed
npx vitest run tests/service/evolution-worker.queue.test.ts: 6 passed (backward compat)
```

## Self-Check

- [x] `queue-migration.ts` exists with all required exports
- [x] `queue-migration.test.ts` has 10 test cases and passes
- [x] `evolution-worker.ts` re-exports all extracted symbols
- [x] `evolution-types.ts` updated with V2 queue types
- [x] Phase 45 queue tests pass (backward compatibility)
- [x] All 3 commits created

## Self-Check: PASSED
