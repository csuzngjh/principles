# State

## Project Reference

See: .planning/PROJECT.md (updated 2026-04-05)

**Core value:** 自演化 AI 代理通过痛点信号学习并通过显式原则表达实现自我改进。
**Current Milestone:** v1.5 (Nocturnal Helper 重构)
**Current Focus:** Phase 6 — Foundation and Single-Reflector Mode

---

## Current Position

Phase: Phase 6 (started)
Plan: .planning/ROADMAP.md
Status: Planning complete — implementing Phase 6
Last activity: 2026-04-05 — Roadmap defined

---

## Phase Progress

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| Phase 6 | Foundation and Single-Reflector Mode | Pending | NOC-01, NOC-02, NOC-03, NOC-04, NOC-05 |
| Phase 7 | Trinity Integration with Event Recording | Pending | NOC-06, NOC-07, NOC-08, NOC-09, NOC-10 |
| Phase 8 | Intermediate Persistence and Idempotency | Pending | NOC-11, NOC-12, NOC-13 |
| Phase 9 | Fallback and Evolution Worker Integration | Pending | NOC-14, NOC-15, NOC-16 |

---

## Accumulated Context

- Nocturnal uses `OpenClawTrinityRuntimeAdapter` directly (not via WorkflowManager)
- Trinity has 3 stages: Dreamer → Philosopher → Scribe
- Each stage: run subagent → wait → getSessionMessages → parse output
- Empathy/DeepReflect already migrated to helper pattern
- Diagnostician: DO NOT TOUCH (刚跑通)
- NocturnalWorkflowManager is a NEW file in `subagent-workflow/`
- Trinity bypasses WorkflowManager state machine — must fix in Phase 7
- TransportDriver NOT used for Trinity — manager composes TrinityRuntimeAdapter directly via options
- Do NOT add `'trinity'` to `WorkflowTransport` union type

---

## Key Constraints

- No new dependencies — all existing modules
- NocturnalWorkflowManager does NOT extend EmpathyObserverWorkflowManager
- Manager composes `TrinityRuntimeAdapter` directly, not via TransportDriver
- Fallback degrades to stub (not EmpathyObserver/DeepReflect)

---

*Last updated: 2026-04-05 after roadmap created*
