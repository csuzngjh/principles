---
gsd_state_version: 1.0
milestone: v2.9
milestone_name: M10 — Nocturnal Artificer LLM Upgrade
status: completed
last_updated: "2026-05-02T10:00:00.000Z"
last_activity: 2026-04-30 -- M10 Artificer LLM upgrade complete on fix/nocturnal-artificer-llm-upgrade
progress:
  total_phases: 81
  completed_phases: 81
  total_plans: 148
  completed_plans: 148
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.9 M10 — Nocturnal Artificer LLM Upgrade (Self-Evolution Decoupling)

## Current Position

Phase: M10 COMPLETE
Plan: 3/3 (m10-01 ✅ m10-02 ✅ m10-03 ✅)
Status: Complete — All phases delivered, 42/42 tests pass
Last activity: 2026-04-30 -- M10 Artificer LLM upgrade complete on fix/nocturnal-artificer-llm-upgrade

## M10 Pipeline (Target)

pain → Diagnostician → principle → **Nocturnal Trinity Reflection** → **Artificer (LLM)** → sandbox `.js` rule → validateRuleImplementationCandidate → maybePersistArtificerCandidate → active interception rule

## M10 Scope

1. `runArtificerAsync`: LLM-backed code generation replacing `buildDefaultArtificerOutput` stub
2. Prompt engineering: Trinity reflection → targeted interception rule JS
3. Pipeline integration: Replace stub in `maybePersistArtificerCandidate`
4. Dynamic pruning verification: adherence-based rule lifecycle
5. E2E: reflection → artificer → sandbox validation → persistence

## LOCKED Decisions

- **LOCKED-04**: Artificer must use the same `runtimeAdapter` configuration as Diagnostician.
- **LOCKED-05**: Static validation (`validateRuleImplementationCandidate`) is a non-negotiable gate for LLM-generated code.
- **LOCKED-06**: Dynamic Pruning must be verifiable.

## Hard Boundaries

- Artificer 不直接修改生产代码，仅生成 Sandbox `.js`
- 必须通过 `RuleHost` 沙盒验证
- 不修改 Trinity reflection 链路（Dreamer → Philosopher → Scribe）
- 不修改 Diagnostician 主链路
- 不引入新的 runtime 依赖（复用现有 TrinityRuntimeAdapter）

pain → PD task/run store → DiagnosticianRunner → **PiAiRuntimeAdapter** (pi-ai complete) → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

## M9 Scope (COMPLETE)

1. RuntimeKindSchema add `"pi-ai"` ✓
2. PiAiRuntimeAdapter: getModel() + complete() + DiagnosticianOutputV1 validation + AbortSignal.timeout + provider/model/apiKeyEnv/maxRetries config ✓
3. workflows.yaml policy driven: runtimeKind/provider/model/timeoutMs/apiKeyEnv/maxRetries ✓
4. PainSignalRuntimeFactory select runtime from policy (no longer hardcoded openclaw-cli) ✓
5. CLI: `pd runtime probe --runtime pi-ai`, `pd diagnose run --runtime pi-ai`, `pd pain record` default via workflows.yaml ✓
6. Tests: mock success/failure/timeout/invalid-json, probe, E2E pain→artifact→candidate→ledger ✓
7. Real UAT: xiaomi-coding/mimo-v2.5-pro verify + probe + pain record + assert status=succeeded + artifactId + candidateIds.length > 0 + ledgerEntryIds.length > 0 + idempotency ✓

## LOCKED Decisions

- **LOCKED-01**: PiAiRuntimeAdapter is direct LLM completion only. No tools, no agent loop, no OpenClaw dependency.
- **LOCKED-02**: M9 success means ledger probation entry exists. LLM response success alone is not success.
- **LOCKED-03**: workflows.yaml is the runtime SSOT. Runtime kind, provider, model, timeout, apiKeyEnv, maxRetries, baseUrl must be consumed by code, not only documented.

## Hard Boundaries

- 不引入 `@mariozechner/pi-agent-core`
- 不支持工具调用
- 不支持 OpenClaw session/gateway/plugin hooks
- 不改 OpenClawCliRuntimeAdapter（保留为 alternative）
- 不修改 candidate/ledger 主链路（除非测试证明有 bug）

## Context

**M10 依赖：** M9 (PiAi Runtime Adapter — runtime infrastructure)

**Baseline (Frozen):**

- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23
- v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24
- v2.5 M6: Production Runtime Adapter — SHIPPED 2026-04-25
- v2.6 M7: Principle Candidate Intake — SHIPPED 2026-04-27
- v2.7 M8: Pain Signal → Principle Single Path Cutover — SHIPPED 2026-04-28
- **v2.8 M9: PiAi Runtime Adapter — SHIPPED 2026-04-29**
- **v2.9 M10: Nocturnal Artificer LLM Upgrade — COMPLETE**

**Canonical source:** `packages/principles-core/src/runtime-v2/`
