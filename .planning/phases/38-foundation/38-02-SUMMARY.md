---
phase: "38"
plan: "02"
type: execute
subsystem: prompt-integration
tags:
  - keyword-learning
  - correction-cue
  - prompt-hook
  - v1.14
dependency_graph:
  requires:
    - CorrectionCueLearner class (38-01 output)
  provides:
    - detectCorrectionCue replaced with CorrectionCueLearner.match()
  affects:
    - packages/openclaw-plugin/src/hooks/prompt.ts (correction cue detection)
tech_stack:
  added:
    - CorrectionCueLearner.get(wctx.stateDir).match() call site
    - First matched term extraction (matchedTerms[0])
  removed:
    - detectCorrectionCue() function (25 lines)
    - detectCorrectionCue import
  patterns:
    - StateDir passed via wctx.stateDir
    - First-match term extraction for trajectory recording
key_files:
  created: []
  modified:
    - packages/openclaw-plugin/src/hooks/prompt.ts
decisions:
  - id: D-10
    decision: "CorrectionCueLearner.match() replaces detectCorrectionCue() in prompt.ts"
    rationale: "CORR-11: Unified keyword learning pipeline — seed + LLM + user additions all flow through same store"
  - id: D-11
    decision: "First matched term extracted via matchedTerms[0] for trajectory recording"
    rationale: "detectCorrectionCue returned first match; match() returns array; extract [0] for equivalent behavior"
metrics:
  duration_minutes: ~6
  completed_date: "2026-04-14"
  tasks_completed: 1
  files_modified: 1
  ts_errors: 0
---

# Phase 38 Plan 02: prompt.ts Integration - Summary

**Replace detectCorrectionCue() in prompt.ts with CorrectionCueLearner.match() integration.**

## What Was Built

### prompt.ts changes
- Removed `detectCorrectionCue` function (25 lines) and its import
- Added `CorrectionCueLearner` import from `../core/correction-cue-learner.js`
- Replaced `const correctionCue = detectCorrectionCue(userText)` at line 334 with:
  ```typescript
  const correctionCueResult = CorrectionCueLearner.get(wctx.stateDir).match(userText);
  const correctionCue = correctionCueResult.matchedTerms[0];
  ```
- `wctx.stateDir` provides the state directory to the singleton factory

## Commits

| Hash | Message |
|------|---------|
| `284e66aa` | feat(38-foundation): replace detectCorrectionCue with CorrectionCueLearner |

## Deviations from Plan

None — implementation matched plan exactly.

## Verification

- TypeScript: `tsc --noEmit` passes with 0 errors
- `grep -c CorrectionCueLearner` in prompt.ts: 2 (import + call site)
- `grep detectCorrectionCue` in prompt.ts: not found (successfully removed)
