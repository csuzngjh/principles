# Architecture Research: YAML Runtime Integration

**Domain:** Workflow funnel runtime integration -- WorkflowFunnelLoader to RuntimeSummaryService
**Project:** v1.21.1 Workflow Funnel Runtime
**Researched:** 2026-04-19
**Confidence:** HIGH

---

## Executive Summary

The `WorkflowFunnelLoader` (defined in `src/core/workflow-funnel-loader.ts`) is fully implemented and serves as the SSOT for funnel stage definitions in `workflows.yaml`. However, it is not yet wired into `RuntimeSummaryService`, which currently derives funnel-related stats from hardcoded event type matching and `daily-stats.json` field paths. The integration task is: pass the loader's `Map<workflowId, WorkflowStage[]>` to `RuntimeSummaryService.getSummary()` so that YAML drives the stage-to-event mapping.

The architecture is straightforward: one new instantiation (in `evolution-status.ts`), one method signature change (`getSummary()` gains an optional `funnels` parameter), and YAML-driven stage aggregation added to the service. No new files are required. The build order is strictly linear: Loader import -> RuntimeSummaryService signature update -> evolution-status.ts wiring.

---

## Current Architecture

### System Overview

```
evolution-status.ts (command)
    │
    └── RuntimeSummaryService.getSummary(workspaceDir, { sessionId })
            │
            ├── [reads] events.jsonl          (pain signals, gate events)
            ├── [reads] daily-stats.json      (GFI peak, tool calls, evolution tasks)
            ├── [reads] sessions/*.json       (session GFI snapshots)
            ├── [reads] evolution-queue.json  (pending/in_progress/completed)
            ├── [reads] evolution-directive.json (legacy compatibility artifact)
            └── [reads] pain-flags.json        (active pain state)
            │
            [YAML stage definitions: NOT YET INTEGRATED]
```

### Component Responsibilities

| Component | Responsibility | Current State |
|-----------|----------------|---------------|
| `WorkflowFunnelLoader` | Loads `workflows.yaml` as SSOT; provides `getAllFunnels()`, `getStages()`, `watch()`; preserves last-valid on parse failure | **Exists, not wired** |
| `RuntimeSummaryService.getSummary()` | Aggregates runtime state from JSON files; builds `RuntimeSummary` object for display | Static method, no YAML dependency |
| `evolution-status.ts` | Command entry point; calls `RuntimeSummaryService`; formats bilingual output | Works, calls RuntimeSummaryService only |

### The Integration Gap

`WorkflowFunnelLoader` is fully implemented and tested in isolation. It is **not consumed by any other component**. `RuntimeSummaryService` currently builds funnel-related stats from raw event log data without referencing the YAML-defined stage structure.

---

## Target Architecture

### System Overview

```
evolution-status.ts (command)
    │
    ├── WorkflowFunnelLoader (stateDir)   [NEW: instantiated here, passed down]
    │       │
    │       └── workflows.yaml (SSOT)
    │
    └── RuntimeSummaryService.getSummary(workspaceDir, {
            sessionId,
            funnels: Map<string, WorkflowStage[]>  [NEW param]
        })
              │
              ├── [reads] events.jsonl          (raw event stream)
              ├── [reads] daily-stats.json      (aggregated stats)
              ├── [reads] sessions/*.json       (session snapshots)
              ├── [reads] evolution-queue.json  (queue state)
              ├── [reads] pain-flags.json        (pain state)
              │
              └── [uses] funnels: Map<string, WorkflowStage[]>
                        │
                        ├── Maps event type → stage definition
                        ├── Resolves statsField dot-paths for aggregation
                        └── Counts by eventCategory (completed/created/blocked)

workflows.yaml (SSOT)
    version: "1.0"
    funnels:
      - workflowId: "evolution"
        stages:
          - name: "nocturnal_dreamer_completed"
            eventType: "nocturnal_dreamer_completed"
            eventCategory: "completed"
            statsField: "evolution.nocturnalDreamerCompleted"
```

### Data Flow: Funnel Stage Resolution

```
1. evolution-status.ts creates WorkflowFunnelLoader(stateDir)
2. Loader reads workflows.yaml → builds Map<workflowId, WorkflowStage[]>
3. evolution-status.ts passes funnels to RuntimeSummaryService.getSummary(workspaceDir, { sessionId, funnels })
4. RuntimeSummaryService iterates stages:
     a. Filter events.jsonl entries matching stage.eventType
     b. Resolve stage.statsField dot-path into daily-stats.json
     c. Count by stage.eventCategory (completed/created/blocked)
5. Output: YAML-driven funnel display in evolution-status
```

---

## Integration Points

### Boundary 1: evolution-status.ts → WorkflowFunnelLoader

**Current (before):**
```typescript
// evolution-status.ts line 178
const summary = RuntimeSummaryService.getSummary(workspaceDir, { sessionId });
```

**After:**
```typescript
// evolution-status.ts
const funnelLoader = new WorkflowFunnelLoader(wctx.stateDir);
funnelLoader.watch(); // hot reload enabled
const summary = RuntimeSummaryService.getSummary(workspaceDir, {
  sessionId,
  funnels: funnelLoader.getAllFunnels(),  // Map<string, WorkflowStage[]>
});
```

**Notes:**
- `WorkflowFunnelLoader` is constructed with `stateDir` (same as `wctx.stateDir`)
- `watch()` is called here so the loader survives for the lifetime of the process
- `funnelLoader.dispose()` should be called on plugin shutdown (lifecycle hook)

