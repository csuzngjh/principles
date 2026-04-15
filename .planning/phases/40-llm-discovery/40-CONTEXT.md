# Phase 40: LLM Discovery - Context

**Gathered:** 2026-04-14
**Status:** Ready for planning

<domain>
## Phase Boundary

LLM optimizer can mutate keyword set (add/update/remove) based on match history and FPR, and trajectory recording includes correctionDetected flag. Mutation is applied by KeywordOptimizationService, not inside the workflow manager or evolution-worker.

</domain>

<decisions>
## Implementation Decisions

### Mutation Application (CORR-09)
- **D-40-01:** KeywordOptimizationService applies LLM-returned ADD/UPDATE/REMOVE to CorrectionCueLearner
- **D-40-02:** Service reads CorrectionObserverResult from workflow, then calls CorrectionCueLearner.add() / updateWeight() / remove() directly
- **D-40-03:** evolution-worker.ts does NOT call CorrectionCueLearner directly — only calls KeywordOptimizationService

### Trigger Mechanism (CORR-07)
- **D-40-04:** New `keyword_optimization` task type in evolution-worker.ts, independent from sleep_reflection
- **D-40-05:** Throttle: max 4/day per workspace via existing checkCooldown (CORR-08 already implemented)
- **D-40-06:** 6-hour wall-clock equivalent via period_heartbeats config

### LLM Input Data (CORR-09)
- **D-40-07:** CorrectionObserverPayload contains: keywordStoreSummary (terms + FPR) + recentMessages + trajectoryHistory
- **D-40-08:** trajectoryHistory: last N user turns where correctionDetected=true, including term matched, timestamp, sessionId
- **D-40-09:** LLM prompt instructs to analyze FPR trends and suggest mutations based on real correction frequency

### Feedback Integration (CORR-10)
- **D-40-10:** recordFalsePositive() called in prompt.ts immediately after correction match (user says "不对" etc.)
- **D-40-11:** "Confirmation" signal: if user continues normal conversation after a correction match (no further correction cues in N turns), call recordTruePositive() for the matched term
- **D-40-12:** Both calls flush to disk immediately

### Integration Point (CORR-12)
- **D-40-13:** correctionDetected flag already recorded in TrajectoryUserTurnInput — no schema change needed
- **D-40-14:** trajectory.listUserTurnsForSession() already returns correctionDetected — KeywordOptimizationService uses this

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Keyword Learning (Phase 38, 39)
- `packages/openclaw-plugin/src/core/correction-cue-learner.ts` — CorrectionCueLearner.match(), recordTruePositive(), recordFalsePositive(), add()
- `packages/openclaw-plugin/src/core/correction-types.ts` — CorrectionKeyword, CorrectionMatchResult interfaces
- `packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts` — CorrectionObserverPayload, CorrectionObserverResult
- `packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-workflow-manager.ts` — CorrectionObserverWorkflowManager (ready for integration)

### Trajectory
- `packages/openclaw-plugin/src/core/trajectory.ts` §854-871 — listUserTurnsForSession() returns correctionDetected
- `packages/openclaw-plugin/src/core/trajectory-types.ts` §37-45 — TrajectoryUserTurnInput definition

### Evolution Worker
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — New task type keyword_optimization goes here
- `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` — checkCooldown for throttle

### Integration
- `packages/openclaw-plugin/src/hooks/prompt.ts` §300-330 — recordFalsePositive() call point after correction match

### Requirements
- `.planning/REQUIREMENTS.md` — CORR-09, CORR-12 definitions

</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `CorrectionObserverWorkflowManager` — already built, needs integration with KeywordOptimizationService
- `CorrectionCueLearner.get(stateDir)` — singleton pattern for all mutations
- `trajectory.listUserTurnsForSession(sessionId)` — already filters by correctionDetected
- `checkCooldown(stateDir, 'keyword_optimization', ...)` — already implemented in Phase 39

### Established Patterns
- KeywordOptimizationService follows singleton factory pattern like CorrectionCueLearner
- Workflow result applied by service, not inside workflow manager
- evolution-worker.ts enqueues periodic task → calls service → service dispatches workflow

### Integration Points
- evolution-worker.ts: new task type keyword_optimization
- KeywordOptimizationService: applies mutations to CorrectionCueLearner
- prompt.ts §327: recordFalsePositive() call
- trajectory collector: already has correctionDetected

</codebase_context>

<deferred>
## Deferred Ideas

- recordTruePositive() implicit confirmation window (N turns) — exact N TBD in implementation
- CORR-12 trajectory flag was partially addressed (flag recorded) but visibility to LLM is the new work

</deferred>

---

*Phase: 40-llm-discovery*
*Context gathered: 2026-04-14*
