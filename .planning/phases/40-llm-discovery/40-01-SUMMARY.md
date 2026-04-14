---
phase: 40
plan: 01
status: completed
---

# Summary: Plan 40-01 — Failure Classifier Foundation

## Objective
Lay the foundation for failure classification by extending the nocturnal state model, exporting state access functions, adding cooldown tier configuration, and creating the pure failure classifier module.

## What Was Built

### Task 1: Extended NocturnalRuntimeState + exported readState/writeState + CooldownEscalationConfig
- Added `TaskFailureState` interface (consecutiveFailures, escalationTier, cooldownUntil)
- Added optional `taskFailureState` field to `NocturnalRuntimeState`
- Exported `readState`, `readStateSync`, `writeState` from nocturnal-runtime.ts
- Updated both `readState` and `readStateSync` to preserve `taskFailureState`
- Added `CooldownEscalationConfig` interface to nocturnal-config.ts with tiered defaults (30min/4h/24h)
- Added `loadCooldownEscalationConfig()` function

### Task 2: Created failure-classifier.ts + unit tests
- Pure stateless `classifyFailure()` function counting consecutive failures from evolution queue
- Only counts `status === 'failed'` as failures; `status === 'completed'` (any resolution) breaks chain
- Independent counting per task kind (sleep_reflection, keyword_optimization)
- Configurable threshold (default: 3)
- 14 unit tests covering all classification behaviors

## Key Files
- `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` — TaskFailureState interface + exported state functions
- `packages/openclaw-plugin/src/service/nocturnal-config.ts` — CooldownEscalationConfig + loader
- `packages/openclaw-plugin/src/service/failure-classifier.ts` — Pure classification module
- `packages/openclaw-plugin/tests/service/failure-classifier.test.ts` — 14 tests

## Deviations
None.
