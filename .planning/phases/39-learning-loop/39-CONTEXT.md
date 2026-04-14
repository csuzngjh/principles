# Phase 39: Learning Loop - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

Match calls track FPR feedback separately (CORR-06), optimization triggers time-based every 6 hours (CORR-07), throttle enforces max 4 calls per day (CORR-08), and confirmed false positives decay keyword weight (CORR-10). LLM optimizer mutation (CORR-09) and trajectory flag (CORR-12) are Phase 40.

</domain>

<decisions>
## Implementation Decisions

### FPR Stats Schema (CORR-06)
- **D-39-01:** Each `CorrectionKeyword` gains three new counters: `{ hitCount: number, truePositiveCount: number, falsePositiveCount: number }`
- **D-39-02:** Counters are initialized to 0 on seed keywords and incremented atomically on each match/feedback

### Confidence Score Formula (CORR-02)
- **D-39-03:** `match().score = keyword.weight × (TP / (TP + FP + 1))` — weight multiplied by accuracy component
- **D-39-04:** +1 smoothing in denominator avoids division by zero; accuracy approaches 1 as TP grows, approaches 0 as FP grows

### FPR Feedback Mechanism (CORR-06)
- **D-39-05:** `CorrectionCueLearner.recordFalsePositive(term)` — explicit API for marking a match as FP
- **D-39-06:** `CorrectionCueLearner.recordTruePositive(term)` — explicit API for marking a match as TP
- **D-39-07:** Integration point: prompt.ts after trajectory recording — when user expresses dissatisfaction, call recordFalsePositive() with the detected term
- **D-39-08:** `recordTruePositive()` called implicitly when a correction cue match leads to a confirmed good outcome (or can be called explicitly by caller)

### Timer Implementation (CORR-07)
- **D-39-09:** Reuse `evolution-worker.ts` periodic trigger mechanism
- **D-39-10:** Add new periodic task type `keyword_optimization` that fires every `period_heartbeats` (6-hour wall-clock equivalent)
- **D-39-11:** The optimization subagent workflow is invoked via the same `enqueueSleepReflectionTask` / task infrastructure used for sleep_reflection

### Throttle Scope (CORR-08)
- **D-39-12:** Per-workspace throttle: each workspace has independent 4 calls/day quota
- **D-39-13:** Use existing `checkCooldown(wctx.stateDir, ...)` with `maxRunsPerWindow: 4, quotaWindowMs: 24 * 60 * 60 * 1000`
- **D-39-14:** `evolution-worker` already supports per-workspace cooldown tracking via `wctx.stateDir` — reuse without modification

### Weight Decay Function (CORR-10)
- **D-39-15:** Multiplicative decay: `keyword.weight = keyword.weight × 0.8` on each confirmed FP
- **D-39-16:** Decay is applied immediately in `recordFalsePositive()` before the store is flushed to disk
- **D-39-17:** Keywords at very low weight (e.g., < 0.1) can still match but contribute minimally to confidence score

### Claude's Discretion
- Exact `period_heartbeats` value mapping to 6 hours (depends on heartbeat interval configured in sleepConfig)
- Whether to also increment `hitCount` on every `match()` call (yes — D-39-02 implies this)
- Whether keywords at weight < threshold should be excluded from matching entirely

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Keyword Learning (Phase 38)
- `packages/openclaw-plugin/src/core/correction-types.ts` — Current CorrectionKeyword interface (needs extending per D-39-01)
- `packages/openclaw-plugin/src/core/correction-cue-learner.ts` — Existing load/save/match API (needs recordFP/recordTP methods per D-39-05/06)
- `packages/openclaw-plugin/src/hooks/prompt.ts` §310-327 — Integration point for recordFalsePositive() call (D-39-07)

### Evolution Worker Patterns
- `packages/openclaw-plugin/src/service/evolution-worker.ts` §2174-2199 — Existing periodic trigger + checkCooldown pattern (reuse per D-39-09/12)
- `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` — `checkCooldown` function signature and throttle tracking

### Requirements
- `.planning/REQUIREMENTS.md` — CORR-02, CORR-06, CORR-07, CORR-08, CORR-10 definitions

</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `checkCooldown(stateDir, undefined, { maxRunsPerWindow, quotaWindowMs })` — already handles per-workspace throttle; supply `maxRunsPerWindow: 4`
- `sleepConfig.period_heartbeats` — existing config field for periodic trigger threshold
- `CorrectionCueLearner.match()` — already returns `{ matched, matchedTerms, score }`; score logic needs updating per D-39-03

### Established Patterns
- Singleton factory: `CorrectionCueLearner.get(stateDir)` — recordFP/recordTP methods follow same pattern
- Module-level cache invalidated on write — recordFP/recordTP must call `flush()` after updating counters
- Atomic write via temp-file-then-rename — unchanged

### Integration Points
- `prompt.ts:327` — `correctionDetected: Boolean(correctionCue)` already in trajectory; add `recordFalsePositive(correctionCue)` call alongside trajectory write
- `evolution-worker.ts` periodic trigger — add `keyword_optimization` task type alongside existing `sleep_reflection`
</codebase_context>

<deferred>
## Deferred Ideas

- Consider `recordTruePositive()` implicit vs explicit — left as calling-context decision for now (D-39-08)
- Minimum weight threshold for matching (D-39-17 — Claude's discretion)

</deferred>

---

*Phase: 39-learning-loop*
*Context gathered: 2026-04-14*
