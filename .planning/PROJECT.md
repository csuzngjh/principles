# Principles - AI Agent Principle Evolution System

## What This Is

Principles is a principle-evolution system for AI coding agents. It detects pain signals, derives principles, and turns those principles into enforceable behavior through gates, nocturnal reflection, and implementation artifacts. The repo also contains `ai-sprint-orchestrator`, but the current milestone centers on the Principles Disciple product loop rather than orchestrator packaging work.

## Core Value

AI agents improve their own behavior through a structured loop:

pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## Requirements

### Validated

- WebUI dashboard with overview, loop, feedback, and gate pages
- System health, evolution, feedback, and gate-monitoring APIs
- `ai-sprint-orchestrator` producer/reviewer/decision pipeline
- Contract enforcement and schema validation
- `outputQuality` decision scoring
- Nocturnal background reflection pipeline
- Principle tree supports first-class Rule and Implementation entities (validated in Phase 11)

### Active

- [ ] code implementations can be stored, evaluated, promoted, and rolled back as principle-tree leaves
- [ ] nocturnal reflection can generate code implementation candidates in addition to behavioral training artifacts
- [ ] coverage, false positive, adherence, and deprecation eligibility are computed from real implementation outcomes
- [ ] principle internalization chooses the cheapest viable implementation path before escalating to heavier forms

### Validated in Phase 12

- [x] runtime gate chain includes a Rule Host between GFI and Progressive Gate (HOST-01 through HOST-04)
- [x] versioned code implementation storage with manifest, entry, and asset directory management (IMPL-01)
- [x] lifecycle states queryable from ledger, active code implementations run through fixed host contract (IMPL-02)
### Out of Scope

- `packages/openclaw-plugin` product-side fixes - outside this milestone’s architectural scope
- `D:/Code/openclaw` changes - outside this repo
- dashboard / stageGraph / self-optimizing sprint / parallel task scheduling - not part of the internalization foundation
- automatic code implementation deployment without replay validation - unsafe before replay and rollback loops are proven
- deleting `Progressive Gate` during v1.9.0 - host hard-boundary layer must remain until the new Rule Host path is trusted
- forcing every principle into code implementation - violates the “cheapest viable internalization first” strategy
- LoRA or full fine-tune pipeline execution buildout - reserved for later milestones after the code branch proves itself

## Context

- principle tree architecture is now the semantic source of truth: `Principle -> Rule -> Implementation`
- nocturnal reflection already has target selection, snapshot extraction, arbiter validation, executability checks, and artifact persistence
- new design docs define a Principle Internalization System with DHSE narrowed to the code implementation route
- current gate chain already has Thinking Checkpoint, GFI, Progressive Gate, and Edit Verification; this milestone inserts Rule Host without removing the hard boundaries
- `message-sanitize.ts` is the first planned simplification because it is peripheral to the internalization loop and conflicts with trajectory collection

## Constraints

- **Safety**: Preserve existing host hard boundaries (`Thinking`, `GFI`, `Progressive`, `Edit Verification`) until the new code implementation path is proven
- **Architecture**: Do not collapse Principle / Rule / Implementation into a single code-script layer
- **Execution Model**: Code implementations must run through a fixed host contract and helper whitelist, not arbitrary workspace IO
- **Promotion**: No automatic deployment before offline replay over negative, positive, and anchor samples
- **Scope**: Focus this milestone on `Implementation(type=code)` and its supporting ledger, replay, and nocturnal candidate flow
- **Versioning**: Milestone planning aligns to product version `v1.9.0`

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Principle Internalization System is the new top-level framing | principles must be routed into the cheapest viable implementation form, not defaulted to code | Active |
| DHSE is narrowed to the code implementation route | prevents code-generation logic from replacing the whole principle tree | Active |
| Progressive Gate stays during v1.9.0 | new Rule Host path is not mature enough to carry all capability boundaries alone | Active |
| Nocturnal becomes a multi-artifact research factory | behavioral samples and code implementation candidates require different output contracts | Active |
| Replay before promotion is mandatory | code implementations cannot be trusted without negative, positive, and anchor replay evidence | Active |

## Current Milestone: v1.9.0 Principle Internalization System

**Goal:** turn the current principle / nocturnal / gate architecture into a real Principle Internalization System with first-class Rule and Implementation entities, a constrained runtime Rule Host, replay-based code implementation promotion, and nocturnal code candidate generation.

**Target features:**
- Rule and Implementation CRUD in the principle tree store
- runtime Rule Host between GFI and Progressive Gate
- versioned code implementation storage with manifest, entry, tests, and eval artifacts
- offline replay over `pain-negative`, `success-positive`, and `principle-anchor` samples
- manual candidate promotion / disable / rollback loop
- nocturnal `RuleImplementationArtifact` pipeline
- first-pass coverage, false-positive, adherence, and deprecation accounting

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition**:
1. Requirements invalidated? -> Move to Out of Scope with reason
2. Requirements validated? -> Move to Validated with phase reference
3. New requirements emerged? -> Add to Active
4. Decisions to log? -> Add to Key Decisions
5. "What This Is" still accurate? -> Update if drifted

**After each milestone**:
1. Full review of all sections
2. Core Value check -> still the right priority?
3. Audit Out of Scope -> reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-07 after completing Phase 12*
