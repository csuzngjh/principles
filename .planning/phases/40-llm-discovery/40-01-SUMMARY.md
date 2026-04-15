---
phase: 40-llm-discovery
plan: 40-01
subsystem: core
tags: [keyword, llm, correction, evolution-worker, trajectory, workflow]

# Dependency graph
requires:
  - phase: 39-learning-loop
    provides: CorrectionCueLearner with FPR tracking, CorrectionObserverWorkflowManager
affects:
  - [future phases using keyword optimization]
provides:
  - KeywordOptimizationService applying ADD/UPDATE/REMOVE mutations to keyword store
  - keyword_optimization task firing every 6h via evolution-worker heartbeat
  - trajectoryHistory field in CorrectionObserverPayload (CORR-12)
tech-stack:
  added: []
  patterns:
    - Singleton KeywordOptimizationService with get()/reset()
    - Fire-and-poll via workflowId stored in task.resultRef
    - getWorkflowResult() on CorrectionObserverWorkflowManager for LLM result retrieval
key-files:
  created:
    - packages/openclaw-plugin/src/service/keyword-optimization-service.ts
    - packages/openclaw-plugin/tests/service/keyword-optimization-service.test.ts
  modified:
    - packages/openclaw-plugin/src/service/evolution-worker.ts
    - packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-workflow-manager.ts
    - packages/openclaw-plugin/src/core/trajectory-types.ts
    - packages/openclaw-plugin/src/core/correction-cue-learner.ts
    - packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts
key-decisions:
  - "KeywordOptimizationService singleton instead of plain module — enables test mocking"
  - "getWorkflowResult() added to CorrectionObserverWorkflowManager — workflow store not directly accessible to evolution-worker"
  - "enqueueKeywordOptimizationTask() uses same queue lock pattern as enqueueSleepReflectionTask()"
patterns-established:
  - "Fire-and-poll: workflowId stored in task.resultRef, polled on subsequent heartbeat cycles"
  - "Mutations applied atomically via learner.add()/updateWeight()/remove() + learner.flush()"
requirements-completed: [CORR-09, CORR-12]

# Metrics
duration: 18min
completed: 2026-04-14
---

# Phase 40: LLM Discovery Summary

**LLM optimizer dispatches correction keyword mutations via CorrectionObserverWorkflowManager, fires every 6h from evolution-worker heartbeat**

## Performance

- **Duration:** ~18 min (6 from agent + 12 from orchestrator recovery)
- **Started:** 2026-04-14T08:15:00Z
- **Completed:** 2026-04-14T08:33:00Z
- **Tasks:** 3
- **Files modified:** 6 new, 4 modified

## Accomplishments
- KeywordOptimizationService dispatches LLM via CorrectionObserverWorkflowManager and applies mutations
- keyword_optimization task fires every `period_heartbeats` (6h wall-clock) via evolution-worker
- Fire-and-poll: workflowId tracked in task.resultRef, polled on subsequent cycles
- CORR-12 verified: correctionDetected flag flows prompt.ts:327 → trajectory → LLM input
- trajectoryHistory field in CorrectionObserverPayload for FPR trend analysis

## Task Commits

1. **Task 1: trajectoryHistory field** - `4c7a4fe0` (feat)
2. **Task 2: test stub** - `ee001484` (test)
3. **Task 3: KeywordOptimizationService** - `7baa7623` (feat)
4. **Task 4: updateWeight/remove** - `acb52342` (feat)
5. **Task 5: evolution-worker wiring + fixes** - `f3191423` (feat)

**Plan metadata:** `6d7089c7` (docs: plan)

## Files Created/Modified

- `packages/openclaw-plugin/src/service/keyword-optimization-service.ts` - **NEW** LLM mutation application service (ADD/UPDATE/REMOVE)
- `packages/openclaw-plugin/tests/service/keyword-optimization-service.test.ts` - **NEW** Vitest test stub
- `packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-types.ts` - trajectoryHistory field added
- `packages/openclaw-plugin/src/service/evolution-worker.ts` - keyword_optimization task processing + periodic trigger
- `packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-workflow-manager.ts` - getWorkflowResult() method
- `packages/openclaw-plugin/src/core/trajectory-types.ts` - 'keyword_optimization' added to TaskKind
- `packages/openclaw-plugin/src/core/correction-cue-learner.ts` - updateWeight() and remove() methods

## Decisions Made

- **Added getWorkflowResult() to CorrectionObserverWorkflowManager** — WorkflowStore is private/protected in base class; evolution-worker needs a typed way to retrieve parsed LLM results after workflow completes
- **enqueueKeywordOptimizationTask uses same lock pattern as enqueueSleepReflectionTask** — consistent with existing code, reuses requireQueueLock
- **get() singleton with stateDir key** — KeywordOptimizationService.get(stateDir, logger) returns cached instance, enabling clean test mocking

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule: Missing Critical] enqueueKeywordOptimizationTask function never defined**
- **Found during:** Task 2 (evolution-worker.ts wiring)
- **Issue:** Agent's evolution-worker.ts diff called `enqueueKeywordOptimizationTask()` at line 2350 but the function was never defined — would have caused runtime ReferenceError
- **Fix:** Added `enqueueKeywordOptimizationTask()` function after `enqueueSleepReflectionTask()`, following identical pattern
- **Files modified:** packages/openclaw-plugin/src/service/evolution-worker.ts
- **Verification:** TypeScript compiles clean, function found at expected location
- **Committed in:** f3191423 (part of evolution-worker wiring commit)

