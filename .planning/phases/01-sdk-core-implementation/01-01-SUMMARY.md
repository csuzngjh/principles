---
phase: "01"
plan: "01"
subsystem: sdk-core
tags:
  - sdk
  - package-scaffold
  - interface-extraction
dependency_graph:
  requires: []
  provides:
    - "@principles/core package with all interfaces"
  affects:
    - packages/openclaw-plugin
tech_stack:
  added:
    - "@principles/core npm package"
    - TypeBox for schema validation
  patterns:
    - Framework-agnostic SDK design
    - Re-export pattern for canonical source
key_files:
  created:
    - packages/principles-core/package.json
    - packages/principles-core/tsconfig.json
    - packages/principles-core/vitest.config.ts
    - packages/principles-core/src/index.ts
    - packages/principles-core/src/types.ts
    - packages/principles-core/src/pain-signal.ts
    - packages/principles-core/src/pain-signal-adapter.ts
    - packages/principles-core/src/evolution-hook.ts
    - packages/principles-core/src/telemetry-event.ts
    - packages/principles-core/src/storage-adapter.ts
    - packages/principles-core/src/principle-injector.ts
  modified:
    - packages/openclaw-plugin/package.json
    - packages/openclaw-plugin/src/core/pain-signal.ts
    - packages/openclaw-plugin/src/core/pain-signal-adapter.ts
    - packages/openclaw-plugin/src/core/evolution-hook.ts
    - packages/openclaw-plugin/src/core/principle-injector.ts
decisions:
  - "D-02: Created packages/principles-core package as canonical source for SDK interfaces"
  - "D-03: Adapters go under packages/principles-core/src/"
  - "DefaultPrincipleInjector uses budget-aware selection with P0 forced inclusion, implemented using only SDK types"
---
# Phase 01 Plan 01: Package Scaffold + Interface Extraction Summary

## One-liner
Created `@principles/core` npm package scaffold with 6 moved interface files and DefaultPrincipleInjector implementation.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Create principles-core package scaffold | 241635db | package.json, tsconfig.json, vitest.config.ts |
| 2 | Create duplicated type shapes | 241635db | src/types.ts |
| 3 | Move 6 interface files | 241635db | src/pain-signal.ts, src/pain-signal-adapter.ts, src/evolution-hook.ts, src/telemetry-event.ts, src/storage-adapter.ts, src/principle-injector.ts |
| 4 | Create barrel export index.ts | 241635db | src/index.ts |
| 5 | Update openclaw-plugin re-exports | 241635db | 4 files re-export from @principles/core |

## What Was Built

### @principles/core Package
- **package.json**: NPM package definition with exports map for all 6 sub-paths
- **tsconfig.json**: TypeScript config with ES2022 target, bundler module resolution
- **vitest.config.ts**: Vitest config for tests and benchmarks
- **src/index.ts**: Barrel export with all public APIs

### Moved Interface Files
- **pain-signal.ts**: PainSignalSchema, validatePainSignal, deriveSeverity, PainSeverity type
- **pain-signal-adapter.ts**: PainSignalAdapter interface
- **evolution-hook.ts**: EvolutionHook interface, noOpEvolutionHook, event types
- **telemetry-event.ts**: TelemetryEventSchema, validateTelemetryEvent, event types
- **storage-adapter.ts**: StorageAdapter interface (imports HybridLedgerStore from types.ts)
- **principle-injector.ts**: PrincipleInjector interface, InjectionContext, DefaultPrincipleInjector

### DefaultPrincipleInjector Implementation
A minimal framework-agnostic injector using only SDK types:
- Sorts principles by priority (P0 first), then by createdAt (oldest first)
- Always includes P0 principles (forced inclusion)
- Respects budgetChars limit
- Formats as "- [ID] text"

### OpenClaw-Plugin Updates
- pain-signal.ts, pain-signal-adapter.ts, evolution-hook.ts, principle-injector.ts now re-export from @principles/core
- @principles/core added as workspace dependency

## Verification

- [x] principles-core builds without errors (`npm run build`)
- [x] openclaw-plugin compiles with re-exports (`npx tsc --noEmit`)
- [x] vitest passes with --passWithNoTests
- [x] ESLint passes with no errors

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] PainSeverity/TelemetryEventType duplicate identifier error**
- **Found during:** Build verification
- **Issue:** PainSeverity and TelemetryEventType defined both as const (TypeBox schema) and type with same name triggered @typescript-eslint/no-redeclare
- **Fix:** Added eslint-disable-next-line before the type export declaration in pain-signal.ts and telemetry-event.ts
- **Files modified:** packages/principles-core/src/pain-signal.ts, packages/principles-core/src/telemetry-event.ts

## Threat Flags
None - this is a package scaffold with no network exposure or trust boundary changes beyond established workspace boundaries.

## Self-Check: PASSED

- [x] packages/principles-core/package.json exists with correct name
- [x] All 6 interface files exist in principles-core/src/
- [x] DefaultPrincipleInjector implemented in principle-injector.ts
- [x] principles-core/src/types.ts has duplicated InjectablePrinciple and HybridLedgerStore
- [x] openclaw-plugin files re-export from @principles/core
- [x] Commit 241635db exists
