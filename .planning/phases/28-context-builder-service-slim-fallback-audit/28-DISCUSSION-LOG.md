# Phase 28: Context Builder + Service Slim + Fallback Audit - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-11
**Phase:** 28-context-builder-service-slim-fallback-audit
**Areas discussed:** TaskContextBuilder scope, Fallback event structure, Silent fallback audit

---

## Area 1: TaskContextBuilder Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Include session lifecycle in TaskContextBuilder | TaskContextBuilder owns WorkspaceContext + session init/flush. Worker just calls builder.start()/stop(). | |
| Session lifecycle stays in worker | TaskContextBuilder does context + snapshot only. Worker handles initPersistence/flushAllSessions. Cleaner worker slim-down. | |
| **Create separate SessionTracker module** | **Extract session lifecycle into its own SessionTracker class. TaskContextBuilder uses it. Worker orchestrates both. Maximum decomposition.** | **✓** |

**User's choice:** Create separate SessionTracker module
**Notes:** Maximum decomposition preferred — SessionTracker owns initPersistence/flushAllSessions lifecycle. TaskContextBuilder focuses on context building and snapshot management.

---

## Area 2: Fallback Event Structure

| Option | Description | Selected |
|--------|-------------|----------|
| **EventLog.recordRuleMatch() style (already used)** | **Reuse EventLog.recordRuleMatch() pattern — fail-visible points call eventLog.recordSkip()/recordDrop() with structured payload. Existing EventLog consumer infrastructure can process these.** | **✓** |
| Dedicated skip/drop event types in EventLog | Add dedicated skip/drop event types to EventLog schema (recordSkip, recordDrop methods). Cleaner than overloading recordRuleMatch. Requires EventLog schema change. | |
| Structured logger output only | Emit structured {type, reason, context} log messages via PluginLogger. No EventLog change needed. | |
| Return values with skip/drop classification | Return structured {status: 'skipped'|'dropped', reason, context} from entry points. | |

**User's choice:** EventLog.recordRuleMatch() style (reuse existing pattern)
**Notes:** Simplest approach — reuse existing EventLog infrastructure rather than creating new event types.

---

## Area 3: Silent Fallback Audit

| Option | Description | Selected |
|--------|-------------|----------|
| **Audit all 16 comprehensively** | **Find all fallback points systematically across the codebase. Classify each as fail-fast or fail-visible. Apply EventLog strategy uniformly. Most thorough.** | **✓** |
| Focus on worker entry points and dispatcher | Focus on worker entry points (start/runCycle) and EvolutionTaskDispatcher — highest traffic paths. | |
| Focus on queue load and trajectory search | Focus on queue load (corruption) and trajectory search (no-results-silent) — highest data-integrity risk areas. | |
| Trust phases 24-27, audit only remaining worker code | Assume phases 24-27 addressed queue, pain, dispatcher, workflow fallbacks. Only audit what remains in the 393-line worker. | |

**User's choice:** Audit all 16 comprehensively
**Notes:** Full audit regardless of which phase may have addressed each point. Need complete classification to satisfy CONTRACT-04.

---

## Area 4: (No 4th area discussed)

User selected "Discuss all 4 areas" but the 4th gray area (silent fallback audit) was the 3rd discussed. No additional areas were raised.

---

## Decisions Summary

- **SessionTracker**: Separate module from TaskContextBuilder. Owns session lifecycle (initPersistence/flushAllSessions).
- **Fallback events**: Reuse EventLog.recordRuleMatch() style — recordSkip/recordDrop with structured payload.
- **Fallback audit**: Comprehensive — all 16 silent fallback points identified and classified as fail-fast or fail-visible.
- **Worker slim**: Pure lifecycle orchestration only. All work delegated to extracted modules.
- **Validation**: All extracted modules use v1.13 factory/validator pattern with permissive validation.
