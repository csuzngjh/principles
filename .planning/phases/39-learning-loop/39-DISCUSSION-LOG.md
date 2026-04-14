# Phase 39: Learning Loop - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-14
**Phase:** 39-learning-loop
**Areas discussed:** FPR Stats Schema, Confidence Score Formula, FPR Feedback Mechanism, Timer Implementation, Throttle Scope, Decay Function, Decay Factor

---

## FPR Stats Schema

| Option | Description | Selected |
|--------|-------------|----------|
| hitCount + TP + FP counters | Add { hitCount, truePositiveCount, falsePositiveCount } to CorrectionKeyword | ✓ |
| Raw samples array | Store individual match events [{timestamp, wasTP, wasFP}]. More detail, larger store. | |
| FPR ratio only | Store { hitCount, falsePositiveRate }. Loses counter granularity. | |

**User's choice:** hitCount + TP + FP counters
**Notes:** Clean, normalized counters. Straightforward to compute accuracy.

---

## Confidence Score Formula

| Option | Description | Selected |
|--------|-------------|----------|
| weight × accuracy | score = weight × (TP / (TP + FP + 1)). +1 smoothing avoids /0. | ✓ |
| weight × log(1 + hitCount) | score = weight × (1 + log(1 + hitCount)). Grows with usage but ignores TP/FP quality. | |
| weight only | score = weight. No FPR component. Simpler but less informative. | |

**User's choice:** weight × accuracy
**Notes:** Statistically grounded. Weight × (TP/(TP+FP+1)) directly combines keyword quality with usage history.

---

## FPR Feedback Mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Trajectory-based record API | After response, if user says "不对", call recordFalsePositive(term). Integration point: prompt.ts after trajectory recording. | ✓ |
| Passive trajectory analysis | No explicit API. Evolution Worker analyzes trajectory JSON post-hoc. Lower accuracy. | |
| Bidirectional explicit confirmation | Both recordFalsePositive AND recordTruePositive require explicit calls. More complete but higher caller burden. | |

**User's choice:** Trajectory-based record API (显式记录)
**Notes:** After discussion comparing accuracy/stability: explicit recording is more accurate and stable than passive analysis. Direct user signal is more reliable than inference.

---

## Timer Implementation

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse evolution-worker periodic trigger | Add new periodic task type 'keyword_optimization', reuse existing heartbeat + checkCooldown infrastructure. | ✓ |
| Independent nocturnal worker | New dedicated worker. No impact on evolution-worker but adds new code path. | |
| CorrectionCueLearner internal timer | Internal setInterval. Per-workspace granularity. | |

**User's choice:** Reuse evolution-worker periodic trigger
**Notes:** Leverages existing heartbeat infrastructure. Per-workspace via wctx.stateDir.

---

## Throttle Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Per-workspace | Each workspace has independent 4/day quota. Independent evolution per workspace. | ✓ |
| Global | All workspaces share 4/day quota. One active workspace could exhaust others' quota. | |

**User's choice:** Per-workspace
**Notes:** Reuse existing checkCooldown(wctx.stateDir) which is already per-workspace.

---

## Weight Decay Function

| Option | Description | Selected |
|--------|-------------|----------|
| Multiplicative decay | weight = weight × 0.8 on each confirmed FP. Exponential decay, never reaches 0. | ✓ |
| Subtractive decay | weight = weight - 0.1 per FP. Can go negative, needs special handling. | |
| Exponential decay to 0 | weight = weight × (1 - falsePositiveRate). More statistically meaningful but complex. | |

**User's choice:** Multiplicative decay (weight × 0.8)
**Notes:** 3 consecutive FPs: 0.8³ = 0.512. Balances sensitivity and stability.

---

## Decay Factor

| Option | Description | Selected |
|--------|-------------|----------|
| 0.8 | weight × 0.8 per FP. 3 FP → 51%, 5 FP → 33%. | ✓ |
| 0.9 (conservative) | Slow decay. Keywords need many FPs to失效. | |
| 0.5 (aggressive) | Fast decay. Keywords失效 quickly. | |

**User's choice:** 0.8
**Notes:** Balances sensitivity and stability.

---

## Claude's Discretion

- Exact `period_heartbeats` mapping to 6 hours — depends on heartbeat interval in sleepConfig
- Whether to increment `hitCount` on every `match()` call — implied yes by D-39-02
- Whether keywords at very low weight (< 0.1) should be excluded from matching entirely

---

## Deferred Ideas

- Whether `recordTruePositive()` should be implicit or explicit — decided as explicit (D-39-08) but calling context can decide when to invoke
- Minimum weight threshold for matching — left to planning/implementation
