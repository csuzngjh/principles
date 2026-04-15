---
phase: "39"
plan: "01"
type: execute
subsystem: keyword-learning
tags:
  - keyword-learning
  - correction-cue
  - fpr-tracking
  - confidence-score
dependency_graph:
  requires: []
  provides:
    - CorrectionCueLearner with weighted match, recordTruePositive, recordFalsePositive
    - FPR counter tracking per keyword
    - Per-workspace daily throttle (max 4/day)
  affects:
    - packages/openclaw-plugin/src/core/correction-types.ts
    - packages/openclaw-plugin/src/core/correction-cue-learner.ts
tech_stack:
  added:
    - hitCount, truePositiveCount, falsePositiveCount, lastHitAt fields on CorrectionKeyword
    - confidence field on CorrectionMatchResult
    - lastOptimizedAt field on CorrectionKeywordStore
    - Weighted scoring: score = weight × (TP / (TP + FP + 1))
    - recordTruePositive(term) and recordFalsePositive(term) methods
    - shouldTriggerCorrectionOptimization() function
    - canOptimize(), canRunKeywordOptimization(), recordOptimizationPerformed() throttle functions
    - THROTTLE_FILE = 'correction_optimization_throttle.json', MAX_DAILY_OPTIMIZATIONS = 4
  patterns:
    - Multiplicative decay: weight = Math.max(0.1, weight × 0.8) on FP
    - +1 smoothing in FPR denominator
key_files:
  created: []
  modified:
    - packages/openclaw-plugin/src/core/correction-types.ts
    - packages/openclaw-plugin/src/core/correction-cue-learner.ts
decisions:
  - id: CORR-02
    decision: "match() returns weighted confidence score = weight × (TP / (TP + FP + 1))"
    rationale: "CORR-02: Combines keyword quality with usage history"
  - id: CORR-06
    decision: "Each CorrectionKeyword tracks hitCount, TP, FP counters"
    rationale: "CORR-06: Atomic counters for FPR-based scoring"
  - id: CORR-08
    decision: "Per-workspace throttle: max 4 optimizations/day using checkCooldown"
    rationale: "CORR-08: Reuse existing checkCooldown per-workspace infrastructure"
  - id: CORR-10
    decision: "weight = Math.max(0.1, weight × 0.8) on confirmed FP"
    rationale: "CORR-10: Multiplicative decay with floor, 3 FP → 51%"
metrics:
  duration_minutes: ~12
  completed_date: "2026-04-14"
  tasks_completed: 4
  files_modified: 2
  ts_errors: 0
---

# Phase 39 Plan 01: Learning Loop Core - Summary

## What Was Built

### FPR Counter Schema (CORR-06)
- Added `hitCount`, `truePositiveCount`, `falsePositiveCount`, `lastHitAt` to `CorrectionKeyword`
- Added `confidence` to `CorrectionMatchResult`
- Added `lastOptimizedAt` to `CorrectionKeywordStore`
- Fields are optional for migration safety

### Weighted Scoring (CORR-02)
- `match()` now returns `score = weight × (TP / (TP + FP + 1))` with +1 smoothing
- `confidence` derived from both term count and score

### recordTruePositive/recordFalsePositive (CORR-10)
- `recordFalsePositive()`: Decreases weight by 20% (multiplicative ×0.8), minimum 0.1
- `recordTruePositive()`: Increments TP counter
- Both flush to disk immediately

### Per-Workspace Throttle (CORR-08)
- `canRunKeywordOptimization()` uses `checkCooldown` with `maxRunsPerWindow: 4, quotaWindowMs: 24h`
- Throttle file: `correction_optimization_throttle.json`

## Commits

| Hash | Message |
|------|---------|
| `81dac47c` | feat(39-01): add FPR counter fields to CorrectionKeyword and confidence |
| `e05cbf17` | feat(39-01): implement weighted scoring, recordFP/TP, and throttle |

## Verification

- TypeScript: `tsc --noEmit` passes
- grep verifications all pass:
  - `hitCount: number` in correction-types.ts
  - `truePositiveCount: number` in correction-types.ts
  - `falsePositiveCount: number` in correction-types.ts
  - `Math.max(0.1, keyword.weight * 0.8)` in correction-cue-learner.ts
  - `MAX_DAILY_OPTIMIZATIONS = 4` in correction-cue-learner.ts
