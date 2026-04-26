---
gsd_state_version: 1.0
milestone: v2.6
milestone_name: milestone
status: m7-03 context gathered — ready for planning
last_updated: "2026-04-26T20:50:00.000Z"
progress:
  total_phases: 5
  completed_phases: 2
  total_plans: 4
  completed_plans: 2
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.6 M7 Principle Candidate Intake: consume pending candidates and write ledger probation entries

## Current Position

Phase: m7-03 (context gathered — ready for planning)
Session stopped at: Phase m7-02 complete — PrincipleTreeLedgerAdapter implemented
Resume from: .planning/phases/m7-03-CandidateIntakeService/m7-03-CONTEXT.md

## M7 Phase Structure

| Phase | Name | Requirements |
|-------|------|--------------|
| m7-01 | Candidate Intake Contract | INTAKE-01~04, LEDGER-01 (5 req) ✅ SHIPPED |
| m7-02 | PrincipleTreeLedger Adapter | LEDGER-01~03 (3 req) |
| m7-03 | Intake Service + Idempotency | INTAKE-05~07 (3 req) |
| m7-04 | CLI: pd candidate intake | CLI-INTAKE-01~03 (3 req) |
| m7-05 | E2E: candidate → ledger entry | E2E-INTAKE-01~04 (4 req) |

## Context

**M7 Boundary Constraints:**

1. Atomic commit truth in SQLite .pd/state.db ONLY (carried from M5)
2. Runner only depends on Committer interface (carried from M5)
3. task succeeded MUST happen after commit success (carried from M5)
4. Cannot produce "task succeeded but candidate missing" state (carried from M5)
5. No pain signal bridge in M7
6. No legacy path deletion in M7
7. No heartbeat/cron/subagent resurrection
8. No direct promotion to active principle
9. Idempotency is a hard requirement for intake

**Baseline (Frozen):**

- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23
- v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24
- v2.5 M6: Production Runtime Adapter — SHIPPED 2026-04-25

**Canonical source:** `packages/principles-core/src/runtime-v2/`
