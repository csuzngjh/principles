---
gsd_state_version: 1.0
milestone: v2.4
milestone_name: pd-runtime-v2-m5
status: active
last_updated: "2026-04-24T00:00:00.000Z"
last_activity: 2026-04-24 — ROADMAP created for M5 Unified Commit + Principle Candidate Intake
progress:
  total_phases: 57
  completed_phases: 52
  total_plans: 116
  completed_plans: 116
  percent: 91
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.4 M5 Unified Commit + Principle Candidate Intake

## Current Position

Phase: m5-01 (Artifact Registry Schema)
Status: Roadmap created, ready to plan
Last activity: 2026-04-24 — ROADMAP.md + REQUIREMENTS.md created for M5

Progress: [>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>------] 91%

## Context

**v2.4 M5 Goal:** Make diagnosis output commit atomic and define downstream principle-candidate consumption

**M5 Phases:**

- m5-01: Artifact Registry Schema — SQL schema, migration, tables, indexes
- m5-02: DiagnosticianCommitter Core — Interface, commit logic, transaction safety
- m5-03: Runner Integration — Runner calls committer, ordering, failure handling
- m5-04: CLI + Telemetry — Candidate list/show, extended status, events
- m5-05: E2E Verification — Full chain tests, idempotency, failure scenarios

**M5 Constraints:**

- Atomic commit truth lives in SQLite state.db ONLY
- Runner only depends on Committer interface
- Task succeeded MUST happen after commit success
- Cannot produce "task succeeded but candidate missing" state
- No principle promotion, no active injection, no multi-runtime

**Baseline (Frozen):**

- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23

**Canonical source:** `packages/principles-core/src/runtime-v2/`

## Performance Metrics

**Velocity:**
- Total plans completed: 116
- M4 plans completed: 6 phases, ~8 plans

**By Phase:**

| Phase | Plans | Status |
|-------|-------|--------|
| M1 (m1-01..m1-07) | 7 | Complete |
| M2 (m2-01..m2-09) | 9 | Complete |
| M3 (m3-01..m3-09) | 9 | Complete |
| M4 (m4-01..m4-06) | 6 | Complete |
| M5 (m5-01..m5-05) | 5 | Not started |

## Accumulated Context

### Decisions

- M4 SHIPPED: DiagnosticianRunner uses explicit run + validation flow
- M4 constraint preserved: Runner does NOT write artifacts (M5 scope)
- M5 will extend SqliteConnection.initSchema() with artifacts + principle_candidates tables
- M5 will add DiagnosticianCommitter to DiagnosticianRunnerDeps

### Pending Todos

None.

### Blockers/Concerns

None.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| M3 LOW | conversationWindow in DESC order | Known, non-blocking | M3 m5-03 |

## Session Continuity

Last session: 2026-04-24
Stopped at: ROADMAP.md and REQUIREMENTS.md created for M5
Resume file: None
