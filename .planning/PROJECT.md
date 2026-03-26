# Project: Principles Disciple — Phase 3A Control Plane Cleanup

## What This Is

AI agent self-evolution framework (OpenClaw plugin). Current phase focuses on cleaning up control-plane architecture debt before Phase 3 shadow capability work.

## Context

**Project:** Principles Disciple  
**Type:** Brownfield — existing plugin with production history  
**Current Phase:** Phase 3A — Control Plane Convergence and Gate Cleanup  
**Started:** 2026-03-26

## Background

Phase 2.5 (control plane convergence) is complete. Production data analysis (2026-03-18 to 2026-03-26) revealed dirty inputs contaminating the system:

- `evolution_directive.json` is stale sidecar state
- Queue contains legacy lifecycle rows (`resolved`, `null status`)
- Trust schema not frozen (`frozen=false`)
- Task outcomes dominated by `timeout`
- Gate over-blocking (66 events, mostly line limits)

## Core Objective

Stop legacy state from contaminating Phase 3 shadow capability work. Clean inputs first, then refactor gate.ts.

## Phase Structure

Based on `docs/superpowers/plans/2026-03-26-phase-3-gate-cleanup.md`:

| Phase | Goal |
|-------|------|
| **Phase 3A** | Input quarantine + truth boundary cleanup |
| **Phase 3B** | gate.ts split by responsibility |
| **Phase 3C** | Defaults centralization + domain errors |

## Key Decisions

| Decision | Rationale | Status |
|----------|-----------|--------|
| A0→A1→A2 before A3 | Dirty inputs are current chaos source, not gate.ts structure | Active |
| Gate split after truth cleanup | Easier with explicit boundaries | Pending |
| GFI gate stays disabled | Production not ready for GFI enforcement | Preserved |

## Constraints

- Do not switch Gate authority to Capability in this phase
- Do not enable GFI gate
- Do not accept legacy inputs just to accelerate rollout
- Preserve all existing tests

## Production Evidence

- Latest sample: `D:\Code\spicy_evolver_souls`
- Observation window: 2026-03-18 to 2026-03-26
- Daily snapshots available via `scripts/collect-control-plane-snapshot.ps1`

---

*Last updated: 2026-03-26 after initialization*
