# Feature Research: YAML-Driven Runtime Summary

**Domain:** Workflow funnel observability (YAML-SSOT + event-log driven)
**Project:** Principles Disciple — v1.21.1 Workflow Funnel Runtime
**Researched:** 2026/04/19
**Confidence:** HIGH (code-based, no external research needed — wiring existing patterns)

---

## Feature Landscape

### Table Stakes (Users Expect These)

Users running `/pd-evolution-status` expect the output to reflect the actual funnel state defined in `workflows.yaml`. Missing these makes the command feel like a demo rather than a live system.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| YAML-defined funnel stages visible in status | Developer edited `workflows.yaml`; expects status to reflect it | LOW | Wiring: feed `WorkflowFunnelLoader.getStages()` into `RuntimeSummaryService` for funnel display |
| Hot-reload reflects in status without restart | Edited YAML -> next status call shows new funnel | LOW | `WorkflowFunnelLoader.watch()` already debounces at 100ms; status query reads fresh data on next call |
| Degraded state when YAML is missing/invalid | Graceful fallback, not crash | LOW | `WorkflowFunnelLoader` semantics: missing file -> empty Map; parse error -> last known-good preserved |
| Funnel stage counts from event-log | Pipeline stages should show progress (e.g., `nocturnal_dreamer_completed: 3`) | MEDIUM | `event-log.ts` records `nocturnal_dreamer_completed`, `diagnostician_report`, `principle_candidate`, etc. `aggregateStats()` already counts by event type. Integration = feed `WorkflowStage.eventType` -> count from event-log stats |

### Differentiators (Competitive Advantage)

These are where the YAML-SSOT approach pays off vs. hardcoded fallback.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Developer-defined funnel without code changes | Power users define new pipelines in YAML, see them in status | LOW | `workflows.yaml` in `.state/` is developer-maintained; no plugin redeploy needed |
| Funnel stage counts per workflowId | Observability into which pipeline is healthy vs stalled | MEDIUM | Each `WorkflowFunnel` has `workflowId`; `RuntimeSummaryService` can scope event counts to a specific workflow by filtering events with matching `workflowId` in event data |
| Multiple funnels (heartbeat_diagnosis, nocturnal, rulehost) shown distinctly | Separate concerns visible in one status output | LOW | `getAllFunnels()` returns `Map<workflowId, stages[]>`. Already separated in `evolution-status.ts` display (heartbeatDiagnosis section vs evolution section) |
| Event category filtering in stage counts | Stage `eventCategory` ('completed', 'blocked', 'created') narrows counts to specific outcomes | LOW | `WorkflowStage.eventCategory` available in YAML schema; event-log already categorizes events (`completed`, `created`, `blocked`) |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Auto-register new funnel stages from event types | "I want the system to discover new stages automatically" | Defeats YAML-as-SSM intent; creates drift between what events exist and what developer intended | Keep YAML developer-maintained; events are the data, YAML is the interpretation |
| Real-time streaming of funnel updates in status | "Status should update as events happen" | Requires persistent connection or polling; `/pd-evolution-status` is a CLI command, not a dashboard | Document that each invocation reads current state; event-log flush latency is the practical update frequency |
| Write back to `workflows.yaml` from plugin | "Plugin should auto-fix missing stages" | Code should read YAML, never write it (per D-04 contract) | Keep YAML developer-authored; emit warning if runtime references a stage not defined in YAML |

---

## Feature Dependencies

```
WorkflowFunnelLoader (workflows.yaml read)
    │
    ├──getAllFunnels()──> RuntimeSummaryService
    │                           │
    │                     Funnel stage counts
    │                           │         computed from
    │                           ▼         event-log stats
event-log.ts ◄──────────── aggregateStats()
   │
   │ records events:
   │   nocturnal_dreamer_completed
   │   diagnostician_report
   │   principle_candidate
   │   heartbeat_diagnosis
   │   rulehost_evaluated
   │
   └──> events.jsonl (persisted)
             │
             └──> read by RuntimeSummaryService.getSummary()
```

**Dependency notes:**

