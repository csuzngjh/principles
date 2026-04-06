# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, proposes candidate principles, gates them through trust and scoring, and promotes validated principles into active use. The repo also contains `ai-sprint-orchestrator`, a long-running multi-stage task runner.

## Core Value

AI agents improve their own behavior through a structured loop:

pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## Validated

- WebUI dashboard with overview, loop, feedback, and gate pages
- System health, evolution, feedback, and gate-monitoring APIs
- `ai-sprint-orchestrator` producer/reviewer/decision pipeline
- Contract enforcement and schema validation
- `outputQuality` decision scoring
- Nocturnal background reflection pipeline

## Active

- acceptance checklist is readable and handoff-ready
- baseline tests and package-local validation runs define workflow readiness
- `packages/openclaw-plugin/templates/langs/{zh,en}/skills/ai-sprint-orchestration/` is the packaged delivery target
- another agent can start from the skill package instead of repo-root orchestrator paths
- validation runs stop after classification when they hit sample-side or product-side gaps
- workflow v1.3 focuses on internal usability first, then finer-grained work-unit architecture

## Out of Scope

- `packages/openclaw-plugin` product-side fixes
- `D:/Code/openclaw` changes
- dashboard / stageGraph / self-optimizing sprint / parallel task scheduling
- PR2 / PD product loop closure

## Context

- main workflow source of truth: `packages/openclaw-plugin/templates/langs/zh/skills/ai-sprint-orchestration`
- packaged release target: `packages/openclaw-plugin/templates/langs/{zh,en}/skills/ai-sprint-orchestration`
- baseline tests: `contract-enforcement`, `decision`, `run`
- package-local validation specs: `workflow-validation-minimal`, `workflow-validation-minimal-verify`
- complex task templates: `bugfix-complex-template`, `feature-complex-template`
- known product-side gaps remain documented but excluded from this milestone

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Package-local script closure | released agents will not have the full repo layout | Active |
| Package-local runtime root | packaged runs must not depend on `ops/ai-sprints` | Active |
| Minimal validation specs only | prove workflow behavior without product-side scope creep | Active |
| Classify-and-stop on sample-side issues | keep workflow-first boundary intact | Active |
| v1.3 prioritizes internal usability | use the skill ourselves before redesigning the orchestrator | Active |
| next architecture step is work-unit/tasklet | stage/round/role resets are not enough for very complex long tasks | Planned |

## Current Milestone

### v1.3 Workflow Skill Internal Usability

Goal:

- make the packaged orchestrator skill usable for internal complex tasks
- persist structured failure classification into run artifacts
- provide complex bugfix/feature templates with a minimum task contract
- tighten continuation carry-forward with checkpoint summaries
- define the next work-unit architecture direction without implementing it yet

Target features:

- readable package-local acceptance checklist
- package-local references and validation specs
- runnable package-local `scripts/run.mjs`
- baseline plus package-local validation runs
- package-local complex task templates
- checkpoint-based carry-forward

---
*Last updated: 2026-04-06*
