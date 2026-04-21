---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: milestone
status: Phase 1 complete
last_updated: "2026-04-21T21:30:00.000Z"
last_activity: 2026-04-21 — Phase 1 complete (3/3 plans, verification passed)
progress:
  total_phases: 4
  completed_phases: 1
  total_plans: 3
  completed_plans: 3
  percent: 25
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.0 M1 Foundation Contracts — Phase 1 complete, ready for Phase 2

## Current Position

Phase: 02-context-diagnostician-contracts (next)
Status: Phase 1 complete, verification passed
Last activity: 2026-04-21 — Phase 1 complete (3/3 plans, verification passed)

## Context

**v2.0 M1 Goal:** 冻结 runtime-v2 的核心 contracts，避免后续 milestone 各自发明接口

**Phase 1 Complete:**
- PDErrorCategorySchema: 16 TypeBox literals + Value.Check guard
- AgentSpecSchema: 10 fields + sub-schemas for capabilities/timeout/retry
- RuntimeKindSchema: 5 runtime literals
- RuntimeCapabilitiesSchema: 9 capability flags + dynamicCapabilities
- PDTaskStatusSchema: 5 state literals
- TaskRecordSchema + DiagnosticianTaskRecordSchema
- RuntimeSelectionCriteriaSchema + RuntimeSelector interface
- PdError unified with PDErrorCategory (8 legacy codes mapped)
- io.ts pre-existing type error fixed

**Canonical documents:**

- docs/design/2026-04-21-pd-runtime-agnostic-architecture-v2.md
- docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md
- docs/spec/2026-04-21-diagnostician-v2-detailed-design.md
- docs/pd-runtime-v2/*.md

**Previous:** v1.22 PD CLI Redesign — SHIPPED 2026-04-20
