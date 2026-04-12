---
gsd_state_version: 1.0
milestone: v1.15
milestone_name: milestone
status: in_progress
last_updated: "2026-04-12T03:55:00.000Z"
last_activity: 2026-04-12
progress:
  total_phases: 4
  completed_phases: 2
  total_plans: 7
  completed_plans: 3
  percent: 43
---

# State: v1.15 Runtime & Truth Contract Hardening

## Project Reference

See `.planning/PROJECT.md` (updated 2026-04-12)

**Milestone:** v1.15
**Name:** Runtime & Truth Contract Hardening
**Core Value:** AI agents improve their own behavior through a structured evolution loop. pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization
**Current Focus:** Phase 32 - evidence-bound-export-and-dataset-hardening

## Previous Milestone (v1.14 baseline)

- **v1.14 BASELINE COMPLETE ON BRANCH:** Evolution worker decomposition finished on `fix/bugs-231-228` / PR #245
- Structural seams now exist for queue, pain, dispatcher, workflow, context, and fallback audit
- Remaining work before `main` trust is no longer module decomposition; it is runtime and truth contract hardening on top of that baseline

## Current Position

Phase: 32
Plan: planning pending
Status: Ready to plan
Last activity: 2026-04-12

Progress: [##---] 43%

## v1.15 Architecture Focus

### Root Problem

- Production failures now come from guessed runtime semantics and overstated exported facts
- Workspace/path boundaries were only the first layer; runtime adapters and evidence-bearing outputs are still under-contracted
- The system still risks surviving on logs and fallback behavior instead of explicit machine-checkable invariants

### Hardening Targets

- Runtime adapter boundary for OpenClaw-dependent execution semantics
- Workspace/session/model/provider ingress contracts before runtime execution
- Evidence-bound exports and datasets
- Production invariants and merge-gate verification for the stacked baseline on `fix/bugs-231-228`

### Planned Execution Order

1. Phase 30: Freeze diagnosis into a contract matrix and merge-gate checklist
2. Phase 31: Harden runtime adapters and add contract tests
3. Phase 32: Harden export/dataset truth semantics
4. Phase 33: Verify invariants and certify merge readiness

### Deferred Work

- Broad replay engine contract hardening
- Dictionary/rule matching contracts
- UI work and Thinking Models improvements

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- v1.13: Fail-fast at boundary entry, fail-visible in pipeline middle
- v1.14: Keep the decomposition baseline; do not throw away PR #245
- v1.15: Stack the next milestone on top of `fix/bugs-231-228` rather than creating a competing mainline
- v1.15: Facts for training/promotion must be evidence-backed; unknown stays unknown

### Pending Todos

- Baseline merge-gate fixes on PR #245 are being handled separately and are a dependency for clean merge, but not a blocker for planning v1.15

### Blockers/Concerns

- PR #245 still carries known merge-gate defects and is not mergeable yet
- PR #243 and PR #245 are diverged; new work must stack on top of PR #245 instead of trying to merge both into main independently

## Session Continuity

**Previous milestone:** v1.14 baseline complete on branch `fix/bugs-231-228` / PR #245
**Current milestone:** v1.15 - Runtime & Truth Contract Hardening
**Just completed:** `/gsd-execute-phase 31`
**Ready for:** `/gsd-plan-phase 32`
