# Requirements: Principles Disciple - WebUI Data Source Fixes

**Defined:** 2026-04-08
**Core Value:** AI agents improve their own behavior through a structured loop: pain -> diagnosis -> principle -> gate -> active -> reflection -> training -> internalization

## v1.9.1 Requirements

### Data Source Tracing

- [ ] **TRACE-01**: Map all 4 pages (Overview, Loop, Feedback, Gate Monitor) to their API endpoints, route handlers, service methods, and database queries
- [ ] **TRACE-02**: Document actual response shapes vs TypeScript type declarations for each endpoint

### Overview Page Data Fix

- [ ] **OVER-01**: Fix `/api/central/overview` inline route assembly — verify all CentralDatabase queries return correct fields
- [ ] **OVER-02**: Fix `/api/overview` — verify ControlUiQueryService.getOverview() returns correct data shape
- [ ] **OVER-03**: Fix `/api/overview/health` — verify HealthQueryService returns expected fields

### Loop/Samples Page Data Fix

- [ ] **LOOP-01**: Fix `/api/samples` — verify listSamples() query and response fields
- [ ] **LOOP-02**: Fix `/api/samples/:id` — verify sample detail data source

### Feedback Page Data Fix

- [ ] **FB-01**: Fix `/api/feedback/gfi` — verify GFI data source and field mapping
- [ ] **FB-02**: Fix `/api/feedback/empathy-events` — verify empathy events data source
- [ ] **FB-03**: Fix `/api/feedback/gate-blocks` — verify gate blocks data source

### Gate Monitor Page Data Fix

- [ ] **GATE-01**: Fix `/api/gate/stats` — verify gate stats data source and field mapping
- [ ] **GATE-02**: Fix `/api/gate/blocks` — verify gate blocks data source

### Frontend Field Mapping

- [ ] **FE-01**: Fix all frontend TypeScript types to match actual backend responses
- [ ] **FE-02**: Fix all frontend component field accessors to match actual response keys

### End-to-End Validation

- [ ] **E2E-01**: Validate all 4 pages display correct data after fixes
- [ ] **E2E-02**: Add validation tests to prevent future data source drift

## Out of Scope

| Feature | Reason |
|---------|--------|
| UI visual/style changes | Milestone focuses on data layer only, not redesign |
| New dashboard pages | Only fix existing 4 pages |
| Performance optimization | Focus on correctness first |
| API redesign/refactoring | Fix existing APIs, don't rearchitect |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TRACE-01 | 16 | Pending |
| TRACE-02 | 16 | Pending |
| OVER-01 | 17 | Pending |
| OVER-02 | 17 | Pending |
| OVER-03 | 17 | Pending |
| LOOP-01 | 18 | Pending |
| LOOP-02 | 18 | Pending |
| FB-01 | 18 | Pending |
| FB-02 | 18 | Pending |
| FB-03 | 18 | Pending |
| GATE-01 | 19 | Pending |
| GATE-02 | 19 | Pending |
| FE-01 | 19 | Pending |
| FE-02 | 19 | Pending |
| E2E-01 | 20 | Pending |
| E2E-02 | 20 | Pending |

**Coverage:**
- v1.9.1 requirements: 16 total
- Mapped to phases: 16 (100%)
- Unmapped: 0

---
*Requirements defined: 2026-04-08*
*Last updated: 2026-04-08 after v1.9.1 milestone initialized*
