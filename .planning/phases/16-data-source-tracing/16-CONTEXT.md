# Phase 16: Data Source Tracing — Context

**Phase:** 16
**Milestone:** v1.9.1 — WebUI 数据源修复
**Date:** 2026-04-08

## Domain

Map all 4 WebUI pages (Overview, Samples/Loop, Feedback, Gate Monitor) to their complete data flows: DB → Service → Route Handler → API Response → Frontend Types → Frontend Field Access. Document actual response shapes vs TypeScript type declarations. Fix trivial mismatches found during tracing.

## Canonical Refs

| Ref | Path |
|-----|------|
| Frontend API client | `packages/openclaw-plugin/ui/src/api.ts` |
| Frontend types | `packages/openclaw-plugin/ui/src/types.ts` |
| HTTP route handler | `packages/openclaw-plugin/src/http/principles-console-route.ts` |
| Control UI query service | `packages/openclaw-plugin/src/service/control-ui-query-service.ts` |
| Central database | `packages/openclaw-plugin/src/service/central-database.ts` |
| Health query service | `packages/openclaw-plugin/src/service/health-query-service.ts` |
| Evolution query service | `packages/openclaw-plugin/src/service/evolution-query-service.ts` |
| Control UI DB | `packages/openclaw-plugin/src/core/control-ui-db.ts` |
| Overview page | `packages/openclaw-plugin/ui/src/pages/OverviewPage.tsx` |
| Samples page | `packages/openclaw-plugin/ui/src/pages/SamplesPage.tsx` |
| Feedback page | `packages/openclaw-plugin/ui/src/pages/FeedbackPage.tsx` |
| Gate Monitor page | `packages/openclaw-plugin/ui/src/pages/GateMonitorPage.tsx` |

## Decisions

### Tracing Approach
- **Hybrid method**: Static code analysis (read route handlers, services, DB queries) + runtime verification via temporary debug endpoint
- **Debug endpoint**: Add temporary `/api/debug/shapes` endpoint that hits all 13 API endpoints, extracts actual field names and types, returns structured comparison with frontend types
- **Deliverables**: Markdown report + JSON schema files documenting actual vs expected shapes

### Fix Strategy
- **Fix whichever side is wrong** — if backend returns `total_failures` but frontend types declare `totalFailures`, fix the frontend type; if frontend type is correct but backend returns wrong field, fix the backend
- **Fix trivial mismatches during tracing** — typos, obvious field name differences, missing optional fields
- **Defer non-trivial fixes** — architectural issues (inline route assembly, wrong data source) go to Phases 17-19

### Documentation Format
- **Markdown report**: `16-data-source-tracing/DATA-FLOW-REPORT.md` — human-readable, one section per page with flow diagram and mismatches
- **JSON schema files**: `16-data-source-tracing/actual-shapes.json` — machine-readable, one entry per API endpoint with actual field names and types, for future automated validation

### Scope Boundary
- **In scope**: 4 existing pages, their 13 API endpoints, type declarations, field accessors
- **Out of scope**: Visual changes, new pages, performance optimization, API redesign

## Prior Decisions Applied

- From v1.9.0: Principle Internalization System is live; no impact on WebUI data flows
- From architecture research: Dual DB model (ControlUiDatabase per-workspace vs CentralDatabase cross-workspace) must be traced carefully
- From architecture research: `/api/central/overview` assembles response inline in route handler — highest risk area

## Technical Context

### API Endpoint Map (13 endpoints)

| Endpoint | Route Handler Location | Service | Database |
|----------|----------------------|---------|----------|
| `GET /api/overview` | done() wrapper | ControlUiQueryService.getOverview() | ControlUiDatabase |
| `GET /api/central/overview` | **inline assembly** | — | CentralDatabase |
| `GET /api/overview/health` | done() wrapper | HealthQueryService | workspace data sources |
| `GET /api/samples` | done() wrapper | ControlUiQueryService.listSamples() | ControlUiDatabase |
| `GET /api/samples/:id` | done() wrapper | ControlUiQueryService.getSampleDetail() | ControlUiDatabase |
| `POST /api/samples/:id/review` | done() wrapper | ControlUiQueryService.reviewSample() | ControlUiDatabase |
| `GET /api/feedback/gfi` | done() wrapper | HealthQueryService.getGfi() | workspace data sources |
| `GET /api/feedback/empathy-events` | done() wrapper | HealthQueryService.getEmpathyEvents() | ControlUiDatabase |
| `GET /api/feedback/gate-blocks` | done() wrapper | HealthQueryService.getGateBlocks() | ControlUiDatabase |
| `GET /api/gate/stats` | done() wrapper | HealthQueryService.getGateStats() | workspace data sources |
| `GET /api/gate/blocks` | done() wrapper | HealthQueryService.getGateBlocks() | ControlUiDatabase |
| `GET /api/evolution/*` | done() wrapper | EvolutionQueryService | workspace data sources |
| `GET /api/thinking/*` | done() wrapper | ControlUiQueryService | ControlUiDatabase |

### Key Risk Areas
1. **Inline assembly** at `/api/central/overview` — bypasses service layer, 60+ lines of response construction
2. **Dual DB confusion** — some endpoints may read from wrong database
3. **Type drift** — `types.ts` interfaces may not match actual backend responses
4. **Empty arrays** — `sampleQueue.preview` is hardcoded to `[]` in inline assembly

## Requirements Mapped

- TRACE-01: Map all 4 pages to data sources
- TRACE-02: Document actual response shapes vs TypeScript types

---
*Context captured: 2026-04-08*
*Ready for: /gsd-plan-phase 16*
