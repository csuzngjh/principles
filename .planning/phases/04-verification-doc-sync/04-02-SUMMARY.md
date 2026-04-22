---
phase: 04-verification-doc-sync
plan: 02
status: complete
requirements: [DOC-01]
completed_at: "2026-04-21"
---

# Plan 04-02: Deprecation Markers

## Objective
Add @deprecated JSDoc tags to TrinityRuntimeFailureCode and QueueStatus, pointing to canonical replacements.

## What was built

### Task 1: Deprecate TrinityRuntimeFailureCode
- Added `@deprecated Use PDErrorCategory from '@principles/core/runtime-v2'. M2 migration will replace this.` above TrinityRuntimeFailureCode in `nocturnal-trinity.ts:448`
- No other code changes in the file

### Task 2: Deprecate QueueStatus
- Added `@deprecated Use PDTaskStatus from '@principles/core/runtime-v2'. M2 migration will replace this.` above QueueStatus in `evolution-worker.ts:110`
- No other code changes in the file

## Key Files
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — @deprecated on TrinityRuntimeFailureCode
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — @deprecated on QueueStatus

## Self-Check: PASSED
- DOC-01: Both types marked as deprecated with clear migration path
- IDE tooling will surface deprecation warnings for these types
- TypeScript compilation passes with deprecation annotations
- No other code changes in modified files
