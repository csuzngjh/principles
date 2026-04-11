---
phase: 28-context-builder-service-slim-fallback-audit
plan: 01
status: complete
completed_date: 2026-04-11
---

# Phase 28 Plan 01 Summary — TaskContextBuilder + EventLog Skip/Drop

## Completed Work

**TaskContextBuilder created and EventLog extended** — context extraction logic centralized into dedicated module with fail-visible event emission for FB-04/FB-05.

### Files Created/Modified

**`packages/openclaw-plugin/src/service/task-context-builder.ts`** (NEW, ~175 lines)
- `TaskContextBuilder` class with `constructor(workspaceDir)`, `buildCycleContext()`, `buildFallbackSnapshot()`
- `CycleContextResult` interface with idle/cooldown/recentPain/activeSessions/errors fields
- FB-04: `checkWorkspaceIdle` error emits `eventLog.recordSkip()` with reason=`checkWorkspaceIdle_error`, fallback=`default_idle_assumption` — pipeline continues
- FB-05: `checkCooldown` error emits `eventLog.recordSkip()` with reason=`checkCooldown_error`, fallback=`no_cooldown_assumption` — pipeline continues
- CONTRACT-03: permissive validation at entry point — `!wctx || typeof wctx !== 'object'` returns error result, never throws
- All operations wrapped in try/catch, errors returned in result.errors

**`packages/openclaw-plugin/src/core/event-log.ts`** (modified)
- Added `recordSkip(sessionId, data)` and `recordDrop(sessionId, data)` methods
- Follow existing `recordRuleMatch` pattern — both call `this.record()` with union-typed type/category

**`packages/openclaw-plugin/src/types/event-types.ts`** (modified)
- Extended `EventType` union with `'skip'` and `'drop'`
- Extended `EventCategory` union with `'skipped'` and `'dropped'`
- Added `SkipEventData` interface: `{ reason, fallback, context? }`
- Added `DropEventData` interface: `{ reason, itemId?, context? }`

**`packages/openclaw-plugin/tests/service/task-context-builder.test.ts`** (NEW, ~290 lines)
- 13 tests covering constructor, buildCycleContext return shape, invalid wctx validation, FB-04/FB-05 fail-visible event emission, buildFallbackSnapshot with/without painContext, no-throw boundary guarantee

**`packages/openclaw-plugin/tests/core/event-log.test.ts`** (modified)
- Added 4 tests for `recordSkip`/`recordDrop` covering sessionId, undefined sessionId, minimal data, full data

## Architecture Pattern

Follows Phase 24/25/26/27 pattern:
- Class with `constructor(workspaceDir)`
- Async entry methods returning structured result objects
- Permissive validation at entry points (CONTRACT-03)
- Internal errors caught and returned in result.errors, never thrown
- Fail-visible classification for FB-04/FB-05 — pipeline continues with defaults, diagnostics observe via event emission

## Verification Checklist

- [x] EventLog has `recordSkip()` and `recordDrop()` methods (verified by grep)
- [x] EventType union includes `'skip'` and `'drop'` (no type erasure casts)
- [x] EventCategory union includes `'skipped'` and `'dropped'`
- [x] `SkipEventData` and `DropEventData` interfaces exist in event-types.ts
- [x] TaskContextBuilder file created at correct path
- [x] TaskContextBuilder has `class TaskContextBuilder`, `buildCycleContext`, `buildFallbackSnapshot`
- [x] FB-04 emits `eventLog.recordSkip()` with `reason='checkWorkspaceIdle_error'`
- [x] FB-05 emits `eventLog.recordSkip()` with `reason='checkCooldown_error'`
- [x] Entry validation rejects invalid wctx with error result (not thrown)
- [x] All try/catch wrapped operations return errors in result.errors
- [x] No `throw` statements in public methods of TaskContextBuilder
- [x] All 24 tests pass (11 event-log + 13 task-context-builder)

## Test Results

- `tests/core/event-log.test.ts`: **11 passed** (7 existing + 4 new for recordSkip/recordDrop)
- `tests/service/task-context-builder.test.ts`: **13 passed** (all new)

## Key Decisions

1. **Fail-visible for FB-04/FB-05**: Rather than fail-fast when idle/cooldown checks fail, the pipeline continues with conservative defaults while diagnostics observe via structured skip events
2. **Optional eventLog parameter**: `buildCycleContext(eventLog?)` only emits events when provided — callers are not required to pass an eventLog
3. **Spy-based FB-04/FB-05 testing**: Since `checkWorkspaceIdle`/`checkCooldown` return defaults on nonexistent paths (no throw), tests use `vi.spyOn` to force errors for coverage

## Deviations from Plan

None — plan executed exactly as written.

## Commits

- `a8cbd8a` feat(28-01): add EventLog recordSkip/recordDrop and extend event types
- `7238962` feat(28-01): create TaskContextBuilder class with buildCycleContext and buildFallbackSnapshot

## Dependencies Satisfied

- **CONTRACT-03**: Every extracted module has input validation at entry points — `buildCycleContext` validates wctx with permissive check
- **CONTRACT-04**: 16 silent fallback points audited — FB-04 and FB-05 now emit structured skip events (2 of 16 addressed in this plan)
- **CONTRACT-05**: Fail-visible points emit structured skip/drop events — `recordSkip`/`recordDrop` available for all fail-visible fallback emission
- **DECOMP-05**: TaskContextBuilder extracts context building from evolution-worker.ts

## Self-Check: PASSED

All verification checks confirmed:
- `src/service/task-context-builder.ts` exists (7472 bytes)
- `tests/service/task-context-builder.test.ts` exists (11180 bytes)
- `28-01-SUMMARY.md` exists (5132 bytes)
- Commits `a8cbd8a` and `7238962` present in git log
