# Phase 39: Learning Loop - Research

**Date:** 2026-04-14
**Phase:** 39-learning-loop
**Status:** Complete

## Open Questions (RESOLVED)

### Q1: How is FP confirmation signaled? (CORR-06)
**Resolved:** Explicit user signal via `recordFalsePositive()` called in prompt.ts after trajectory recording when user expresses dissatisfaction ("不对", etc.). This is more accurate than passive trajectory analysis.

### Q2: Should CorrectionObserverWorkflowManager be a class or plain object? (CORR-07)
**Resolved:** Class — follows EmpathyObserverWorkflowManager pattern. Provides cleaner dependency injection of `api` and testability.

### Q3: Does LLM optimization result persist automatically? (CORR-09)
**Resolved:** Result persists via `CorrectionCueLearner.add()` then `flush()`. The workflow manager returns CorrectionResult; caller is responsible for applying results to the store.

## Validation Architecture

### What to verify:
- `correction-cue-learner.ts` exports: `match()`, `recordTruePositive()`, `recordFalsePositive()`, `shouldTriggerCorrectionOptimization()`, `canOptimize()`, `recordOptimizationPerformed()`
- `correction-types.ts` exports: `CorrectionKeyword` with hitCount/TP/FP counters, `CorrectionMatchResult` with confidence
- `evolution-worker.ts` adds `keyword_optimization` periodic task type

### How to verify:
```bash
grep -c "recordTruePositive\|recordFalsePositive" packages/openclaw-plugin/src/core/correction-cue-learner.ts
grep -c "shouldTriggerCorrectionOptimization" packages/openclaw-plugin/src/core/correction-cue-learner.ts
grep -c "correction_observer" packages/openclaw-plugin/src/service/subagent-workflow/
```

## Implementation Notes

- Timer is TIME-ONLY (wall-clock), not turn-based
- Throttle is per-workspace using existing checkCooldown infrastructure
- Weight decay: `Math.max(0.1, keyword.weight * 0.9)` per confirmed FP
- Score formula: `keyword.weight * (TP / (TP + FP + 1))` with +1 smoothing
