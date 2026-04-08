---
gsd_state_version: 1.0
milestone: v1.9.0
milestone_name: Principle Internalization System
status: in_progress
last_updated: "2026-04-08T02:23:53.115Z"
last_activity: 2026-04-08 -- Phase 15-01 execution complete
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 10
  completed_plans: 9
  percent: 90
---

# State

## Project Reference

See `.planning/PROJECT.md` (updated 2026-04-07 after starting v1.9.0 milestone).

**Core value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization
**Current Milestone:** v1.9.0 - Principle Internalization System
**Current Focus:** Phase 15-02 routing policy remains after shipping the lifecycle metrics foundation in 15-01

---

## Current Position

Phase: 15
Plan: 15-02 pending
Last activity: 2026-04-08 -- completed 15-01 lifecycle evidence and metrics execution

---

## Milestone Goal

Turn the current principle / nocturnal / gate concepts into a concrete Principle Internalization System with:

- first-class Rule and Implementation entities
- constrained runtime code implementations
- replay-driven promotion and rollback
- nocturnal code candidate generation
- coverage and adherence accounting

---

## Immediate Next Steps

1. Execute `15-02-PLAN.md` to build the explicit `skill | code | defer` routing policy and lifecycle integration surface
2. Reuse the 15-01 lifecycle service outputs instead of recomputing raw replay and lineage evidence ad hoc
3. Preserve regression checks for replay classification and Phase 14 nocturnal candidate semantics while completing Phase 15

---

## Previous Milestone Summary

**Last shipped milestone:** v1.5 Nocturnal Helper 重构  
**Shipped:** 2026-04-06  
**Phases:** 6-10 (5 phases, 7 plans)

Key deliverables:

- NocturnalWorkflowManager with WorkflowManager interface
- Trinity chain (Dreamer -> Philosopher -> Scribe) with event recording
- WorkflowStore stage_outputs for persistence and idempotency
- Stub-based fallback on Trinity failure (NOC-15)
- evolution-worker integrated with NocturnalWorkflowManager

---

## Accumulated Context

- Nocturnal uses `OpenClawTrinityRuntimeAdapter` directly (not via WorkflowManager)
- Trinity has 3 stages: Dreamer -> Philosopher -> Scribe
- Each stage: run subagent -> wait -> getSessionMessages -> parse output
- Empathy/DeepReflect migrated to helper pattern
- Diagnostician remains a sensitive path and should not be casually refactored
- NocturnalWorkflowManager is in `subagent-workflow/`
- Trinity bypasses WorkflowManager state machine - fixed in v1.5
- Stub fallback degrades to stub (not EmpathyObserver/DeepReflect)
- Do NOT add `'trinity'` to `WorkflowTransport` union type
- Principle Tree Architecture and Principle Internalization System design docs are now the framing for the next milestone
- Progressive Gate remains in place for v1.9.0 as a host hard-boundary layer
- `message-sanitize.ts` is the planned first simplification target before Rule Host integration
- Phase 14 planning is complete with a two-wave split:
- `14-01` locks Artificer semantics, deterministic `principle -> rule` targeting, and pure validation
- `14-02` wires candidate persistence and nocturnal-service integration while preserving behavioral artifact semantics
- `14-01` shipped deterministic Artificer routing that skips ambiguous rule resolution instead of guessing
- `14-01` shipped a pure local validator that reuses RuleHost-compatible export and result semantics
- `14-01` introduced a separate nocturnal artifact-kind lineage registry so replay classifications stay behavioral-only
- `14-02` shipped nocturnal-service sidecar persistence so one nocturnal run can keep a behavioral artifact and optionally emit a `candidate` code implementation
- `14-02` writes candidate provenance into both implementation manifests and append-only nocturnal lineage records, including principle, rule, snapshot, pain, gate, and session refs
- `14-02` cleans up ledger plus storage deterministically if candidate asset persistence fails after ledger creation
- Phase 15 planning is complete with a two-wave split:
- `15-01` builds deterministic lifecycle evidence, rule/principle metrics, and deprecated-readiness assessment
- `15-02` builds explicit internalization route recommendations without executing routes or adding auto-promotion
- `15-01` shipped a lifecycle read-model that joins ledger entities, latest replay reports, and nocturnal lineage without mutating state
- `15-01` shipped replay-first `coverageRate` / `falsePositiveRate` calculators, principle adherence persistence, and structured deprecated-readiness scoring

---

## Key Constraints

- No new dependencies - all existing modules
- NocturnalWorkflowManager does NOT extend EmpathyObserverWorkflowManager
- Manager composes `TrinityRuntimeAdapter` directly, not via TransportDriver
- Fallback degrades to stub (not EmpathyObserver/DeepReflect)
- Do not auto-deploy code implementations before offline replay and manual promotion
- Do not collapse Principle / Rule / Implementation into a single script layer

---

*Last updated: 2026-04-08 after completing Phase 15-01*
