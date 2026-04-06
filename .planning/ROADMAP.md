# Roadmap

## Milestones

- ✅ **v1.0-alpha MVP** — Phases 1-3 (shipped 2026-03-26)
- ✅ **v1.4 OpenClaw v2026.4.3 Compatibility** — Phases 1, 2, 5 (shipped 2026-04-05)
- 📋 **v1.5** — Planned

## Phases

<details>
<summary>✅ v1.0-alpha MVP (Phases 1-3) — SHIPPED 2026-03-26</summary>

- [x] Phase 1: SDK Integration (1/1 plan) — completed 2026-03-26
- [x] Phase 2: Memory Search (1/1 plan) — completed 2026-03-26
- [x] Phase 2.5: SDK Refinement (1/1 plan) — completed 2026-03-26
- [x] Phase 3A: Input Quarantine (1/1 plan) — completed 2026-03-26
- [x] Phase 3B: Gate Split (1/1 plan) — completed 2026-03-26
- [x] Phase 3C: Defaults & Errors (1/1 plan) — completed 2026-03-26

</details>

<details>
<summary>✅ v1.4 OpenClaw v2026.4.3 Compatibility — SHIPPED 2026-04-05</summary>

- [x] Phase 1: SDK Type Cleanup (2 plans) — completed 2026-04-05
- [x] Phase 2: Memory Search (FTS5) (1 plan) — completed 2026-04-05
- [x] Phase 5: Integration Testing (partial — TEST-04/05 pending)

**Known gaps:** TEST-04/05 runtime verification pending via Feishu

</details>

### 📋 v1.5 (Planned)

- [ ] Phase 6: Foundation and Single-Reflector Mode
  - [x] 06-01-PLAN.md — NocturnalWorkflowManager class implementing WorkflowManager interface (NOC-01 through NOC-05)
- [x] Phase 7: Trinity Integration with Event Recording
  - [x] 07-01-PLAN.md, 07-02-PLAN.md — Trinity async path, stage events, state machine (NOC-06 through NOC-10)
- [ ] Phase 8: Intermediate Persistence and Idempotency
  - [x] 08-01-PLAN.md — WorkflowStore stage_outputs table and methods (NOC-11, NOC-12, NOC-13)
  - [x] 08-02-PLAN.md — NocturnalWorkflowManager idempotency + crash recovery (NOC-11, NOC-12, NOC-13)
- [x] Phase 9: Fallback and Evolution Worker Integration
  - [x] 09-01-PLAN.md — NOC-14, NOC-15, NOC-16
- [x] Phase 10: Fix NOC-15 Stub Parameters (completed 2026-04-06)
  - [x] 10-01-PLAN.md — Fix StubFallbackRuntimeAdapter method signatures (NOC-15)

## Progress

| Phase | Milestone | Plans | Status | Completed |
|-------|-----------|-------|--------|-----------|
| 1 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 2 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 2.5 | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3A | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3B | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 3C | v1.0-alpha | 1/1 | Complete | 2026-03-26 |
| 1 | v1.4 | 2/2 | Complete | 2026-04-05 |
| 2 | v1.4 | 1/1 | Complete | 2026-04-05 |
| 5 | v1.4 | 1/1 | Partial | 2026-04-05 |
| 6 | v1.5 | 1/1 | Complete | — |
| 7 | v1.5 | 2/2 | Complete | — |
| 8 | v1.5 | 2/2 | Complete | — |
| 9 | v1.5 | 1/1 | Complete | — |
| 10 | v1.5 | 1/1 | Complete    | 2026-04-06 |
