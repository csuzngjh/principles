---
gsd_state_version: 1.0
milestone: v1.21.2
milestone_name: YAML Funnel 完整 SSOT
status: shipped
last_updated: "2026-04-19T19:10:00.000Z"
last_activity: 2026-04-19 — Milestone v1.21.2 shipped
progress:
  total_phases: 3
  completed_phases: 3
  total_plans: 3
  completed_plans: 3
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** Planning next milestone

## Current Position

Milestone v1.21.2 (YAML Funnel SSOT) shipped 2026-04-19.
All phases complete: Phase 5 (Runtime Wiring) + Phase 6 (Display Wiring) + Phase 7 (Integration Testing).

**Next:** `/gsd-new-milestone` to start planning next milestone

## Context

v1.21.2 shipped with:
- `workflows.yaml` genuinely drives `/pd-evolution-status` funnel display
- getSummary() consumes funnels Map, builds workflowFunnels from YAML stage definitions
- Display layer YAML-driven (labels + stage order from YAML)
- Graceful degraded mode for missing/invalid YAML
- 3 E2E integration tests pass (13/13 total)

## Archived Milestones

- v1.21.2: `.planning/milestones/v1.21.2-ROADMAP.md`, `.planning/milestones/v1.21.2-REQUIREMENTS.md`
- v1.21.1: Workflow Funnel Scaffold (Phase 3-4)
- v1.21: PD 工作流可观测化 (Phase 1-2)

## Next

**Command:** `/gsd-new-milestone`

---

*Last updated: 2026-04-19 after v1.21.2 milestone shipped*
