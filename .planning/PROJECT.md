# Principles Disciple (PD)

## What This Is

OpenClaw plugin for self-evolving AI agents. Learns from pain signals (tool failures, user friction), performs root-cause diagnosis, extracts explicit principles, and continuously improves behavior through a structured evolution loop. The agent gets "smarter" by internalizing lessons as reusable principles.

## Core Value

自演化 AI 代理通过痛点信号学习并通过显式原则表达实现自我改进。

The agent must be able to: detect pain → diagnose root cause → extract principle → apply it future. Every failure is a learning opportunity.

---

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- **SDK Integration** — OpenClaw v2026.4.x compatibility, factory-pattern tool registration — v1.0
- **Memory Search (FTS5)** — Native FTS5 search on pain_events table, replacing deprecated createMemorySearchTool — v1.4
- **Empathy Observer Workflow** — `EmpathyObserverWorkflowManager` + `RuntimeDirectDriver` + `WorkflowStore`, runtime_direct only — v1.4
- **Deep Reflect Workflow** — `DeepReflectWorkflowManager` + `RuntimeDirectDriver` + `WorkflowStore` — v1.4
- **Workflow Event Trace** — SQLite-based `WorkflowStore` with full state transition audit trail — v1.4
- **Pain Detection & Evolution Queue** — Pain flag → queue → diagnosis → principle creation pipeline — v1.0
- **Gate Split** — Separate gate module into independent concerns (gate.ts → gate-block-helper.ts, gfi-gate.ts) — v1.0
- **Input Quarantine** — PD-specific input isolation layer — v1.0
- **Defaults & Errors** — Centralized configuration and error handling — v1.0
- **NocturnalWorkflowManager** — Migrated `OpenClawTrinityRuntimeAdapter` to WorkflowManager interface; unified subagent lifecycle with stub-based fallback and enhanced debug summary — v1.5

### Active

<!-- Current scope. Building toward these. -->

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- **Diagnostician helper migration** —刚跑通，风险极高，短期内不动 — 2026-04-05
- **Mobile UI / 伙伴体验 (Companion Experience)** — V1.4 预研草案，完成核心进化闭环后再做 — 2026-03-07
- **Real-time chat / 实时对话** — 不是核心价值，高复杂度，defer — 2026-03-07
- **Video posts** — Storage/bandwidth 成本，defer — 2026-03-07
- **Auto-deployment of principles** — Phase 3+ only, not in current roadmap — 2026-03-07

---

## Context

**Technical environment**: OpenClaw v2026.4.x plugin, TypeScript, SQLite (via workflow store), Node.js

**Architecture**: Helper workflows (Empathy/DeepReflect) use `WorkflowManager` + `RuntimeDirectDriver` + `WorkflowStore`. Diagnostician uses queue + HEARTBEAT.md + file signaling (different pattern, not migrating).

**Subagent helper pattern**: All helper subagents go through `WorkflowManager` interface with `RuntimeDirectDriver`. This provides: idempotent lifecycle, SQLite event persistence, TTL-based orphan cleanup, surface degrade checks.

**Key interface**: `SubagentWorkflowSpec<T>` + `WorkflowManager` + `TransportDriver` (defined in `subagent-workflow/types.ts`).

---

## Constraints

- **Tech Stack**: TypeScript, OpenClaw plugin API, SQLite for persistence, no external databases
- **OpenClaw Compatibility**: Plugin must maintain compatibility with OpenClaw v2026.4.x API surface
- **No Shadow Parity**: PR2 introduced runtime_direct boundary — no legacy path to compare against
- **PD-Only Changes**: Modifies only `packages/openclaw-plugin`, no changes to `~/code/openclaw`

---

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Empathy as runtime_direct only | No registry_backed semantics needed for empathy observer | ✓ Good |
| subagent_ended as fallback only | Not a reliable primary contract; observation/fallback signal | ✓ Good |
| Nocturnal uses TrinityRuntimeAdapter | Phase 6 already implemented with adapter pattern | ✓ Good |
| Diagnostician not migrated to helper |刚跑通，dual-path (subagent_ended + heartbeat) 重构风险极高 | ⚠️ Revisit |
| WorkflowStore over in-memory | Persistence needed for audit trail and orphan cleanup | ✓ Good |

---

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-06 after Phase 09 (v1.5) complete*
