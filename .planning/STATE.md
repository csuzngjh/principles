---
gsd_state_version: 1.0
milestone: v2.1
milestone_name: M2 Task/Run State Core
status: shipped
last_updated: "2026-04-22T15:45:00.000Z"
last_activity: 2026-04-22 — Phase m2-07 complete, Milestone v2.1 SHIPPED
progress:
  total_phases: 54
  completed_phases: 49
  total_plans: 95
  completed_plans: 95
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.1 M2 Task/Run State Core — SHIPPED 2026-04-22

## Current Position

Phase: m2-07: Runtime Integration + Event Emission + CLI Inspection (complete)
Status: Milestone v2.1 complete (7/7 plans)
Last activity: 2026-04-22 — Phase m2-07 complete, all M2 task/run state components integrated and verified

## Context

**v2.1 M2 Goal:** 实现可靠的 task/run 状态存储、租约机制与恢复逻辑

**Phase m2-07 Complete:**
- `RuntimeStateManager` integrated integration layer.
- `StoreEventEmitter` with `TelemetryEvent` validation.
- Telemetry expansion: 8 new task lifecycle events.
- `LeaseManager` + `RecoverySweep` event emission wired.
- `pd task list/show` and `pd run list/show` CLI commands implemented.
- `isLeaseExpired` bug fixed in `DefaultLeaseManager`.

**Phase m2-01 to m2-06 Complete:**
- `SqliteTaskStore` + `SqliteRunStore` (MIGRATED from M1 schemas).
- `DefaultLeaseManager` (atomic acquire/release/renew).
- `DefaultRetryPolicy` (exponential backoff + jitter).
- `DefaultRecoverySweep` (stale lease detection and recovery).
- `EvolutionQueueItemMigrator` (legacy -> v2 bridge).
- Comprehensive integration tests (concurrent leases, idempotent transitions, schema conformance).

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Previous:** v2.0 M1 Foundation Contracts — SHIPPED 2026-04-21
