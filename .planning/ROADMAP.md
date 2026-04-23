# Roadmap: Principles

## Milestones

- ✅ **v2.0** — M1 Foundation Contracts — SHIPPED 2026-04-21
- ✅ **v2.1** — M2 Task/Run State Core — SHIPPED 2026-04-22
- ✅ **v2.2** — M3 History Retrieval + Context Build — SHIPPED 2026-04-23
- 🔵 **v2.3** — M4 Diagnostician Runner v2 — Active

## Phases

<details>
<summary>✅ v2.0 M1 Foundation Contracts (Phase 1-4) — SHIPPED 2026-04-21</summary>

- [x] Phase 1: Core Protocol + Agent + Error Contracts (3/3 plans) — completed 2026-04-21
- [x] Phase 2: Context + Diagnostician Contracts (1/1 plans) — completed 2026-04-21
- [x] Phase 3: Package Infrastructure (1/1 plans) — completed 2026-04-21
- [x] Phase 4: Verification + Doc Sync (2/2 plans) — completed 2026-04-21

</details>

<details>
<summary>✅ v2.1 M2 Task/Run State Core (Phase m2-01 through m2-07) — SHIPPED 2026-04-22</summary>

- [x] m2-01: TaskStore Foundation (1/1 plans) — completed 2026-04-22
- [x] m2-02: RunStore Foundation (1/1 plans) — completed 2026-04-22
- [x] m2-03: LeaseManager (1/1 plans) — completed 2026-04-22
- [x] m2-04: RetryPolicy (1/1 plans) — completed 2026-04-22
- [x] m2-05: RecoverySweep + Integration Tests (1/1 plans) — completed 2026-04-22
- [x] m2-06: Migration Bridge + Advanced Integration Tests (1/1 plans) — completed 2026-04-22
- [x] m2-07: Runtime Integration + Event Emission + CLI Inspection (1/1 plans) — completed 2026-04-22

</details>

<details>
<summary>✅ v2.2 M3 History Retrieval + Context Build (Phase m3-01 through m3-09) — SHIPPED 2026-04-23</summary>

- [x] m3-01: TrajectoryLocator — completed 2026-04-22
- [x] m3-02: BoundedHistoryQuery — completed 2026-04-22
- [x] m3-03: ContextAssembler — completed 2026-04-22
- [x] m3-04: DegradationPolicy — completed 2026-04-22
- [x] m3-05: WorkspaceIsolation — completed 2026-04-22
- [x] m3-06: CLI Wiring — completed 2026-04-22
- [x] m3-07: Legacy Import Boundary — completed 2026-04-23
- [x] m3-08: OpenClaw-History Schema Alignment — completed 2026-04-23
- [x] m3-09: OpenClaw-History Entry Mapping — completed 2026-04-23

</details>

<details>
<summary>🔵 v2.3 M4 Diagnostician Runner v2 (Phase m4-01 through m4-06) — Active</summary>

- [x] m4-01: RunnerCore (3/3 plans) — completed 2026-04-23
  Plans:
  - [x] m4-01-01-PLAN.md — Runner type contracts + RuntimeStateManager extensions
  - [x] m4-01-02-PLAN.md — DiagnosticianRunner implementation + unit tests
  - [x] m4-01-03-PLAN.md — Integration tests + index.ts exports
- [x] m4-02: RuntimeInvocation (1/1 plans) — completed 2026-04-23
  Plans:
  - [x] m4-02-01-PLAN.md — TestDoubleRuntimeAdapter implementation + StartRunInput validation
- [ ] m4-03: Validator — Pending
- [ ] m4-04: RetryLeaseIntegration — Pending
- [ ] m4-05: TelemetryCLI — Pending
- [ ] m4-06: DualTrackE2E — Pending

</details>

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|---------------|--------|-----------|
| 1. Core Protocol | v2.0 | 3/3 | Complete | 2026-04-21 |
| 2. Context + Diag | v2.0 | 1/1 | Complete | 2026-04-21 |
| 3. Infrastructure | v2.0 | 1/1 | Complete | 2026-04-21 |
| 4. Verification | v2.0 | 2/2 | Complete | 2026-04-21 |
| m2-01 TaskStore | v2.1 | 1/1 | Complete | 2026-04-22 |
| m2-02 RunStore | v2.1 | 1/1 | Complete | 2026-04-22 |
| m2-03 LeaseManager | v2.1 | 1/1 | Complete | 2026-04-22 |
| m2-04 RetryPolicy | v2.1 | 1/1 | Complete | 2026-04-22 |
| m2-05 RecoverySweep | v2.1 | 1/1 | Complete | 2026-04-22 |
| m2-06 MigrationBridge | v2.1 | 1/1 | Complete | 2026-04-22 |
| m2-07 RuntimeIntegration | v2.1 | 1/1 | Complete | 2026-04-22 |
| m3-01 TrajectoryLocator | v2.2 | — | Complete | 2026-04-22 |
| m3-02 BoundedHistoryQuery | v2.2 | — | Complete | 2026-04-22 |
| m3-03 ContextAssembler | v2.2 | — | Complete | 2026-04-22 |
| m3-04 DegradationPolicy | v2.2 | — | Complete | 2026-04-22 |
| m3-05 WorkspaceIsolation | v2.2 | — | Complete | 2026-04-22 |
| m3-06 CLI-Wiring | v2.2 | — | Complete | 2026-04-22 |
| m3-07 LegacyImportBoundary | v2.2 | — | Complete | 2026-04-23 |
| m3-08 SchemaAlignment | v2.2 | — | Complete | 2026-04-23 |
| m3-09 EntryMapping | v2.2 | — | Complete | 2026-04-23 |
| m4-01 RunnerCore | v2.3 | 3/3 | Complete | 2026-04-23 |
| m4-02 RuntimeInvocation | v2.3 | 1/1 | Complete | 2026-04-23 |
| m4-03 Validator | v2.3 | 0/? | Pending | — |
| m4-04 RetryLeaseIntegration | v2.3 | 0/? | Pending | — |
| m4-05 TelemetryCLI | v2.3 | 0/? | Pending | — |
| m4-06 DualTrackE2E | v2.3 | 0/? | Pending | — |

---
*Last updated: 2026-04-23*
