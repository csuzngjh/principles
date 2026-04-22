---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: milestone
status: verifying
last_updated: "2026-04-21T14:46:33.301Z"
last_activity: 2026-04-21 — Phase 4 complete (2/2 plans, verification + deprecation)
progress:
  total_phases: 47
  completed_phases: 42
  total_plans: 88
  completed_plans: 99
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.0 M1 Foundation Contracts — Phase 4 complete, all M1 contracts verified and documented

## Current Position

Phase: 04-verification-doc-sync (complete)
Status: Phase 4 complete (2/2 plans, verification + deprecation)
Last activity: 2026-04-21 — Phase 4 complete (2/2 plans, verification + deprecation)

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

**Phase 2 Complete:**

- HistoryQueryEntrySchema: role as 4-literal union (user/assistant/tool/system)
- TrajectoryLocateQuerySchema, TrajectoryCandidateSchema, TrajectoryLocateResultSchema
- HistoryQueryResultSchema: sourceRef + entries + truncated
- DiagnosisTargetSchema: 5 optional fields shared interface (D-03)
- ContextPayloadSchema + DiagnosticianContextPayloadSchema
- DiagnosticianViolatedPrincipleSchema, DiagnosticianEvidenceSchema
- RecommendationKindSchema: 5-literal union
- DiagnosticianRecommendationSchema, DiagnosticianOutputV1Schema
- DiagnosticianInvocationInputSchema (hybrid: schema + interface for D-02)
- index.ts: 14 new schema re-exports

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
