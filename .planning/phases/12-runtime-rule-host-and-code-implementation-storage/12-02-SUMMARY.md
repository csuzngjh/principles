---
phase: 12-runtime-rule-host-and-code-implementation-storage
plan: 02
subsystem: storage
tags: [manifest, asset-storage, code-implementation, vitest, withLock]

# Dependency graph
requires:
  - phase: 11-principle-tree-ledger-entities
    provides: "Principle Tree ledger with Implementation CRUD and lifecycle state functions"
provides:
  - "CodeImplementationManifest type for asset metadata"
  - "loadManifest, writeManifest, loadEntrySource, getImplementationAssetRoot, createImplementationAssetDir"
  - "IMPL_CODE_DIR path constant in PD_DIRS and PD_FILES"
  - "Path traversal validation on implId (T-12-08)"
affects: [13-replay-evaluation-and-manual-promotion-loop, 14-nocturnal-candidate-generation]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Subordinate manifest pattern: filesystem manifests hold loading metadata only, ledger is canonical"
    - "Path traversal validation: implId validated for path separators before filesystem operations"

key-files:
  created:
    - packages/openclaw-plugin/src/core/code-implementation-storage.ts
    - packages/openclaw-plugin/tests/core/code-implementation-storage.test.ts
  modified:
    - packages/openclaw-plugin/src/core/paths.ts

key-decisions:
  - "Manifest excludes lifecycleState: ledger is canonical source of truth per D-11"
  - "Path traversal validation on implId to mitigate T-12-08 threat"
  - "Idempotent createImplementationAssetDir: does not overwrite existing entry.js"

patterns-established:
  - "Asset root convention: {stateDir}/.state/principles/implementations/{implId}/"
  - "Manifest-as-loading-metadata: manifests contain version, entryFile, timestamps, refs -- never lifecycle state"

requirements-completed: [IMPL-01, IMPL-02]

# Metrics
duration: 9min
completed: 2026-04-07
---

# Phase 12 Plan 02: Code Implementation Storage Summary

**Versioned code implementation asset storage with manifest read/write, entry file loading, asset directory management, and PD path extension**

## Performance

- **Duration:** 9 min
- **Started:** 2026-04-07T11:52:00Z
- **Completed:** 2026-04-07T12:01:14Z
- **Tasks:** 1
- **Files modified:** 3

## Accomplishments
- Asset storage module with manifest read/write, entry source loading, and directory creation
- IMPL_CODE_DIR path constant added to PD_DIRS and PD_FILES for resolvePdPath access
- Path traversal validation on implId to mitigate T-12-08 threat
- 21 tests covering storage layout, manifest versioning, asset directory creation, idempotency, and edge cases

## Task Commits

Each task was committed atomically:

1. **Task 1: Extend PD paths and create code implementation storage module** - `87e9b3c` (feat)

## Files Created/Modified
- `packages/openclaw-plugin/src/core/code-implementation-storage.ts` - Asset storage primitives: manifest read/write, entry loading, asset directory management
- `packages/openclaw-plugin/src/core/paths.ts` - Added IMPL_CODE_DIR to PD_DIRS and PD_FILES
- `packages/openclaw-plugin/tests/core/code-implementation-storage.test.ts` - 21 tests for storage operations

## Decisions Made
- Manifest excludes lifecycleState field -- ledger is the canonical source of truth per D-11
- Path traversal validation on implId rejects forward slash, backslash, double-dot, and empty strings
- createImplementationAssetDir is idempotent: existing entry.js files are never overwritten
- Placeholder entry.js includes minimal evaluate() export for future Phase 14 candidate generation

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Asset storage layer ready for Phase 13's replay engine to persist evaluation reports
- Storage path convention matches Phase 13's `{stateDir}/.state/principles/implementations/{implId}/replays/` path
- Ready for Phase 14 nocturnal candidate generation to write actual implementation code into entry.js

## Self-Check: PASSED

All created/modified files verified present on disk. Task commit 87e9b3c verified in git log.

---
*Phase: 12-runtime-rule-host-and-code-implementation-storage*
*Completed: 2026-04-07*
