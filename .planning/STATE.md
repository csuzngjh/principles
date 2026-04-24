---
gsd_state_version: 1.0
milestone: v2.5
milestone_name: m6-openclaw-cli-adapter
status: in_progress
last_updated: "2026-04-24T17:00:00.000Z"
last_activity: 2026-04-24 — v2.5 M6 started
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.4 M5 Unified Commit + Principle Candidate Intake

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-04-24 — v2.5 M6 started

## Context

**v2.4 M5 Goal:** diagnostician output -> diagnosis artifact -> principle candidate -> task resultRef，全链路在 SQLite .pd/state.db 内原子完成

**M5 Phases:**
- m5-01: Artifact Registry Schema — tables, FK, indexes, resultRef URI scheme
- m5-02: DiagnosticianCommitter Core — interface, transaction commit, candidate extraction
- m5-03: Runner Integration — commit before succeed, production path mandates committer
- m5-04: CLI + Telemetry — fixed commands, telemetry events, RunnerPhase.Committing
- [x] m5-05: E2E Verification — hard gate: idempotency, failure, traceability, CLI visibility (COMPLETE: 4/4 pass)

**Boundary Constraints (6 corrections):**
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

**Canonical source:** `packages/principles-core/src/runtime-v2/`
