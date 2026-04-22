---
gsd_state_version: 1.0
milestone: v2.2
milestone_name: M3 History Retrieval + Context Build
status: in_progress
last_updated: "2026-04-22T15:45:00Z"
last_activity: 2026-04-22 — m3-04 verified (PASS), routing to m3-05
progress:
  total_phases: 5
  completed_phases: 4
  total_plans: 4
  completed_plans: 4
  percent: 80
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.2 M3 History Retrieval + Context Build — IN PROGRESS

## Current Position

Phase: m3-05 Workspace Isolation + Integration (next)
Status: m3-04 verified PASS, routing to m3-05 discuss
Last activity: 2026-04-22 — Degradation Policy verified, ResilientContextAssembler + ResilientHistoryQuery shipped

## Context

**v2.2 M3 Goal:** Deliver PD-owned retrieval pipeline — trajectory locate, history query, context build

**m3-04 Complete (VERIFIED):**
- ResilientContextAssembler: never-throws wrapper returning degraded DiagnosticianContextPayload
- ResilientHistoryQuery: cursor error fallback to first page
- degradation_triggered telemetry event type added
- 12 tests, 0 regressions

**m3-03 Complete (VERIFIED):**
- ContextAssembler interface with assemble(taskId) method
- SqliteContextAssembler composing TaskStore + HistoryQuery + RunStore
- UUIDv4 contextId and SHA-256 contextHash generation
- DiagnosisTarget mapping from DiagnosticianTaskRecord fields
- Template-generated ambiguityNotes for data quality issues
- TypeBox Value.Check() output validation
- 11 tests, 0 regressions
- Finding: conversationWindow in DESC order (LOW, non-blocking)

**m3-02 Complete:**
- HistoryQuery interface with query(trajectoryRef, cursor?, options?) method
- HistoryQueryCursorData for opaque cursor internal structure (base64 JSON)
- HistoryQueryOptions for limit and time window customization
- SqliteHistoryQuery with keyset cursor pagination (started_at + run_id)
- Time window filter with default 24h lookback and custom overrides
- Constants: DEFAULT_HISTORY_PAGE_SIZE=50, MAX_HISTORY_PAGE_SIZE=200, DEFAULT_TIME_WINDOW_MS=86400000
- 19 tests covering cursor pagination, time windows, entry mapping, error cases

**m3-01 Complete:**
- TrajectoryLocator interface with locate() method
- SqliteTrajectoryLocator with 6 locate modes (painId, taskId, runId, timeRange, sessionId+workspace, executionStatus)
- 17 tests covering all modes, confidence levels, edge cases
- executionStatus field added to TrajectoryLocateQuerySchema (stretch)

**M3 Boundary Constraints:**
- Only trajectory locate / history query / context build / degradation / workspace isolation
- No diagnostician runner (M4)
- No unified commit (M5)
- No host API in main design
- Authoritative retrieval via PD-owned stores/indexes/references only
- No LLM in context build

**M3 Exit Criteria:**
1. `pd trajectory locate` — DONE (m3-01)
2. `pd history query` — DONE (m3-02)
3. `pd context build` — DONE (m3-03)
4. Workspace isolation: context never leaks across workspaces — m3-05
5. Degradation policy: graceful fallback when history is incomplete — DONE (m3-04)
6. Degraded mode: no crashes, only warnings, task can still proceed — DONE (m3-04)

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Previous:** v2.1 M2 Task/Run State Core — SHIPPED 2026-04-22
