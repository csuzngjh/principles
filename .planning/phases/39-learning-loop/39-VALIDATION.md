---
phase: "39"
status: pending
goal: FPR counter tracking, weighted confidence score, time-based 6h trigger, max 4/day throttle, multiplicative weight decay on confirmed FP
requirements_addressed: CORR-02, CORR-06, CORR-07, CORR-08, CORR-10
verification_date: pending
---

# Phase 39: Learning Loop - Validation

## Success Criteria

| # | Criterion | Status |
|---|-----------|--------|
| 1 | CORR-02: match() returns weighted confidence score (0-1) | PENDING |
| 2 | CORR-06: Each keyword tracks hitCount, TP, FP | PENDING |
| 3 | CORR-07: 6-hour time-based trigger | PENDING |
| 4 | CORR-08: Max 4 optimizations per day per workspace | PENDING |
| 5 | CORR-10: Weight decays on FP | PENDING |

## Verification Commands

```bash
# CORR-02: Weighted scoring
grep "Math.min(1, matchedTerms.length / 3)" packages/openclaw-plugin/src/core/correction-cue-learner.ts

# CORR-06: FPR counters
grep "hitCount: number" packages/openclaw-plugin/src/core/correction-types.ts
grep "truePositiveCount: number" packages/openclaw-plugin/src/core/correction-types.ts
grep "falsePositiveCount: number" packages/openclaw-plugin/src/core/correction-types.ts

# CORR-07: Time trigger
grep "SIX_HOURS_MS" packages/openclaw-plugin/src/core/correction-cue-learner.ts
grep "shouldTriggerCorrectionOptimization" packages/openclaw-plugin/src/core/correction-cue-learner.ts

# CORR-08: Throttle
grep "MAX_DAILY_OPTIMIZATIONS = 4" packages/openclaw-plugin/src/core/correction-cue-learner.ts
grep "canOptimize" packages/openclaw-plugin/src/core/correction-cue-learner.ts
grep "recordOptimizationPerformed" packages/openclaw-plugin/src/core/correction-cue-learner.ts

# CORR-10: Weight decay
grep "Math.max(0.1, keyword.weight * 0.9)" packages/openclaw-plugin/src/core/correction-cue-learner.ts

# TypeScript
cd packages/openclaw-plugin && npx tsc --noEmit -p tsconfig.json
```