**2. [Rule: Missing Critical] Mutations never applied — applyResult() not called on workflow completion**
- **Found during:** Task 2 (evolution-worker.ts wiring)
- **Issue:** `summary.state === 'completed'` block only marked task as done but never called `koService.applyResult()` — LLM recommendations would be discarded
- **Fix:** Replaced `latestResult` JSON parsing (non-existent field) with `manager.getWorkflowResult(workflowId)` call, then invoke `applyResult()` + `recordOptimizationPerformed()`
- **Files modified:** packages/openclaw-plugin/src/service/evolution-worker.ts
- **Verification:** TypeScript compiles clean, applyResult path exists on manager
- **Committed in:** f3191423 (part of evolution-worker wiring commit)

**3. [Rule: Missing API] getWorkflowResult() not available on CorrectionObserverWorkflowManager**
- **Found during:** Task 2 (evolution-worker.ts wiring)
- **Issue:** Manager.base class store is protected; evolution-worker needed a typed public method to retrieve parsed LLM results
- **Fix:** Added `getWorkflowResult(workflowId)` to CorrectionObserverWorkflowManager calling `this.driver.getResult()` + `correctionObserverWorkflowSpec.parseResult()`
- **Files modified:** packages/openclaw-plugin/src/service/subagent-workflow/correction-observer-workflow-manager.ts
- **Verification:** TypeScript compiles clean, method signature matches usage
- **Committed in:** f3191423 (part of evolution-worker wiring commit)

**4. [Rule: Blocking] TaskKind missing 'keyword_optimization' variant**
- **Found during:** Task 2 (evolution-worker.ts wiring)
- **Issue:** TypeScript error: `Type '"keyword_optimization"' is not assignable to type 'TaskKind'` — queue items with taskKind='keyword_optimization' would fail type check
- **Fix:** Added `'keyword_optimization'` to TaskKind union in trajectory-types.ts
- **Files modified:** packages/openclaw-plugin/src/core/trajectory-types.ts
- **Verification:** TypeScript compiles clean
- **Committed in:** f3191423 (part of evolution-worker wiring commit)

**5. [Rule: Type Safety] Static fields referenced without KeywordOptimizationService prefix**
- **Found during:** Task 1 (KeywordOptimizationService creation)
- **Issue:** TypeScript error: `Cannot find name '_instance'` — class static fields require `KeywordOptimizationService._instance` when referenced inside class methods
- **Fix:** Prefixed all static field references with `KeywordOptimizationService.` class name
- **Files modified:** packages/openclaw-plugin/src/service/keyword-optimization-service.ts
- **Verification:** TypeScript compiles clean
- **Committed in:** f3191423

**6. [Rule: Type Safety] TrajectoryHistoryEntry type used without import**
- **Found during:** Task 1 (KeywordOptimizationService creation)
- **Issue:** `CorrectionObserverPayload['trajectoryHistory']` type used without available import — circular dependency risk
- **Fix:** Changed to `TrajectoryHistoryEntry[]` (locally defined type) with import at bottom of file
- **Files modified:** packages/openclaw-plugin/src/service/keyword-optimization-service.ts
- **Verification:** TypeScript compiles clean
- **Committed in:** f3191423

**7. [Rule: Type Safety] Source type 'llm_optimization' not in CorrectionKeywordSource union**
- **Found during:** Task 1 (KeywordOptimizationService creation)
- **Issue:** TypeScript error: `'"llm_optimization"' is not assignable to type '"user" | "seed" | "llm"'`
- **Fix:** Changed `source: 'llm_optimization'` to `source: 'llm'`
- **Files modified:** packages/openclaw-plugin/src/service/keyword-optimization-service.ts
- **Verification:** TypeScript compiles clean
- **Committed in:** f3191423

---

**Total deviations:** 7 auto-fixed (all type safety / blocking correctness issues)
**Impact on plan:** All auto-fixes essential for compilation and runtime correctness. No scope creep.

## Issues Encountered
- **Subagent died mid-Task 2**: Agent completed Tasks 1-4 commits but died before finishing evolution-worker.ts integration. Orchestrator (this session) completed remaining work including the 7 auto-fixes above.
- **Subagent branch base mismatch**: Worktree was on `feature/correction-keyword-learning` but base was `main` HEAD. Resolved by rebasing worktree onto correct feature branch HEAD (`6d7089c7`).

## Next Phase Readiness
- KeywordOptimizationService complete and wired into evolution-worker
- CORR-12 flag chain verified (prompt.ts → trajectory → LLM payload)
- CorrectionObserverWorkflowManager.getWorkflowResult() available for LLM result retrieval
- Next phase can use KeywordOptimizationService.get() to dispatch optimization or call updateWeight()/remove() directly
