---
gsd_state_version: 1.0
milestone: v1.9.0
milestone_name: Principle Internalization System
status: Defining requirements
last_updated: "2026-04-07T00:00:00.000Z"
last_activity: 2026-04-07
progress:
  total_phases: 5
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# State

## Project Reference

See `.planning/PROJECT.md` (updated 2026-04-07 after starting v1.9.0 milestone).

**Core value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization
**Current Milestone:** v1.9.0 - Principle Internalization System
**Current Focus:** Defining requirements and roadmap for rule / implementation ledger, Rule Host, replay-based promotion, and nocturnal code artifacts

---

## Current Position

Phase: Not started (defining requirements)  
Plan: - Status: Defining requirements  
Last activity: 2026-04-07 - Milestone v1.9.0 started

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

1. Define milestone requirements in `.planning/REQUIREMENTS.md`
2. Create roadmap phases 11-15 in `.planning/ROADMAP.md`
3. Begin with principle tree ledger entity support and host-boundary cleanup

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

---

## Key Constraints

- No new dependencies - all existing modules
- NocturnalWorkflowManager does NOT extend EmpathyObserverWorkflowManager
- Manager composes `TrinityRuntimeAdapter` directly, not via TransportDriver
- Fallback degrades to stub (not EmpathyObserver/DeepReflect)
- Do not auto-deploy code implementations before offline replay and manual promotion
- Do not collapse Principle / Rule / Implementation into a single script layer

---

*Last updated: 2026-04-07 after starting v1.9.0 milestone*
