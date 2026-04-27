# Roadmap: Principles Disciple

## Milestones

- ✅ **v2.0 M1** — Foundation Contracts — SHIPPED 2026-04-21
- ✅ **v2.1 M2** — Task/Run State Core — SHIPPED 2026-04-22
- ✅ **v2.2 M3** — History Retrieval + Context Build — SHIPPED 2026-04-23
- ✅ **v2.3 M4** — Diagnostician Runner v2 — SHIPPED 2026-04-23
- ✅ **v2.4 M5** — Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24
- ✅ **v2.5 M6** — Production Runtime Adapter: OpenClaw CLI Diagnostician — SHIPPED 2026-04-25
- ✅ **v2.6 M7** — Principle Candidate Intake — SHIPPED 2026-04-27
- 🚧 **v2.7 M8** — Pain Signal → Principle Single Path Cutover (In Progress)

## Phases

<details>
<summary>✅ v2.6 M7 — Principle Candidate Intake (SHIPPED 2026-04-27)</summary>

- [x] m7-01: Candidate Intake Contract (2/2 plans) — completed 2026-04-26
- [x] m7-02: PrincipleTreeLedger Adapter (2/2 plans) — completed 2026-04-26
- [x] m7-03: Intake Service + Idempotency (2/2 plans) — completed 2026-04-26
- [x] m7-04: CLI: pd candidate intake (2/2 plans) — completed 2026-04-27
- [x] m7-05: E2E: candidate -> ledger entry (1/1 plan) — completed 2026-04-27

</details>

### 🚧 v2.7 M8 — Pain Signal → Principle Single Path Cutover (In Progress)

- [ ] m8-01: Legacy Code Map + Single Path Cutover (5/5 plans)

Plans:
- [ ] m8-01-01-PLAN.md — Delete diagnostician-task-store.ts
- [ ] m8-01-02-PLAN.md — Remove legacy diagnostician block from prompt.ts and evolution-worker.ts
- [ ] m8-01-03-PLAN.md — Update runtime-summary-service.ts and event-types.ts
- [ ] m8-01-04-PLAN.md — Implement PainSignalBridge service + wire into pain.ts
- [ ] m8-01-05-PLAN.md — E2E verification + ROADMAP update

## Backlog: Future Milestones

### v2.8 M9 -- Legacy Path Decommission

**Goal**: Retire legacy evolution-worker, heartbeat injection, cron-based diagnostician.

**Depends on**: M7, M8

**Constraints**: Zero regressions in active principle injection; legacy path removal only after M8 verifies pain->candidate bridge.

**Non-goals**: No breaking changes to active principle lifecycle.

**Plans**: TBD

---

_Last updated: 2026-04-27 after v2.7 M8 milestone start_