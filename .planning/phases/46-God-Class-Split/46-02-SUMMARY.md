---
phase: 46
plan: 02
subsystem: evolution-worker
tags: [god-class-split, queue-migration, extraction]
dependency_graph:
  requires:
    - 46-01
  provides:
    - SPLIT-02
  affects:
    - evolution-worker.ts
    - workflow-watchdog.ts
tech_stack:
  added:
    - workflow-watchdog.ts (standalone watchdog module)
    - workflow-watchdog.test.ts (8 Vitest unit tests)
  patterns:
    - Extraction refactoring (god class split pattern)
    - Re-export facade for backward compatibility
    - BUG-01/02/03 inline bug fixes preserved in extraction
key_files:
  created:
    - packages/openclaw-plugin/src/service/workflow-watchdog.ts
    - packages/openclaw-plugin/tests/service/workflow-watchdog.test.ts
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts
decisions: []
---

# Phase 46 Plan 02 Summary: Extract workflow-watchdog.ts

## Objective

Extract `workflow-watchdog.ts` from `evolution-worker.ts` (lines 79-223) — workflow health monitoring module handling stale workflow detection, child session cleanup, and nocturnal snapshot validation.

## What Was Built

### Artifacts

| Artifact | Lines | Description |
|----------|-------|-------------|
| `src/service/workflow-watchdog.ts` | 162 | Standalone watchdog: `runWorkflowWatchdog`, `WatchdogResult` interface |
| `tests/service/workflow-watchdog.test.ts` | 371 | 8 Vitest test cases covering BUG-01/02/03 |

### Symbols Extracted

| Symbol | Type | New Location |
|--------|------|--------------|
| `WatchdogResult` | interface | workflow-watchdog.ts |
| `runWorkflowWatchdog` | async function | workflow-watchdog.ts |

### Bug Fixes Preserved (Inline During Extraction)

| Bug | Description | Location in watchdog.ts |
|-----|-------------|------------------------|
| BUG-01 | `isExpectedSubagentError` guard prevents marking daemon-mode stale workflows as `terminal_error` | lines 102-104 |
| BUG-02 | Gateway fallback chain for child session cleanup: `subagentRuntime.deleteSession` -> `agentSession.loadSessionStore` -> `saveSessionStore` after gateway error | lines 119-135 |
| BUG-03 | Nocturnal snapshot validation detects `pain_context_fallback` with zero stats | lines 146-156 |

### Backward Compatibility

- `evolution-worker.ts` re-exports both `runWorkflowWatchdog` and `WatchdogResult` from `workflow-watchdog.ts`
- Internal callers within `evolution-worker.ts` use the local import (not the re-export path)
- All 24 related tests pass (8 watchdog + 10 queue-migration + 6 queue tests)

## Deviations from Plan

None — plan executed exactly as written.

## Pre-existing Issues (Not Fixed)

- `evolution-worker.ts:966-967`: `Property 'length' does not exist on type '{}'` — pre-existing `payload.failures` typing issue

## Commits

| Commit | Description |
|--------|-------------|
| `d9c9b7e4` | feat(46-02): extract workflow-watchdog.ts from evolution-worker.ts |
| `56ab470a` | test(46-02): add unit tests for workflow-watchdog.ts |
| `fee77119` | refactor(46-02): replace inline watchdog with re-export from workflow-watchdog.ts |

## Verification Results

```
npx tsc --noEmit --skipLibCheck: PASS (only pre-existing 966/967 errors)
npx vitest run tests/service/workflow-watchdog.test.ts: 8 passed
npx vitest run tests/service/workflow-watchdog.test.ts tests/service/queue-migration.test.ts tests/service/evolution-worker.queue.test.ts: 24 passed
```

## Self-Check

- [x] `workflow-watchdog.ts` exists with all required exports
- [x] `workflow-watchdog.test.ts` has 8 test cases covering BUG-01, BUG-02, BUG-03
- [x] `evolution-worker.ts` re-exports `runWorkflowWatchdog` and `WatchdogResult`
- [x] Inline definition removed from `evolution-worker.ts`
- [x] All 3 commits created
- [x] Backward compatibility verified (24 related tests pass)

## Self-Check: PASSED
