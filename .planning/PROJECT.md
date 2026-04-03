# Project: Principles Disciple — v1.0-alpha

## What This Is

AI agent self-evolution framework as an OpenClaw plugin. Drives AI agent self-improvement through pain signal detection, trust-based access control, and principle lifecycle management.

## Core Value

Self-evolving AI agents that learn from pain signals and improve through explicit principle articulation.

## Current Milestone: v1.2 代码质量提升

**Goal:** 系统性清理技术债务，建立自动化质量门禁，提升代码可维护性和类型安全性。

**Target improvements:**
- 🔧 修复编译产物路径混乱 — 清理 `core/` 目录中的编译产物
- 🛡️ 消除 `any` 类型滥用 — 生产代码从 160+ 处降至 <80 处
- 📝 统一日志系统 — 替换 84 处 `console.log` 为 `plugin-logger`
- 🚪 添加 ESLint 质量门禁 — 自动化代码审查
- 🪤 修复空 catch 块 — 消除静默错误吞噬
- 📦 测试质量提升 — 减少 600+ 处 `as any` mock

## Current State

**Version:** v1.1 (shipped 2026-04-02)
**Milestone:** v1.1 WebUI 回路流程增强 ✅ → v1.2 代码质量提升
**Focus:** 技术债清理 + 质量门禁建立

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

- [ ] v1.2: 代码质量提升 — 技术债清理 + 质量门禁建立

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
