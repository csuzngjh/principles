# Roadmap: v1.9.1 — WebUI Data Source Fixes

**Milestone:** v1.9.1
**Status:** Planning
**Architecture Doc:** `.planning/research/ARCHITECTURE.md`
**Date:** 2026-04-08

## Phases

Phase numbering continues from v1.9.0 (ended at Phase 15).

| Phase | Name | Description | Requirements | Depends on | Status |
|-------|------|-------------|--------------|------------|--------|
| 16 | Data Source Tracing | Map all 4 pages to API endpoints, route handlers, service methods, and DB queries. Document actual response shapes vs TypeScript type declarations. | TRACE-01, TRACE-02 | None | Pending |
| 17 | Overview Page Data Fix | Fix `/api/central/overview` inline route assembly, `/api/overview` ControlUiQueryService, and `/api/overview/health` HealthQueryService. Highest risk — inline assembly bypasses service layer. | OVER-01, OVER-02, OVER-03 | Phase 16 | Pending |
| 18 | Loop/Samples + Feedback Page Fixes | Fix `/api/samples`, `/api/samples/:id`, `/api/feedback/gfi`, `/api/feedback/empathy-events`, `/api/feedback/gate-blocks` data sources and field mappings. | LOOP-01, LOOP-02, FB-01, FB-02, FB-03 | Phase 16 | Pending |
| 19 | Gate Monitor + Frontend Field Mapping | Fix `/api/gate/stats`, `/api/gate/blocks` data sources. Fix all frontend TypeScript types and component field accessors to match actual backend responses. | GATE-01, GATE-02, FE-01, FE-02 | Phase 16 | Pending |
| 20 | End-to-End Validation | Validate all 4 pages display correct data after fixes. Add regression tests to prevent future data source drift. | E2E-01, E2E-02 | Phases 17, 18, 19 | Pending |

## Dependencies (from v1.9.0)

- v1.9.0 completed Phases 11-15 (Principle Internalization System)
- All WebUI pages and API routes exist but have data source issues
- Dual database model: ControlUiDatabase (per-workspace) vs CentralDatabase (cross-workspace)
- `/api/central/overview` assembles response inline in route handler — key risk area

## Phase Dependency Graph

```
Phase 16 (TRACE) ─────────────────┐
                                   ├──▶ Phase 17 (Overview) ──┐
                                   ├──▶ Phase 18 (Loop+Feedback)├──▶ Phase 20 (E2E)
                                   └──▶ Phase 19 (Gate+Frontend)┘
```

Phases 17, 18, 19 can run in parallel after Phase 16 completes (all depend only on tracing output). Phase 20 requires all fix phases to be done.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `/api/central/overview` inline assembly is riskiest — no service layer abstraction | High | Phase 16 must fully document this path before any fixes |
| Dual DB model confusion — reading from wrong database | High | Phase 16 tracing must clarify which DB each endpoint uses |
| TypeScript type drift — frontend types don't match runtime data | Medium | TRACE-02 documents actual shapes; FE-01/FE-02 fix mismatches |
| SQLite connection leaks from improper service disposal | Low | Existing `finally` block in route handler — verify, don't rewrite |
| Visual regression during data fixes | Low | Explicit constraint: visual layer stays unchanged |

## Out of Scope

- UI visual/style changes
- New dashboard pages
- Performance optimization
- API redesign/refactoring

## Success Criteria

| Phase | Success Criteria |
|-------|-----------------|
| 16 | All 4 pages traced to DB queries; response shape document matches runtime output |
| 17 | Overview page shows correct KPIs, daily trend, regression list, and health metrics |
| 18 | Samples page shows correct queue; Feedback page shows correct GFI, empathy events, gate blocks |
| 19 | Gate Monitor shows correct stats and blocks; all frontend types match backend responses |
| 20 | All 4 pages validated with correct data; regression tests pass on CI |

### Phase 1: --help

**Goal:** [To be planned]
**Requirements**: TBD
**Depends on:** Phase 0
**Plans:** 0 plans

Plans:
- [ ] TBD (run /gsd-plan-phase 1 to break down)

### Phase 5: Gate Monitor + Frontend Field Mapping

**Goal:** Fix `/api/gate/stats`, `/api/gate/blocks` data sources. Fix all frontend TypeScript types and component field accessors to match actual backend responses.
**Requirements**: GATE-01, GATE-02, FE-01, FE-02
**Depends on:** Phase 16
**Plans:** 2 plans

Plans:
- [x] 19-01-PLAN.md — Verify /api/gate/stats and /api/gate/blocks backend service layer
- [x] 19-02-PLAN.md — Verify frontend TypeScript types and component field accessors

---

*Last updated: 2026-04-09 after Phase 19 planning*
