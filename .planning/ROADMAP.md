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
- ✅ **v2.8 M9** — PiAi Runtime Adapter (Default Diagnostician Runtime) — SHIPPED 2026-04-29

## Phases

<details>
<summary>✅ v2.7 M8 — Pain Signal → Principle Single Path Cutover (SHIPPED 2026-04-28)</summary>

- [x] m8-01: Legacy Code Map + Single Path Cutover (5/5 plans) — completed 2026-04-28
- [x] m8-02: PainSignalBridge E2E + Auto-Intake Enable (2/2 plans) — completed 2026-04-28
- [x] m8-03: Real Environment UAT — M8 final sign-off (1/1 plan) — completed 2026-04-28

</details>

### v2.8 M9 — PiAi Runtime Adapter (Default Diagnostician Runtime) — SHIPPED 2026-04-29

**Pipeline:**
pain → PD task/run store → DiagnosticianRunner → **PiAiRuntimeAdapter** (pi-ai complete) → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

**Phases:**

- [x] **m9-01**: PiAiRuntimeAdapter Core — completed 2026-04-29
- [x] **m9-03-01**: CLI probe for pi-ai — completed 2026-04-29
- [x] **m9-03-02**: diagnose run pi-ai + resolveRuntimeConfig — completed 2026-04-29
- [x] **m9-04**: Tests (m9-adapter-integration.test.ts + m9-e2e.test.ts) — completed 2026-04-29
- [x] **m9-05**: Real UAT with xiaomi-coding/mimo-v2.5-pro — completed 2026-04-29 (PR #412)

**Key accomplishment:** PiAiRuntimeAdapter with xiaomi-coding provider as default diagnostician runtime, replacing openclaw-cli as the default for pain→principle pipeline.

**Hard Boundaries:**
- 不引入 @mariozechner/pi-agent-core
- 不支持工具调用
- 不支持 OpenClaw session/gateway/plugin hooks
- 不改 OpenClawCliRuntimeAdapter（保留为 alternative）
- 不修改 candidate/ledger 主链路

**LOCKED Decisions:**
- LOCKED-01: PiAiRuntimeAdapter is direct LLM completion only
- LOCKED-02: M9 success = ledger probation entry exists
- LOCKED-03: workflows.yaml is runtime SSOT

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

### v2.9 M10 — Nocturnal Artificer LLM Upgrade — IN PROGRESS

**Goal:** Replace hardcoded Artificer stub with LLM-backed dynamic code generator, completing the PD system's self-evolution closed loop.

**Pipeline:**
pain → Diagnostician → principle → Nocturnal Trinity Reflection → **Artificer (LLM)** → sandbox `.js` rule → validateRuleImplementationCandidate → maybePersistArtificerCandidate → active interception rule

**Phases:**

- [ ] **m10-01**: Artificer Core & LLM Integration — `runArtificerAsync` + prompt engineering
- [ ] **m10-02**: Pipeline Integration — Replace stub in NocturnalService
- [ ] **m10-03**: Dynamic Pruning & E2E Validation — adherence-based lifecycle + end-to-end

**LOCKED Decisions:**
- LOCKED-04: Artificer uses same `runtimeAdapter` config as Diagnostician
- LOCKED-05: Static validation is non-negotiable gate for LLM code
- LOCKED-06: Dynamic Pruning must be verifiable

**Hard Boundaries:**
- Artificer 仅生成 Sandbox `.js`，不直接修改生产代码
- 必须通过 `RuleHost` 沙盒验证
- 不修改 Trinity reflection 链路
- 不修改 Diagnostician 主链路
- 不引入新 runtime 依赖

**Dependencies:**
- m10-01 → m10-02 (pipeline needs runArtificerAsync)
- m10-02 → m10-03 (E2E needs pipeline integrated)

---

_Last updated: 2026-04-29 after M9 shipped_
