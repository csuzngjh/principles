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
- Boundary contracts for workspace resolution, pain flag, nocturnal snapshot, and runtime capability shipped in `v1.13`
- Fail-fast pattern validated for system boundaries (path, schema, runtime)

## Active

- Evolution worker slimmed to lifecycle orchestration (TaskContextBuilder + SessionTracker extracted) — contract hardening next
- Queue persistence, pain detection, task dispatch, workflow orchestration, and context building each need dedicated modules with boundary contracts
- 16 silent fallback points in evolution-worker audited and classified (fail-fast vs fail-visible) — fully wired to EventLog
- Replay engine input contracts remain deferred until worker decomposition is stable

## Out of Scope

- Thinking Models page improvements
- New UI/dashboard work
- LoRA or full fine-tune internalization paths
- General cleanup not tied to boundary risk reduction
- Replay engine contract hardening (deferred to next milestone)

## Context

- Main runtime lives in `packages/openclaw-plugin/src/`
- Primary production path under scrutiny: pain -> queue -> nocturnal -> replay -> promotion
- v1.13 established boundary contracts at pain/nocturnal/workspace/runtime entry points
- evolution-worker.ts (2133 lines) is the central nervous system — too large to safely add contracts to
- Worker has 9 responsibility clusters, 16 silent fallback points, and natural seam points identified
- Existing contract patterns (buildPainFlag, resolveRequiredWorkspaceDir, validateNocturnalSnapshotIngress) serve as templates for new contracts

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Stabilize production path before new UI work | A richer UI is low value if the underlying loop is not trustworthy | Active |
| Prefer fail-fast over fallback | Silent fallback caused hidden corruption and delayed failures | Active |
| Introduce one contract per boundary type | Path, runtime, and schema logic must stop being reimplemented ad hoc | Active |
| Use end-to-end tests for boundary protection | Unit tests did not catch integration drift with OpenClaw | Active |
| Decompose before contracting | Cannot add contracts to a 2133-line monolith; responsibilities must be separated first | Active |
| Fail-fast at boundary entry, fail-visible in pipeline middle | Background worker should not crash on bad data mid-stream, but must surface it structurally | Active |

## Current Milestone: v1.14 Evolution Worker Decomposition & Contract Hardening

**Goal:** Decompose the 2133-line evolution-worker.ts into focused modules and equip each with boundary contracts (input validation + fail-fast/fail-visible), making the production pipeline's central nervous system maintainable and trustworthy.

**Target features:**
- EvolutionQueueStore — queue persistence, V2 migration, file locking (extracted from worker)
- PainFlagDetector — pain flag detection and parsing (extracted from worker)
- EvolutionTaskDispatcher — task dispatch and execution logic (extracted from worker)
- WorkflowOrchestrator — workflow watchdog and expiry cleanup (extracted from worker)
- TaskContextBuilder — context extraction and snapshot building (extracted from worker)
- Boundary contracts on each extracted module (input validation + structured errors)
- Audit of 16 silent fallback points: reclassify as fail-fast or fail-visible

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

*Last updated: 2026-04-11 after v1.14 milestone started*
