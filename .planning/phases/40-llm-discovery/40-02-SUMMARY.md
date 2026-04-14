---
phase: 40
plan: 02
status: completed
---

# Summary: Plan 40-02 — Cooldown Strategy Module

## Objective
Create the stateful cooldown strategy module that persists tiered escalation state to nocturnal-runtime.json.

## What Was Built

### Task 1: cooldown-strategy.ts with tiered escalation + unit tests
- `recordPersistentFailure()`: escalates tier on each call (Tier 1=30min, Tier 2=4h, Tier 3=24h cap)
- `resetFailureState()`: clears both consecutiveFailures and escalationTier, idempotent
- `isTaskKindInCooldown()`: synchronous check returning inCooldown, remainingMs, cooldownUntil
- Independent state per task kind via nocturnal-runtime.json
- Uses exported readState/writeState from nocturnal-runtime.ts (Plan 01)
- 12 unit tests covering all escalation tiers, reset, cooldown checks, persistence, custom config

## Key Files
- `packages/openclaw-plugin/src/service/cooldown-strategy.ts` — Stateful cooldown strategy
- `packages/openclaw-plugin/tests/service/cooldown-strategy.test.ts` — 12 tests

## Deviations
None.