### Boundary 2: RuntimeSummaryService -- funnel stage mapping

**Current (hardcoded):**
```typescript
// runtime-summary-service.ts -- Heartbeat Diagnostician section
heartbeatDiagnosis: {
  pendingTasks: pendingDiagTasks.length,
  tasksWrittenToday: diagDailyStats?.diagnosisTasksWritten ?? 0,
  reportsWrittenToday: diagDailyStats?.diagnosticianReportsWritten ?? 0,
  ...
}
```
Stages are derived from hardcoded field names in `daily-stats.json`.

**After (YAML-driven):**
```typescript
// runtime-summary-service.ts
interface FunnelStageStats {
  completed: number;
  created: number;
  blocked: number;
}

function aggregateStageFromEvents(
  events: EventLogEntry[],
  stage: WorkflowStage
): FunnelStageStats {
  const matching = events.filter(e => e.type === stage.eventType);
  return {
    completed: matching.filter(e => e.category === 'completed').length,
    created: matching.filter(e => e.category === 'created').length,
    blocked: matching.filter(e => e.category === 'blocked').length,
  };
}
```

### Boundary 3: YAML invalid state propagation

**Design principle (from workflow-funnel-loader.ts):**
- Missing file: loader returns empty Map; RuntimeSummaryService falls back to empty/none
- Malformed YAML: preserves last known-good config; warning logged
- Schema-invalid: same as malformed YAML

**Propagated warning mechanism:**
```typescript
// WorkflowFunnelLoader.load() logs:
//   `[WorkflowFunnelLoader] workflows.yaml validation failed...`

// RuntimeSummaryService carries YAML warnings in summary.metadata.warnings
// evolution-status.ts displays up to 12 warnings in the output
```

---

## Component Changes

### NEW: WorkflowFunnelLoader wiring in evolution-status.ts

| Item | Detail |
|------|--------|
| File | `packages/openclaw-plugin/src/commands/evolution-status.ts` |
| Change | Import `WorkflowFunnelLoader`; instantiate with `wctx.stateDir`; call `watch()`; pass `getAllFunnels()` to `RuntimeSummaryService` |
| Lifecycle | `dispose()` called on plugin shutdown via lifecycle hook |

### MODIFIED: RuntimeSummaryService

| Item | Detail |
|------|--------|
| File | `packages/openclaw-plugin/src/service/runtime-summary-service.ts` |
| Change | `getSummary()` signature: add optional `funnels?: Map<string, WorkflowStage[]>` parameter; use YAML stages for event filtering when provided |
| Backward compat | If `funnels` not provided, fall back to current hardcoded event type mapping |

### NO CHANGE: WorkflowFunnelLoader

The loader is already complete and correct. No modifications needed.

---

## Build Order

```
Step 1: WorkflowFunnelLoader import
        └── Add import to evolution-status.ts
            No other changes yet

Step 2: RuntimeSummaryService signature update
        └── Add funnels parameter to getSummary()
            Add stage aggregation helpers
            Keep fallback behavior when funnels absent

Step 3: evolution-status.ts wiring
        └── Instantiate loader, call watch(), pass funnels to getSummary()
            Add dispose() call in lifecycle hook

Step 4: YAML invalid state display test
        └── Verify warnings propagate correctly to evolution-status output
```

---

## Anti-Patterns to Avoid

### Anti-Pattern: Making RuntimeSummaryService own the loader

**Wrong:**
```typescript
// RuntimeSummaryService creates its own loader
class RuntimeSummaryService {
  private loader = new WorkflowFunnelLoader(stateDir);  // BAD: tight coupling
}
```

**Why:** Lifecycle of the loader (watch/dispose) should belong to the component that owns the process boundary, not a static utility.

**Correct:** Loader is instantiated at the call site (evolution-status.ts) and passed as data.

### Anti-Pattern: Blocking on invalid YAML

**Wrong:** Throw error on malformed YAML, crashing the summary.

**Correct (already implemented in WorkflowFunnelLoader):** Preserve last-known-good config, log warning. RuntimeSummaryService proceeds with empty funnel map.

### Anti-Pattern: Re-reading YAML on every summary call

**Wrong:** `getSummary()` reads the file each time it is called.

**Correct:** WorkflowFunnelLoader maintains an in-memory cache. Only `load()` re-reads from disk (on startup or FSWatcher trigger). `getSummary()` calls `getAllFunnels()` which returns the cached Map.

---

## Scalability Considerations

| Scale | Impact | Approach |
|-------|--------|----------|
| 10s of funnel definitions | Memory: Map holds ~10 workflow IDs, each with a few stages | Negligible; Map is tiny |
| 1000s of events per day | Event log scan iterates all events for stage matching | O(n) scan is acceptable for <10K events; consider indexing by type if >50K |
| Hot reload frequency | FSWatcher debounces at 100ms | Sufficient; YAML changes are rare |

---

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` -- loader implementation (170 lines)
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` -- current summary service (810 lines)
- `packages/openclaw-plugin/src/commands/evolution-status.ts` -- command entry point (211 lines)

### Templates
- `~/.claude/get-shit-done/templates/research-project/ARCHITECTURE.md`

---

*Architecture research for: v1.21.1 YAML Runtime Integration*
*Researched: 2026-04-19*
*Confidence: HIGH*
