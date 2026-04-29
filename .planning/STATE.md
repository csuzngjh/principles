---
gsd_state_version: 1.0
milestone: v2.8
milestone_name: M9 — PiAi Runtime Adapter
status: executing
last_updated: "2026-04-29T04:58:47.723Z"
last_activity: 2026-04-29 -- m9-03 CLI Commands planned (2 plans, verification passed)
progress:
  total_phases: 80
  completed_phases: 68
  total_plans: 140
  completed_plans: 143
  percent: 100
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.8 M9 — PiAi Runtime Adapter (Default Diagnostician Runtime)

## Current Position

Phase: m9-03 planned
Plan: 0/2 complete
Status: Ready to execute — CLI Commands
Last activity: 2026-04-29 -- m9-03 CLI Commands planned (2 plans, verification passed)
Resume file: .planning/phases/m9-03-CLI-Commands/m9-03-01-PLAN.md

## M9 Pipeline

pain → PD task/run store → DiagnosticianRunner → **PiAiRuntimeAdapter** (pi-ai complete) → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → principle_candidates → CandidateIntakeService → PrincipleTreeLedger probation entry

## M9 Scope (LOCKED)

1. RuntimeKindSchema add `"pi-ai"`
2. PiAiRuntimeAdapter: `getModel()` + `complete()` + DiagnosticianOutputV1 validation + `AbortSignal.timeout` + provider/model/apiKeyEnv/maxRetries config
3. workflows.yaml policy driven: runtimeKind/provider/model/timeoutMs/apiKeyEnv/maxRetries
4. PainSignalRuntimeFactory select runtime from policy (no longer hardcoded openclaw-cli)
5. CLI: `pd runtime probe --runtime pi-ai`, `pd diagnose run --runtime pi-ai`, `pd pain record` default via workflows.yaml
6. Tests: mock complete success/failure/timeout/invalid-json, probe, E2E pain→artifact→candidate→ledger
7. Real UAT: OPENROUTER_API_KEY verify + probe + pain record + assert status=succeeded + artifactId + candidateIds.length > 0 + ledgerEntryIds.length > 0 + idempotency

## LOCKED Decisions

- **LOCKED-01**: PiAiRuntimeAdapter is direct LLM completion only. No tools, no agent loop, no OpenClaw dependency.
- **LOCKED-02**: M9 success means ledger probation entry exists. LLM response success alone is not success.
- **LOCKED-03**: workflows.yaml is the runtime SSOT. Runtime kind, provider, model, timeout, apiKeyEnv, maxRetries must be consumed by code, not only documented.

## Hard Boundaries

- 不引入 `@mariozechner/pi-agent-core`
- 不支持工具调用
- 不支持 OpenClaw session/gateway/plugin hooks
- 不改 OpenClawCliRuntimeAdapter（保留为 alternative）
- 不修改 candidate/ledger 主链路（除非测试证明有 bug）

## Context

**M9 依赖：** M8 (pain signal bridge + single path cutover)

**M9 非目标：**

- 多 runtime 适配器套件（M9 只新增 PiAiRuntimeAdapter）
- OpenClaw agent/tool 调用
- 新 UI/dashboard
- pi-agent-core 或其他 agent framework

**Baseline (Frozen):**

- v2.0 M1: Foundation Contracts — SHIPPED 2026-04-21
- v2.1 M2: Task/Run State Core — SHIPPED 2026-04-22
- v2.2 M3: History Retrieval + Context Build — SHIPPED 2026-04-23
- v2.3 M4: Diagnostician Runner v2 — SHIPPED 2026-04-23
- v2.4 M5: Unified Commit + Principle Candidate Intake — SHIPPED 2026-04-24
- v2.5 M6: Production Runtime Adapter — SHIPPED 2026-04-25
- v2.6 M7: Principle Candidate Intake — SHIPPED 2026-04-27
- v2.7 M8: Pain Signal → Principle Single Path Cutover — SHIPPED 2026-04-28

**Canonical source:** `packages/principles-core/src/runtime-v2/`