- `RuntimeSummaryService` depends on `WorkflowFunnelLoader` only for stage definitions (what to count). It already owns event-log reading.
- `event-log.ts` is independent — records events from callers but has no dependency on the funnel loader.
- Hot-reload chain: `WorkflowFunnelLoader.watch()` -> `load()` -> in-memory Map updated -> next `RuntimeSummaryService.getSummary()` call reads new stages.

---

## MVP Definition

### Launch With (v1.21.1)

- [ ] **WorkflowFunnelLoader wired into RuntimeSummaryService** — `getAllFunnels()` drives funnel section of summary instead of hardcoded fallback. No new event types, no new patterns.
- [ ] **Hot-reload visible on next status call** — After editing `workflows.yaml`, running `/pd-evolution-status` shows updated funnel stages. No process restart.
- [ ] **Graceful degraded states documented** — Missing YAML -> empty funnel display with warning. Malformed YAML -> last valid config used, warning emitted.

### Add After Validation (v1.x)

- [ ] **Per-workflowId event counts** — Filter `event-log` stats by `workflowId` field in event data so nocturnal vs heartbeat vs rulehost funnel counts are isolated.
- [ ] **`statsField` dot-path resolution** — Each `WorkflowStage` has a `statsField` (e.g., `evolution.nocturnalDreamerCompleted`). Wire this to read from `aggregateStats()` output directly, making stage counts authoritative rather than inferred from event type matching.

---

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| YAML-defined stages in status | HIGH — core value of SSOT approach | LOW — wiring existing code | P1 |
| Hot-reload (no restart) | MEDIUM — nice to have | LOW — already implemented in loader | P1 |
| Graceful degradation (missing/invalid YAML) | MEDIUM — prevents crashes | LOW — already implemented in loader | P1 |
| Per-workflowId event filtering | LOW — most users have one workflow | MEDIUM — requires event data schema consistency | P2 |
| `statsField` dot-path resolution | LOW — inferred counts already work | MEDIUM — adds indirection | P3 |

**Priority key:**
- P1: Must have for launch
- P2: Should have, add when possible
- P3: Nice to have, future consideration

---

## Complexity Notes: This Is Wiring, Not Building

The v1.21.1 integration is **low complexity** because:

1. **No new patterns** — `WorkflowFunnelLoader` is already implemented with documented failure semantics. `event-log.ts` already records funnel-relevant events. `RuntimeSummaryService` already aggregates stats.
2. **Data flow already exists** — `evolution-status.ts` already calls `RuntimeSummaryService.getSummary()`. The change is that funnel stage definitions come from `WorkflowFunnelLoader` instead of hardcoded fallback.
3. **Hot-reload already works** — `fs.watch` with 100ms debounce is already in `WorkflowFunnelLoader.watch()`. No new reload mechanism needed.
4. **Graceful degradation already implemented** — Missing file and parse error handling are already documented in the loader's docstring (lines 56-59) and implemented in `load()`.

**The primary work is:** wire `WorkflowFunnelLoader` into `RuntimeSummaryService` so that `getSummary()` reads funnel definitions from the loader rather than returning hardcoded fallback structure.

---

## Sources

- `packages/openclaw-plugin/src/core/workflow-funnel-loader.ts` — WorkflowFunnelLoader implementation, failure semantics, hot-reload (fs.watch 100ms debounce)
- `packages/openclaw-plugin/src/core/event-log.ts` — Event types, `aggregateStats()` counting by event type
- `packages/openclaw-plugin/src/service/runtime-summary-service.ts` — Current hardcoded fallback structure, event reading, daily stats aggregation
- `packages/openclaw-plugin/src/commands/evolution-status.ts` — `/pd-evolution-status` command, display sections (heartbeatDiagnosis, evolution, gate, pain)
- `packages/openclaw-plugin/src/types/event-types.ts` — Event type definitions (nocturnal_dreamer_completed, heartbeat_diagnosis, diagnostician_report, etc.)

---
*Feature research for: YAML-driven funnel runtime integration*
*Researched: 2026/04/19*
