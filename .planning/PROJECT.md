# Principles — AI Agent Principle Evolution System

## What This Is

A principle evolution system for AI coding agents: detects pain points (tool failures, user friction, empathy signals), generates candidate principles, gates them through a trust/scoring pipeline, and promotes validated principles to active use. Includes a WebUI dashboard, OpenClaw plugin for hook integration, and an ai-sprint-orchestrator for complex multi-stage tasks.

## Core Value

AI agents that improve their own behavior through structured principle evolution — pain → diagnosis → principle → gate → active → reflection → training → internalization.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- ✓ WebUI dashboard with overview/loop/feedback/gate pages — v1.1
- ✓ 7 API endpoints for system health, evolution, feedback, gate monitoring — v1.1
- ✓ ai-sprint-orchestrator with producer/reviewer/decision pipeline — v1.0-v1.1
- ✓ Contract enforcement schema validation — v1.1
- ✓ Decision engine with outputQuality scoring — v1.1
- ✓ Nocturnal background reflection pipeline (phases 0-6) — v1.0

### Active

<!-- Current scope. Building toward these. -->

- [ ] Workflow acceptance checklist readable, executable, handoff-ready
- [ ] Minimal validation runs prove workflow stability (2 runs non-halt)
- [ ] Skill/operator package for ai-sprint-orchestrator in skills/ai-sprint-orchestration/
- [ ] Unified entry point for agents using the orchestrator

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- packages/openclaw-plugin fixes (helper fallback lifecycle, expired cleanup) — known sample-side gaps, not blocking skill packaging
- D:/Code/openclaw modifications — out of repo scope
- Dashboard / stageGraph / self-optimizing sprint / multi-task parallelism — future, not this milestone
- PR2/PD product loop closure — today's done = workflow stable + skill packaged

## Context

- ai-sprint-orchestrator is a multi-stage task runner: producer generates, reviewers evaluate, decision engine scores and advances/revises/halts
- Key modules: run.mjs (orchestrator), decision.mjs (scoring), contract-enforcement.mjs (schema validation), state-store.mjs (persistence)
- Tests exist: contract-enforcement.test.mjs, decision.test.mjs, run.test.mjs
- Validation specs exist: workflow-validation-minimal.json, workflow-validation-minimal-verify.json
- OpenClaw plugin has known issues (session routing, hook lifecycle) documented separately
- WebUI v1.1 complete with all 24 requirements done

## Constraints

- **Scope boundary**: Only ai-sprint-orchestrator workflow plumbing; no product-side changes
- **Test gate**: All 3 baseline test suites must pass before validation runs
- **Failure classification**: Fixed to 4 categories — workflow bug / agent behavior issue / environment issue / sample-spec issue
- **Platform**: Windows (D:\Code\principles), cross-platform scripts preferred

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Skill package at skills/ai-sprint-orchestration/ | Standard location, discoverable by other agents | — Pending |
| Only minimal validation specs for acceptance | Avoid scope creep, prove workflow stability not product completeness | — Pending |
| Failure classification fixed to 4 categories | Prevents ambiguous "not sure what went wrong" situations | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd:transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd:complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

## Current Milestone: v1.2 Workflow v1 最终收口与技能化

**Goal:** 把 ai-sprint-orchestrator 收口到"智能体可稳定使用"的程度，并做成 repo 内可复用 skill/operator 包。

**Target features:**
- Fix acceptance checklist to readable/executable/handoff-ready
- Prove workflow stability via minimal validation runs
- Create skills/ai-sprint-orchestration/ package (SKILL.md + 3 PROMPTS)
- Unified agent entry point

---
*Last updated: 2026-04-05 after milestone v1.2 initialization*
