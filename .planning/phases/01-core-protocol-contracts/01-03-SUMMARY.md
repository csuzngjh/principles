---
phase: 01-core-protocol-contracts
plan: 03
status: complete
completed: "2026-04-21T21:25:00.000Z"
---

# Plan 01-03: PdError Unification — Complete

## What was built

Unified the old PdError class hierarchy with PDRuntimeError from runtime-v2 by adding a shared PDErrorCategory field.

## Tasks

| # | Task | Status |
|---|------|--------|
| 1 | Add PDErrorCategory to PdError and map subclasses | Done |

## Key Decisions

- PdError base class gets `readonly category: PDErrorCategory` field
- `codeToCategory` mapping translates 8 legacy error codes to canonical categories
- Default fallback: `'execution_failed'` for unknown codes
- No subclass constructors changed — fully backward compatible
- Import via `@principles/core` (resolves after `npm install` + dist build)

## Code-to-Category Mapping

| Legacy Code | PDErrorCategory |
|-------------|-----------------|
| LOCK_UNAVAILABLE | lease_conflict |
| PATH_RESOLUTION_ERROR | workspace_invalid |
| WORKSPACE_NOT_FOUND | workspace_invalid |
| SAMPLE_NOT_FOUND | storage_unavailable |
| CONFIGURATION_ERROR | input_invalid |
| DEPENDENCY_ERROR | runtime_unavailable |
| EVOLUTION_PROCESSING_ERROR | execution_failed |
| TRAJECTORY_ERROR | storage_unavailable |

## Files

### key-files.modified
- `packages/openclaw-plugin/src/config/errors.ts` — Added PDErrorCategory import + category field + code mapping
- `packages/principles-core/src/io.ts` — Fixed pre-existing type error for dist generation

## Verification

- `npx tsc --noEmit` passes for both principles-core and openclaw-plugin
- All 8 error codes mapped to canonical categories
- No subclass changes — backward compatible

## Issues

- Required `npm install` in worktree to resolve `@principles/core` workspace link (pre-existing)
- Required fixing io.ts type error to generate dist (pre-existing)
