---
gsd_state_version: 1.0
milestone: v2.0
milestone_name: milestone
status: completed
last_updated: "2026-04-23T06:33:02.797Z"
last_activity: 2026-04-23 — m4-02 completed (1/1 plans, 18 new tests, 200 suite passing)
progress:
  total_phases: 60
  completed_phases: 49
  total_plans: 103
  completed_plans: 113
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.3 M4 Diagnostician Runner v2 — Active

## Current Position

Phase: m4-03: Validator (planned)
Status: m4-03 planned (1/1 plans), ready to execute
Last activity: 2026-04-23 — m4-03 planned (1/1 plans, research + verify pass)

## Context

**v2.3 M4 Goal:** Replace heartbeat-prompt-driven diagnostician execution with explicit runner-driven execution

**M4 Phases:**

- m4-01: RunnerCore — runner lifecycle, state transitions, context assembly invocation
- m4-02: RuntimeInvocation — PDRuntimeAdapter test double, StartRunInput wiring
- m4-03: Validator — DiagnosticianOutputV1 schema + semantic validation
- m4-04: RetryLeaseIntegration — lease/retry/recovery interaction tests
- m4-05: TelemetryCLI — diagnostician events + `pd diagnose run/status`
- m4-06: DualTrackE2E — legacy compatibility verification + end-to-end test

**M4 Constraints:**

- Heartbeat is NOT the primary execution path (trigger only)
- LLM does NOT mutate durable state
- Task/run truth uses M2 runtime-v2 store (frozen baseline)
- Context build reuses M3 SqliteContextAssembler
- No DiagnosticianCommitter (M5 scope)
- No principle candidate emission (M5 scope)
- No plugin demotion (M6 scope)

**Baseline (Frozen):**

- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Previous:** v2.2 M3 History Retrieval + Context Build — SHIPPED 2026-04-23
