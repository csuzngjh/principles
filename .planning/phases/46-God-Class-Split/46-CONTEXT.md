# Phase 46: God Class Split - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract focused modules from `evolution-worker.ts` (2722L) and `nocturnal-trinity.ts` (2429L) to enable independent testing and reduce merge conflicts. This is the final phase of v1.19 Tech Debt Remediation.

**SPLIT-01:** Extract `queue-migration.ts` from `evolution-worker.ts`
**SPLIT-02:** Extract `workflow-watchdog.ts`
**SPLIT-03:** Extract `queue-io.ts` — file I/O for queue persistence
**SPLIT-04:** Add `withQueueLock()` RAII-style guard
**SPLIT-05:** Extract `sleep-cycle.ts` — orchestrator for enqueue/keyword-optimization tasks
**SPLIT-06:** Keep `evolution-worker.ts` as permanent facade/re-export layer
**SPLIT-07:** Defer `nocturnal-trinity.ts` split to future milestone

</domain>

<decisions>
## Implementation Decisions

### SPLIT-05: Sleep-cycle inclusion
- **D-01:** Include `sleep-cycle.ts` extraction in Phase 46 (SPLIT-05)
- **D-02:** SPLIT-05 is separate from SPLIT-07 (nocturnal-trinity.ts split deferred) — sleep-cycle is an orchestrator concern that lives in `evolution-worker.ts`, not inside `nocturnal-trinity.ts`

### BUG-01/02/03: Bug fix scope
- **D-03:** Fix all three bugs within Phase 46 as part of the split work
- **D-04:** BUG-01: Watchdog marks stale workflows as `terminal_error` after 2x TTL — fix must be verified in extracted `workflow-watchdog.ts`
- **D-05:** BUG-02: Gateway-safe fallback for child session cleanup — verify works after queue split
- **D-06:** BUG-03: Timeout recovery logic (#214/#219) — verify still works after queue split

### queue-io.ts scope
- **D-07:** `queue-io.ts` is a **full persistence layer** — encapsulates locking (`acquireQueueLock`), atomic writes (`atomicWriteFileSync`), and queue file format (loadEvolutionQueue/saveEvolutionQueue)
- **D-08:** Not a thin I/O wrapper — the module provides the complete queue persistence contract
- **D-09:** `withQueueLock()` RAII-style guard (SPLIT-04) is part of queue-io.ts — ensures locks are always released even on exceptions

### Extraction order
- **D-10:** Extract in this order: queue-migration → workflow-watchdog → queue-io → sleep-cycle
- **D-11:** queue-migration first: most isolated concern, smallest boundary, no dependencies on other extractions
- **D-12:** workflow-watchdog second: SPLIT-02 prerequisite for BUG-01 fix
- **D-13:** queue-io third: depends on both queue-migration and workflow-watchdog being extracted first
- **D-14:** sleep-cycle last: orchestrates enqueue/keyword-optimization tasks, depends on queue-io

### evolution-worker.ts facade
- **D-15:** `evolution-worker.ts` becomes a permanent facade/re-export layer (SPLIT-06) — stable import point, no new logic added
- **D-16:** All imports from `evolution-worker.ts` continue to work after split (backward-compatible re-exports)

### Tests
- **D-17:** Existing queue tests from Phase 45 (`evolution-worker.queue.test.ts`, `queue-purge.test.ts`, `async-lock.test.ts`) validate extracted behavior
- **D-18:** Each extracted module must have its own unit test file alongside it

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source files under extraction
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — 2722 lines, primary extraction target
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — 2429 lines, SPLIT-05 sleep-cycle extracted from here

### Phase 44 Pre-Split Inventory
- `.planning/phases/44-Pre-Split-Inventory/44-MUTABLE-STATE-INVENTORY.md` — mutable state inventory for god class candidates
- `.planning/phases/44-Pre-Split-Inventory/44-CONTEXT.md` — decisions from Phase 44

### Phase 45 Queue Tests (validation baseline)
- `packages/openclaw-plugin/tests/service/evolution-worker.queue.test.ts` — loadEvolutionQueue/saveEvolutionQueue tests
- `packages/openclaw-plugin/tests/core/queue-purge.test.ts` — purgeStaleFailedTasks tests
- `packages/openclaw-plugin/tests/queue/async-lock.test.ts` — asyncLockQueues concurrency tests

### Requirements
- `.planning/REQUIREMENTS.md` — SPLIT-01..07, BUG-01..03 requirements text
- `.planning/ROADMAP.md` — Phase 46 description and success criteria

### Bug references
- BUG-01: Issue #185 — watchdog marks stale workflows as `terminal_error` after 2x TTL
- BUG-02: Issue #188 — gateway-safe fallback for child session cleanup
- BUG-03: Issues #214/#219 — timeout recovery logic

### Key source functions
- `acquireQueueLock` (evolution-worker.ts line 491) — lock acquisition for queue files
- `loadEvolutionQueue` (evolution-worker.ts line 721) — queue file read
- `saveEvolutionQueue` (evolution-worker.ts line 763) — queue file write
- `atomicWriteFileSync` (io.ts) — atomic file write utility
- `purgeStaleFailedTasks` (evolution-worker.ts line 554) — failed task cleanup
- `hasRecentDuplicateTask` (evolution-worker.ts line 595) — deduplication check

</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `atomicWriteFileSync` from `utils/io.ts` — already proven atomic write utility
- `acquireQueueLock` from `evolution-worker.ts` — existing lock acquisition pattern
- Phase 45 queue tests — validate queue behavior that queue-io.ts will encapsulate

### Established Patterns
- Module extraction: new module in `src/core/` or `src/service/`, re-export from original location
- RAII-style lock guards: TypeScript `try/finally` pattern with `acquireQueueLock` returning a release function
- Facade pattern: original file becomes re-export layer, all imports continue to work

### Integration Points
- `queue-io.ts` replaces direct `fs.readFileSync`/`fs.writeFileSync` calls in `evolution-worker.ts`
- `workflow-watchdog.ts` uses `EvolutionQueueItem` types from `evolution-types.ts`
- `sleep-cycle.ts` calls `enqueueKeywordOptimization` and related enqueue functions

</codebase_context>

<specifics>
## Specific Ideas

- queue-io.ts should expose: `loadQueue(path)`, `saveQueue(path, items)`, `withQueueLock(path, fn)`
- workflow-watchdog.ts should expose: `watchWorkflow(workflow, ttl)`, `markStale(workflowId)`
- sleep-cycle.ts should expose: `runSleepCycle(workspaceId)`, `enqueueKeywordOptimization(workspaceId)`
- All extracted modules go in `src/service/` (same directory as evolution-worker.ts) or `src/core/`

</specifics>

<deferred>
## Deferred Ideas

None — all SPLIT requirements addressed within this phase

### SPLIT-07 Deferral Note
`nocturnal-trinity.ts` split is deferred to a future milestone (internally cleaner than evolution-worker.ts, lower priority). The sleep-cycle.ts extraction (SPLIT-05) does NOT extract from nocturnal-trinity.ts — it extracts from evolution-worker.ts where the sleep-cycle orchestration logic lives.

</deferred>

