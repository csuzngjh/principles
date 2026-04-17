---
phase: "00a"
plan: "01"
subsystem: "interface-core"
tags: ["schema", "validation", "interface", "sdk-contracts"]
dependency_graph:
  requires: []
  provides: ["PainSignal", "validatePainSignal", "deriveSeverity", "StorageAdapter"]
  affects: []
tech_stack:
  added: ["@sinclair/typebox (Value, Static)", "@sinclair/typebox/value"]
  patterns: ["TypeBox schema definition", "schema validation with default filling", "interface-only module"]
key_files:
  created:
    - path: "packages/openclaw-plugin/src/core/pain-signal.ts"
      provides: "PainSignal schema, validatePainSignal, deriveSeverity"
    - path: "packages/openclaw-plugin/src/core/storage-adapter.ts"
      provides: "StorageAdapter interface"
    - path: "packages/openclaw-plugin/tests/core/pain-signal.test.ts"
      provides: "23 tests covering schema, validation, severity derivation"
  modified: []
decisions:
  - "Used TypeBox for schema definition (matches existing project patterns in tools/write-pain-flag.ts)"
  - "PainSignal extends PainFlagData fields with domain, severity, context for multi-domain SDK support"
  - "validatePainSignal fills defaults (domain='coding', severity from score, context={}) before validation"
  - "StorageAdapter uses Promise-based async API to support both sync and async backends"
  - "mutateLedger<T> uses generic return type for flexible read-modify-write cycles"
metrics:
  duration: "170s"
  completed: "2026-04-17T00:19:27Z"
  tasks_total: 2
  tasks_completed: 2
  files_created: 3
  files_modified: 0
  test_count: 23
  test_pass: 23
---

# Phase 00a Plan 01: Define Foundational Interface Contracts Summary

PainSignal schema with TypeBox validation and StorageAdapter interface for decoupled ledger persistence.

## What Changed

### Task 1: PainSignal Schema (`pain-signal.ts`)

Created `packages/openclaw-plugin/src/core/pain-signal.ts` with:

- **PainSignalSchema**: TypeBox `Type.Object` defining all 11 fields (source, score, timestamp, reason, sessionId, agentId, traceId, triggerTextPreview, domain, severity, context)
- **PainSeverity**: Union type of literal strings ('low' | 'medium' | 'high' | 'critical')
- **validatePainSignal(input: unknown)**: Validates arbitrary input against the schema, fills defaults for optional fields (domain, severity, context), returns structured `{ valid, errors, signal }` result
- **deriveSeverity(score: number)**: Maps numeric pain score to severity label using thresholds (0-39 low, 40-69 medium, 70-89 high, 90-100 critical)
- **23 tests passing** covering schema validation, severity derivation, and edge cases

### Task 2: StorageAdapter Interface (`storage-adapter.ts`)

Created `packages/openclaw-plugin/src/core/storage-adapter.ts` with:

- **StorageAdapter interface**: Three methods:
  - `loadLedger(): Promise<HybridLedgerStore>` -- load current ledger state
  - `saveLedger(store): Promise<void>` -- atomic persist
  - `mutateLedger<T>(mutate): Promise<T>` -- read-modify-write with automatic locking
- Imports `HybridLedgerStore` from `./principle-tree-ledger.js` as the canonical store shape
- Documents atomic write, locking, and read-after-write guarantees

## Deviations from Plan

None - plan executed exactly as written.

## Commits

| Hash | Message | Files |
|------|---------|-------|
| `738ed63d` | feat(00a-01): define PainSignal schema with TypeBox validation | `pain-signal.ts`, `pain-signal.test.ts` |
| `4540f980` | feat(00a-01): define StorageAdapter interface contract | `storage-adapter.ts` |

## Self-Check: PASSED

- [x] `packages/openclaw-plugin/src/core/pain-signal.ts` exists
- [x] `packages/openclaw-plugin/src/core/storage-adapter.ts` exists
- [x] `packages/openclaw-plugin/tests/core/pain-signal.test.ts` exists
- [x] Commit `738ed63d` found in git log
- [x] Commit `4540f980` found in git log
- [x] 23/23 tests passing
