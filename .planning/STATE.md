---
gsd_state_version: 1.0
milestone: v1.20
milestone_name: milestone
status: planning
last_updated: "2026-04-17T02:46:35.318Z"
progress:
  total_phases: 4
  completed_phases: 0
  total_plans: 1
  completed_plans: 0
  percent: 0
---

# Project State: Principles

## Project Reference

**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

**Current Focus:** Phase 00b — adapter-abstraction

## Current Position

Phase: 00b (adapter-abstraction) — EXECUTING
Plan: 1 of 3
**Phase:** 01
**Plan:** Not started
**Status:** Ready to plan
**Progress:** [--------------------] 0%

## Performance Metrics

- **Principle Stock:** TBD (Measuring in Phase 0a)
- **Sub-principle Ratio:** TBD (Measuring in Phase 0a)
- **Association Rate (Pain -> Principle):** TBD (Measuring in Phase 0a)
- **Internalization Rate:** TBD (Measuring in Phase 0a)
- **Pain Processing p99:** TBD (Target < 50ms)
- **Principle Injection p99:** TBD (Target < 100ms)

## Accumulated Context

### Decisions

- SDK is built "from zero" for framework-agnosticism.
- `evolution-worker.ts` is preserved as the functional core, not split further.
- Phase 1.5 added for extreme-case validation before Semver freeze.

### Todos

- [ ] Measure baseline observability metrics (Phase 0a)
- [ ] Define PainSignal and StorageAdapter interfaces (Phase 0a)
- [ ] Implement malformed signal validation (Phase 0a)
- [ ] Design generic adapter interfaces (Phase 0b)
- [ ] Select extreme-case domain for Phase 1.5 validation (Phase 1)

### Blockers

- None.

## Session Continuity

**Last Session:**

2026-04-17T01:22:42.101Z

- Initialized ROADMAP.md, STATE.md, and updated PROJECT.md.
- Defined phases 0a, 0b, 1, and 1.5.

**Next Session:**

- Start Phase 0a: Interface & Core.
- Begin defining the universal PainSignal schema.
