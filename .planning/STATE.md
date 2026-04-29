---
gsd_state_version: 1.0
milestone: v2.8
milestone_name: M9 — PiAi Runtime Adapter
status: SHIPPED — M9 complete: PR #412 (m9-05 Real UAT PASS, 8/8 requirements)
last_updated: "2026-04-29"
last_activity: "2026-04-29 -- M9 shipped: PR #412 - xiaomi-coding/mimo-v2.5-pro real UAT + abstractedPrinciple 40->200 fix + candidate intake sourceRecommendationJson priority
progress:
  total_phases: 80
  completed_phases: 71
  total_plans: 139
  completed_plans: 148
  percent: 89
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** v2.8 M9 — PiAi Runtime Adapter (Default Diagnostician Runtime) — SHIPPED

## Current Position

Phase: m9-05 complete
Plan: 1/1 complete
Status: SHIPPED — M9 complete: PR #412 (m9-05 Real UAT PASS, 8/8 requirements)
Last activity: 2026-04-29 -- M9 shipped: PR #412 — xiaomi-coding/mimo-v2.5-pro real UAT

## M9 Pipeline

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

**M9 依赖：** M8 (pain signal bridge + single path cutover)

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

**Canonical source:** `packages/principles-core/src/runtime-v2/`
