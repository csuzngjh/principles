# Project: Principles Disciple — v1.0-alpha

## What This Is

AI agent self-evolution framework as an OpenClaw plugin. Drives AI agent self-improvement through pain signal detection, trust-based access control, and principle lifecycle management.

## Core Value

Self-evolving AI agents that learn from pain signals and improve through explicit principle articulation.

## Current Milestone: v1.1 WebUI 回路流程增强

**Goal:** 将 WebUI 从"功能视角"重构为"流程视角"，按回路组织页面，直观展示增强回路、反馈回路和 Gate 系统的完整流程。

**Target features:**
- 📊 系统概览增强 — GFI/PainFlag/Trust/EP 健康度卡片 + Mini 流程图
- 🔄 增强回路页面 — 完整"痛点→内化"链路（含夜间训练延伸）
- 📡 反馈回路页面 — GFI 仪表盘 + 同理心检测 + Gate 拦截关联
- 🔐 Gate 监控页面 — 拦截统计 + Trust & EP 双轨仪表盘

## Current State

**Version:** v1.0-alpha (shipped 2026-03-26)
**Milestone:** Control Plane Cleanup → v1.1 WebUI 回路流程增强
**Focus:** Phase 3 shadow capability work → WebUI 回路可视化

## Phase 3 Foundation (v1.0-alpha)

Completed foundational control plane architecture:
- Input quarantine with authoritative/rejected/reference_only classification
- `evolution_directive` demoted to compatibility-only display artifact
- Runtime truth vs analytics truth boundary established
- gate.ts split into 6 isolated modules (72% size reduction)
- Centralized defaults and domain-specific errors

## Requirements

### Validated

- ✓ A0: Phase 3 Input Quarantine — v1.0-alpha
- ✓ A1: Demote `evolution_directive` to compatibility-only — v1.0-alpha
- ✓ A2: Runtime truth vs analytics truth boundary — v1.0-alpha
- ✓ A3: Split gate.ts by responsibility — v1.0-alpha
- ✓ A4: Centralize default configuration — v1.0-alpha
- ✓ A5: Normalize domain error semantics — v1.0-alpha

### Active

- [ ] v1.1: WebUI 回路流程增强 — 按回路组织页面，覆盖增强/反馈/Gate 完整链路
- [ ] Phase 4: Shadow capability enablement
- [ ] Phase 5: Trust stage visualization

### Out of Scope

- Mobile app support
- Multi-workspace aggregation
- Public plugin marketplace
- 训练管线修改（夜间模式后端已实现，本里程碑仅做可视化）

## Key Decisions

| Decision | Rationale | Status |
|----------|----------|--------|
| Queue is only Phase 3 truth source | Clean inputs essential for shadow capability | ✓ Established |
| Directive is display-only | Prevents stale state from contaminating decisions | ✓ Established |
| Gate split before shadow work | Easier to evolve modules independently | ✓ Established |
| WebUI 按回路组织页面 | 用户需要流程视角而非功能视角 | — Pending |
| 夜间训练纳入增强回路 | 是原则内化的自然延伸，不是独立回路 | — Pending |
| 本里程碑仅做可视化，不改后端 | 夜间模式后端已实现 (Phase 0-6) | — Pending |
| WebUI 按回路组织页面 | 用户需要流程视角而非功能视角 | — Pending |
| 夜间训练纳入增强回路 | 是原则内化的自然延伸，不是独立回路 | — Pending |
| 本里程碑仅做可视化，不改后端 | 夜间模式后端已实现 (Phase 0-6) | — Pending |

## Context

**Tech Stack:**
- TypeScript (ESM, strict mode)
- Vitest for testing
- better-sqlite3 for trajectory database
- OpenClaw SDK plugin interface

**Codebase:**
- `packages/openclaw-plugin/` — Main plugin
- `packages/create-principles-disciple/` — CLI installer
- `src/config/` — Centralized defaults and errors
- `src/hooks/` — Gate modules (post-split)

**Known Issues:**
- 17 pre-existing test failures (Windows temp file cleanup)

## Constraints

- GFI gate stays disabled until production ready
- Trust authority remains with trust-engine (not capability)
- All tests must pass before enabling new features

---

*Last updated: 2026-04-02 after v1.1 milestone started*

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
