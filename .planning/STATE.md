---
gsd_state_version: 1.0
milestone: v2.5
milestone_name: m6-openclaw-cli-adapter
status: in_progress
last_updated: "2026-04-24T21:27:00.000Z"
last_activity: 2026-04-24 — m6-02 complete (OCRA-01~05)
progress:
  total_phases: 6
  completed_phases: 1
  total_plans: 0
  completed_plans: 3
  percent: 17
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.5 M6 Production Runtime Adapter: OpenClaw CLI Diagnostician

## Current Position

Phase: m6-02 (complete)
Phase: m6-03 (next to plan/execute)
Plan: —
Status: m6-02 shipped on feature/pd-runtime-v2-m6

## M6 Phase Structure

| Phase | Name | Requirements |
|-------|------|--------------|
| m6-01 | CliProcessRunner + RuntimeKind | RUNR-01~04, RUK-01~02 (6 req) |
| m6-02 | OpenClawCliRuntimeAdapter Core | OCRA-01~05 (5 req) |
| m6-03 | DiagnosticianPromptBuilder + Workspace | DPB-01~05, OCRA-06 (6 req) |
| m6-04 | PD CLI Extension + Error Mapping | CLI-01~04, ERR-01~05 (8 req) |
| m6-05 | Telemetry Events | TELE-01~04 (4 req) |
| m6-06 | E2E Verification | E2EV-01~06 (6 req) |

## Context

**M5 Boundary Constraints (still valid for M6):**
1. Atomic commit truth in SQLite .pd/state.db ONLY
2. Runner only depends on Committer interface
3. task succeeded MUST happen after commit success
4. Cannot produce "task succeeded but candidate missing" state
5. E2E verification is a hard gate
6. No principle promotion, no active injection, no multi-runtime, no plugin demotion

**Baseline (Frozen):**
- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23
- v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24

**Canonical source:** `packages/principles-core/src/runtime-v2/`
