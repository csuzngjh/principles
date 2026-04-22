---
gsd_state_version: 1.0
milestone: v2.2
milestone_name: M3 History Retrieval + Context Build
status: all_phases_complete
last_updated: "2026-04-22T15:50:00Z"
last_activity: 2026-04-22 — m3-05 verified PASS, M3 ALL PHASES COMPLETE
progress:
  total_phases: 5
  completed_phases: 5
  total_plans: 5
  completed_plans: 5
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.2 M3 — ALL PHASES COMPLETE

## Current Position

**M3 ALL PHASES VERIFIED:**
- m3-01 Trajectory Locator ✅ VERIFIED
- m3-02 Bounded History Query ✅ VERIFIED
- m3-03 Context Assembler ✅ VERIFIED
- m3-04 Degradation Policy ✅ VERIFIED
- m3-05 Workspace Isolation + Integration ✅ VERIFIED

## Context

**v2.2 M3 Goal:** Deliver PD-owned retrieval pipeline — trajectory locate, history query, context build

**m3-05 Complete (VERIFIED):**
- CLI commands: pd trajectory locate, pd history, pd context
- Workspace isolation integration tests (7 tests)
- RET-11/12: Workspace isolation enforced by SqliteConnection architecture
- RET-13: CLI commands wired for all 3 retrieval operations
- 7 isolation tests, 0 regressions

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
- 19 tests

**m3-01 Complete:**
- TrajectoryLocator interface with locate() method
- SqliteTrajectoryLocator with 6 locate modes
- 17 tests

**M3 Boundary Constraints:**
- Only trajectory locate / history query / context build / degradation / workspace isolation
- No diagnostician runner (M4)
- No unified commit (M5)
- No host API in main design
- Authoritative retrieval via PD-owned stores/indexes/references only
- No LLM in context build

**M3 Exit Criteria (ALL DONE):**
1. `pd trajectory locate` — ✅ DONE (m3-01)
2. `pd history query` — ✅ DONE (m3-02)
3. `pd context build` — ✅ DONE (m3-03)
4. Workspace isolation: context never leaks across workspaces — ✅ DONE (m3-05)
5. Degradation policy: graceful fallback when history is incomplete — ✅ DONE (m3-04)
6. Degraded mode: no crashes, only warnings, task can still proceed — ✅ DONE (m3-04)

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Previous:** v2.1 M2 Task/Run State Core — SHIPPED 2026-04-22
