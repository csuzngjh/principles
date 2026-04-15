---
phase: 40
plan: 03
status: completed
---

# Summary: Plan 40-03 — Wire Failure Classifier + Cooldown into Evolution Worker

## Objective
Integrate failure-classifier.ts and cooldown-strategy.ts into evolution-worker.ts task outcome handling.

## What Was Built

### Task 1: Cooldown guards before task processing
- `isTaskKindInCooldown` check before sleep_reflection processing — skips all tasks when in cooldown
- `isTaskKindInCooldown` check before keyword_optimization processing — early return when in cooldown
- Informative log messages with remaining cooldown time

### Task 2: Classifier calls after task outcomes
- `handleTaskOutcome` helper function: on success calls resetFailureState, on failure calls classifyFailure + recordPersistentFailure if persistent
- Outcome tracking arrays for both sleep_reflection and keyword_optimization
- Outcomes processed AFTER queue write (classifier reads latest queue state)
- All classification wrapped in try/catch — errors are non-blocking
- TypeScript compilation passes cleanly

## Key Files
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — Integration with 94 new lines

## Deviations
None.
