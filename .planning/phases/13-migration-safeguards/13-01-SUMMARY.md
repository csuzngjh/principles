---
phase: "13"
plan: "01"
type: execute
wave: 1
status: complete
completed: "2026-04-20"
requirements_addressed: ["MIGRATE-01"]
---

## Summary

Implemented Phase 13 Migration Safeguards for v1.22 PD CLI Redesign.

## What Was Built

**Task 1: AsyncQueueLock + recordPainSignal serialization**

- Added `AsyncQueueLock` class to `packages/principles-core/src/io.ts` — minimal in-process async queue lock, no external dependencies
- Exported `painFlagLock = new AsyncQueueLock()` singleton
- Updated `recordPainSignal` in `packages/principles-core/src/pain-recorder.ts` to wrap the `atomicWriteFileSync` call with `await painFlagLock.withLock(painFlagPath, async () => { ... })`
- SDK-side only — `write_pain_flag` tool unchanged (keeps tool lightweight)
- TypeScript compilation passes with no errors

**Task 2: pd-cli README with migration section**

- Created `packages/pd-cli/README.md` with package description, installation, usage, and `## Migration from openclaw tools` section
- Section covers: concurrency safety (async queue lock + atomic rename), progressive migration path, no dual-write data loss

## Key Files Modified

- `packages/principles-core/src/io.ts` — added `AsyncQueueLock` class + `painFlagLock` singleton
- `packages/principles-core/src/pain-recorder.ts` — added `painFlagLock.withLock` around `atomicWriteFileSync`
- `packages/pd-cli/README.md` — new file with migration documentation

## Deviations

- Plan grep check referenced `withAsyncLock` but the SDK-side method is `painFlagLock.withLock` (correct per plan intent)

## Verification

- `pnpm tsc --noEmit` in principles-core: PASSED
- `grep "AsyncQueueLock" io.ts`: found at lines 11, 15, 38
- `grep "AsyncQueueLock" pain-recorder.ts`: found at line 115 (comment)
- `grep -i "migration" pd-cli/README.md`: found migration section
