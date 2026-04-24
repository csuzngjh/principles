# Roadmap: Principles — AI Agent Principle Evolution System

## Milestones

- ✅ **v2.0 M1: Foundation Contracts** — Phases 1-4 (SHIPPED 2026-04-21)
- ✅ **v2.1 M2: Task/Run State Core** — Phases m2-01 through m2-07 (SHIPPED 2026-04-22)
- ✅ **v2.2 M3: History Retrieval + Context Build** — Phases m3-01 through m3-09 (SHIPPED 2026-04-23)
- ✅ **v2.3 M4: Diagnostician Runner v2** — Phases m4-01 through m4-06 (SHIPPED 2026-04-23)
- ✅ **v2.4 M5: Unified Commit + Principle Candidate Intake** — Phases m5-01 through m5-05 (SHIPPED 2026-04-24)
- 📋 **v2.5: Candidate Gating + Promotion** — Phases m6-01+ (planned)

## Phase Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 1-4 | v2.0 | 7 | Complete | 2026-04-21 |
| m2-01 through m2-07 | v2.1 | 7 | Complete | 2026-04-22 |
| m3-01 through m3-09 | v2.2 | 9 | Complete | 2026-04-23 |
| m4-01 through m4-06 | v2.3 | 7 | Complete | 2026-04-23 |
| m5-01 | v2.4 | 1 | Complete | 2026-04-24 |
| m5-02 | v2.4 | 1 | Complete | 2026-04-24 |
| m5-03 | v2.4 | 1 | Complete | 2026-04-24 |
| m5-04 | v2.4 | 3 | Complete | 2026-04-24 |
| m5-05 | v2.4 | 1 | Complete | 2026-04-24 |

## Details

<details>
<summary>✅ v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24</summary>

- [x] Phase m5-01: Artifact Registry Schema (1/1 plan) — completed 2026-04-24
- [x] Phase m5-02: DiagnosticianCommitter Core (1/1 plan) — completed 2026-04-24
- [x] Phase m5-03: Runner Integration (1/1 plan) — completed 2026-04-24
- [x] Phase m5-04: CLI + Telemetry (3/3 plans) — completed 2026-04-24
- [x] Phase m5-05: E2E Verification (1/1 plan) — completed 2026-04-24

**Summary:** diagnostician output -> diagnosis artifact -> principle candidate -> task resultRef，全链路在 SQLite .pd/state.db 内原子完成

[Full archive: .planning/milestones/v2.4-ROADMAP.md]
</details>

<details>
<summary>✅ v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23</summary>

- [x] m4-01: RunnerCore (3/3 plans) — completed 2026-04-23
- [x] m4-02: RuntimeInvocation (1/1 plan) — completed 2026-04-23
- [x] m4-03: Validator (1/1 plan) — completed 2026-04-23
- [x] m4-04: RetryLeaseIntegration (1/1 plan) — completed 2026-04-23
- [x] m4-05: TelemetryCLI (1/1 plan) — completed 2026-04-23
- [x] m4-06: DualTrackE2E (1/1 plan) — completed 2026-04-23

[Full archive: .planning/milestones/v2.3-ROADMAP.md]
</details>

<details>
<summary>✅ v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23</summary>

- [x] m3-01: TrajectoryLocator — completed 2026-04-22
- [x] m3-02: BoundedHistoryQuery — completed 2026-04-22
- [x] m3-03: ContextAssembler — completed 2026-04-22
- [x] m3-04: DegradationPolicy — completed 2026-04-22
- [x] m3-05: WorkspaceIsolation — completed 2026-04-22
- [x] m3-06: CLI-Wiring — completed 2026-04-22
- [x] m3-07: LegacyImportBoundary — completed 2026-04-23
- [x] m3-08: SchemaAlignment — completed 2026-04-23
- [x] m3-09: EntryMapping — completed 2026-04-23

[Full archive: .planning/milestones/v2.2-ROADMAP.md]
</details>

<details>
<summary>✅ v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22</summary>

- [x] m2-01: TaskStore Foundation — completed 2026-04-22
- [x] m2-02: RunStore Foundation — completed 2026-04-22
- [x] m2-03: LeaseManager — completed 2026-04-22
- [x] m2-04: RetryPolicy — completed 2026-04-22
- [x] m2-05: RecoverySweep + Integration Tests — completed 2026-04-22
- [x] m2-06: MigrationBridge + Advanced Integration Tests — completed 2026-04-22
- [x] m2-07: Runtime Integration + Event Emission + CLI Inspection — completed 2026-04-22

[Full archive: .planning/milestones/v2.1-ROADMAP.md]
</details>

<details>
<summary>✅ v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21</summary>

- [x] Phase 1: Core Protocol + Agent + Error Contracts (3/3 plans) — completed 2026-04-21
- [x] Phase 2: Context + Diagnostician Contracts (1/1 plan) — completed 2026-04-21
- [x] Phase 3: Package Infrastructure (1/1 plan) — completed 2026-04-21
- [x] Phase 4: Verification + Doc Sync (2/2 plans) — completed 2026-04-21

[Full archive: .planning/milestones/v2.0-ROADMAP.md]
</details>

## Next Milestone

**v2.5: Candidate Gating + Promotion** — Phase m6-01 onwards

- Principle candidate promotion via gating/scoring
- Active principle injection into agent context
- Ledger bridge filesystem sync (PrinciplesTreeLedger adapter)

---

_Last updated: 2026-04-24 after v2.4 M5 shipped_
