# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, proposes candidate principles, gates them through trust and scoring, and promotes validated principles into active use. The repo also contains `ai-sprint-orchestrator`, a long-running multi-stage task runner.

## Core Value

AI agents improve their own behavior through a structured loop:

pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## Validated

- Runtime `Rule Host`, replay evaluation, and manual implementation lifecycle flows exist
- Nocturnal background reflection pipeline exists and can emit production-facing artifacts
- Minimal rule bootstrap and live replay validation shipped in `v1.12`
- CI and lint baseline are green from `v1.9.3`

## Active

- Production stabilization is more important than new surface features
- Boundary contracts around workspace resolution, runtime capability checks, and critical state-file parsing are the current bottleneck
- End-to-end trust in nocturnal depends on fail-fast behavior, not silent fallback

## Out of Scope

- Thinking Models page improvements during this milestone
- New UI/dashboard work
- LoRA or full fine-tune internalization paths
- General cleanup not tied to boundary risk reduction

## Context

- Main runtime lives in `packages/openclaw-plugin/src/`
- Primary production path under scrutiny: pain -> queue -> nocturnal -> replay -> promotion
- Recent production debugging showed repeated failures from wrong workspace resolution, runtime capability guessing, and format drift
- Existing milestone state had drifted; `v1.13` resets planning to the actual current problem

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stabilize production path before new UI work | A richer UI is low value if the underlying loop is not trustworthy | Active |
| Prefer fail-fast over fallback | Silent fallback caused hidden corruption and delayed failures | Active |
| Introduce one contract per boundary type | Path, runtime, and schema logic must stop being reimplemented ad hoc | Active |
| Use end-to-end tests for boundary protection | Unit tests did not catch integration drift with OpenClaw | Active |

## Current Milestone: v1.13 Boundary Contract Hardening

**Goal:** Eliminate the recurring "implicit assumption + silent fallback" failure mode so nocturnal and principle-internalization flows fail fast, write to the correct workspace, and carry validated data end-to-end.

**Target features:**
- Single workspace resolution contract across hooks, commands, workers, and HTTP routes
- Schema-validated parsing for critical state files and snapshot inputs
- Runtime capability contract for background subagent usage without constructor-name guessing
- End-to-end contract tests for pain -> queue -> nocturnal and command/hook workspace writes

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? Move to Out of Scope with reason
2. Requirements validated? Move to Validated with phase reference
3. New requirements emerged? Add to Active
4. Decisions to log? Add to Key Decisions
5. "What This Is" still accurate? Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check
3. Audit Out of Scope
4. Update Context with current state

*Last updated: 2026-04-11 after v1.13 milestone started*
