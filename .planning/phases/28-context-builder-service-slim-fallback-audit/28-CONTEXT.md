# Phase 28: Context Builder + Service Slim + Fallback Audit - Context

**Gathered:** 2026-04-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract context building, session lifecycle, and fallback snapshot logic into dedicated modules (TaskContextBuilder + SessionTracker), reduce evolution-worker.ts to pure lifecycle orchestration (start/stop/runCycle), and comprehensively audit all 16 silent fallback points — classifying each as fail-fast (boundary entry) or fail-visible (pipeline middle).

**Scope:**
- TaskContextBuilder: context extraction, fallback snapshot building, session filtering coordination
- SessionTracker: session lifecycle management (initPersistence, flushAllSessions) as a separate module
- Worker slim: evolution-worker.ts contains only service lifecycle orchestration, delegating all work to extracted modules
- Fallback audit: classify all 16 silent fallback points as fail-fast or fail-visible
- CONTRACT-03: every extracted module has input validation following v1.13 factory/validator pattern
- CONTRACT-05: all fail-visible points emit EventLog structured skip/drop events

**NOT in scope:**
- Replay engine contract hardening (deferred to next milestone)
- Dictionary/rule matching contracts

</domain>

<decisions>
## Implementation Decisions

### Module Architecture
- **D-01:** Session lifecycle extracted into a **separate SessionTracker class** (not folded into TaskContextBuilder). TaskContextBuilder coordinates context + snapshot; SessionTracker manages initPersistence/flushAllSessions lifecycle. Cleaner separation of concerns.

### Context Building
- **D-02:** TaskContextBuilder follows the Phase 24/26 class pattern: `new TaskContextBuilder(workspaceDir)`, async entry methods returning structured results.

### Fallback Event Structure
- **D-03:** Fail-visible skip/drop events use the **existing EventLog.recordRuleMatch() pattern** — reuse `eventLog.recordSkip()` / `eventLog.recordDrop()` calls with structured payload. No new event type needed; EventLog consumer infrastructure processes these directly.

### Fallback Audit Scope
- **D-04:** **Comprehensive audit** — all 16 silent fallback points identified and classified, regardless of which phase originally addressed them. Each fallback gets explicit fail-fast (boundary entry) or fail-visible (pipeline middle) classification.

### Worker Slim Pattern
- **D-05:** Worker reduced to **pure lifecycle orchestration only**: start/stop/runCycle. Each extracted module (QueueStore, PainFlagDetector, TaskDispatcher, WorkflowOrchestrator, TaskContextBuilder, SessionTracker) is instantiated and called within runCycle. No business logic remains inline in the worker.

### Validation Pattern
- **D-06:** Every extracted module (TaskContextBuilder, SessionTracker) has **input validation at entry points** following v1.13 factory/validator pattern (CONTRACT-03 satisfied). Permissive validation (required fields only).

### Error Handling
- **D-07:** Errors returned in structured result objects — never thrown at module boundaries. Internal errors caught and returned in `result.errors`. Consistent with Phase 24/25/26/27 pattern.

### Claude's Discretion
- Internal method names and private helper organization within TaskContextBuilder and SessionTracker
- Exact placement of session lifecycle calls (which module initializes/flushes)
- How "snapshot building" handles missing/unavailable services (graceful degradation approach)
- Which of the 16 fallback points are fail-fast vs fail-visible (planner determines based on code inspection)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Contract Patterns (v1.13 templates)
- `packages/openclaw-plugin/src/core/pain.ts` — Factory function + validator pattern (buildPainFlag, readPainFlagContract)
- `packages/openclaw-plugin/src/core/nocturnal-snapshot-contract.ts` — Structured validation result pattern ({status, reasons, snapshot})

### Existing Extracted Modules (patterns to follow)
- `packages/openclaw-plugin/src/service/evolution-queue-store.ts` — Phase 24: class pattern, permissive validation, internal lock management
- `packages/openclaw-plugin/src/service/pain-flag-detector.ts` — Phase 25: class pattern, factory/validator entry
- `packages/openclaw-plugin/src/service/evolution-task-dispatcher.ts` — Phase 26: class pattern, structured DispatchResult
- `packages/openclaw-plugin/src/service/workflow-orchestrator.ts` — Phase 27: class pattern, permissive validation at entry

### Existing Code to Extract From
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — Source file (393 lines after Phases 24-27). Context building at L213 (WorkspaceContext.fromHookContext). Session lifecycle at L216 (initPersistence), L342/L391 (flushAllSessions).
- `packages/openclaw-plugin/src/core/workspace-context.ts` — WorkspaceContext class (cached singleton per workspaceDir, lazy-loaded services)

### Session Infrastructure
- `packages/openclaw-plugin/src/core/session-tracker.js` — initPersistence, flushAllSessions functions

### Event Logging
- `packages/openclaw-plugin/src/core/event-log.ts` — EventLog interface with recordRuleMatch method (reuse for skip/drop events)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- EventLog.recordRuleMatch() — existing event recording pattern, already in use for rule matches, ideal for skip/drop events
- WorkspaceContext singleton — cached per workspaceDir with lazy-loaded services, TaskContextBuilder wraps and extends this
- Session tracker functions (initPersistence, flushAllSessions) — already have clear lifecycle boundaries

### Established Patterns
- **Class pattern:** Constructor takes workspaceDir, methods return structured results with `errors: string[]`
- **Permissive validation:** Required fields only, ignore unknowns for forward compatibility
- **Backward-compatible re-exports:** Each extracted module exports types and the class itself from evolution-worker.ts
- **Short-lived instances:** Modules instantiated per-call or per-cycle, not held in memory long-term

### Integration Points
- Worker start() → SessionTracker.init() + TaskContextBuilder.build()
- Worker runCycle() → PainFlagDetector, EvolutionQueueStore, EvolutionTaskDispatcher, WorkflowOrchestrator, TaskContextBuilder all called per-cycle
- Worker stop() → SessionTracker.stop() (flushAllSessions)
- TaskContextBuilder → WorkspaceContext, EventLog, TrajectoryDatabase (for fallback snapshots)

</code_context>

<specifics>
## Specific Ideas

- Fail-visible classification: detection queue with no matches = fail-visible (not an error, but should be recorded as skip in EventLog)
- Session initialization: initPersistence called once at worker start, flushAllSessions called at end of each cycle AND on worker stop
- Snapshot building: when trajectory database is unavailable, build a minimal fallback snapshot rather than failing entirely

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 28-context-builder-service-slim-fallback-audit*
*Context gathered: 2026-04-11*
