# Roadmap: Principles Disciple

## Milestones

- ✅ **v2.0 M1** — Foundation Contracts — SHIPPED 2026-04-21
- ✅ **v2.1 M2** — Task/Run State Core — SHIPPED 2026-04-22
- ✅ **v2.2 M3** — History Retrieval + Context Build — SHIPPED 2026-04-23
- ✅ **v2.3 M4** — Diagnostician Runner v2 — SHIPPED 2026-04-23
- ✅ **v2.4 M5** — Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24
- ✅ **v2.5 M6** — Production Runtime Adapter: OpenClaw CLI Diagnostician — SHIPPED 2026-04-25
- ✅ **v2.6 M7** — Principle Candidate Intake — SHIPPED 2026-04-27
- ✅ **v2.7 M8** — Pain Signal → Principle Single Path Cutover — SHIPPED 2026-04-28
- 🚧 **v2.8 M9** — PiAi Runtime Adapter (Default Diagnostician Runtime) — In Progress

## Phases

<details>
<summary>✅ v2.7 M8 — Pain Signal → Principle Single Path Cutover (SHIPPED 2026-04-28)</summary>

- [x] m8-01: Legacy Code Map + Single Path Cutover (5/5 plans) — completed 2026-04-28
- [x] m8-02: PainSignalBridge E2E + Auto-Intake Enable (2/2 plans) — completed 2026-04-28
- [x] m8-03: Real Environment UAT — M8 final sign-off (1/1 plan) — completed 2026-04-28

</details>

### 🚧 v2.8 M9 — PiAi Runtime Adapter (Default Diagnostician Runtime) — In Progress

**Pipeline:**
pain → PD task/run store → DiagnosticianRunner → **PiAiRuntimeAdapter** (pi-ai complete) → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

**Phases:**

- [x] **m9-01**: PiAiRuntimeAdapter Core (RS-01~02, AD-01~15) — 实现 PDRuntimeAdapter 接口 + pi-ai complete 调用 + DiagnosticianOutputV1 验证 — completed 2026-04-29
- [ ] **m9-02**: Policy + Factory Integration (PL-01~03, FC-01~04) — workflows.yaml policy 扩展 + PainSignalRuntimeFactory 选择 runtime
- [ ] **m9-03**: CLI Commands (CLI-01~04) — pd runtime probe --runtime pi-ai, pd diagnose run --runtime pi-ai, pd pain record policy-driven — **2 plans, 2 waves**

  Plans:
  - [ ] m9-03-01-PLAN.md — Extend probeRuntime + pd runtime probe for pi-ai (Wave 1)
  - [ ] m9-03-02-PLAN.md — Add pi-ai to diagnose + export resolveRuntimeConfig (Wave 2)

  Cross-cutting constraints:
  - CLI flags (--provider, --model, --apiKeyEnv, --maxRetries, --timeoutMs) used in both plans
  - PiAiRuntimeAdapter config pattern shared across probe and diagnose
- [ ] **m9-04**: Tests (TEST-01~06) — mock success/failure/timeout/invalid-json, probe, E2E pain→ledger
- [ ] **m9-05**: Real UAT (UAT-01~08) — OPENROUTER_API_KEY 真实验证 + 幂等性

**Dependencies:**
- m9-01 → m9-02 (factory needs adapter)
- m9-02 → m9-03 (CLI needs factory)
- m9-01 → m9-04 (tests need adapter)
- m9-03 → m9-05 (UAT needs CLI)

**Hard Boundaries:**
- 不引入 `@mariozechner/pi-agent-core`
- 不支持工具调用
- 不支持 OpenClaw session/gateway/plugin hooks
- 不改 OpenClawCliRuntimeAdapter（保留为 alternative）
- 不修改 candidate/ledger 主链路（除非测试证明有 bug）

**LOCKED Decisions:**
- LOCKED-01: Direct LLM completion only. No tools, no agent loop, no OpenClaw dependency.
- LOCKED-02: M9 success = ledger probation entry exists. LLM response success alone ≠ success.
- LOCKED-03: workflows.yaml is runtime SSOT.

## Backlog: Future Milestones

---

_Last updated: 2026-04-29 after M9 milestone start_
