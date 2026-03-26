# Project: Principles Disciple — v1.0-alpha

## What This Is

AI agent self-evolution framework as an OpenClaw plugin. Drives AI agent self-improvement through pain signal detection, trust-based access control, and principle lifecycle management.

## Core Value

Self-evolving AI agents that learn from pain signals and improve through explicit principle articulation.

## Current State

**Version:** v1.0-alpha (shipped 2026-03-26)
**Milestone:** Control Plane Cleanup
**Focus:** Phase 3 shadow capability work

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

- [ ] Phase 4: Shadow capability enablement
- [ ] Phase 5: Trust stage visualization

### Out of Scope

- Mobile app support
- Multi-workspace aggregation
- Public plugin marketplace

## Key Decisions

| Decision | Rationale | Status |
|----------|----------|--------|
| Queue is only Phase 3 truth source | Clean inputs essential for shadow capability | ✓ Established |
| Directive is display-only | Prevents stale state from contaminating decisions | ✓ Established |
| Gate split before shadow work | Easier to evolve modules independently | ✓ Established |

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

*Last updated: 2026-03-26 after v1.0-alpha milestone*
