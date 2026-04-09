# Phase 18: Loop/Samples + Feedback Page Fix — Context

**Gathered:** 2026-04-09
**Status:** Ready for planning
**Source:** ROADMAP.md + Phase 16 RESEARCH + Phase 17 execution patterns

## Phase Boundary

Fix data sources for Loop/Samples page (`/api/samples`, `/api/samples/:id`) and Feedback page (`/api/feedback/gfi`, `/api/feedback/empathy-events`, `/api/feedback/gate-blocks`). Field naming mismatches (snake_case vs camelCase), hardcoded zeros, and missing data from wrong DB sources.

## Requirements

- **LOOP-01**: Fix `/api/samples` — verify listSamples() query and response fields
- **LOOP-02**: Fix `/api/samples/:id` — verify sample detail data source
- **FB-01**: Fix `/api/feedback/gfi` — verify GFI data source and field mapping
- **FB-02**: Fix `/api/feedback/empathy-events` — verify empathy events data source
- **FB-03**: Fix `/api/feedback/gate-blocks` — verify gate blocks data source

## Implementation Decisions

### D-01: Service pattern from Phase 17
Phase 17 established the pattern: extract inline route assembly into a service class. Apply the same pattern to any inline assembly found in Phase 18 endpoints.

### D-02: Snake_case → camelCase conversion
Service layer converts snake_case DB columns to camelCase. Verify `control-ui-query-service.ts` correctly maps all columns for samples and feedback endpoints. Phase 16 RESEARCH confirmed this pattern is generally reliable but must be verified per endpoint.

### D-03: GFI endpoint (FB-01)
`/api/feedback/gfi` reads from multiple sources (session state, ControlUiDatabase pain_events, config files). Phase 17 fixed GFI persistence for `/api/overview/health`. FB-01 should verify `/api/feedback/gfi` has correct data sources and field mapping.

### D-04: Empathy events (FB-02)
`/api/feedback/empathy-events` — verify correct DB table and column mapping.

### D-05: Gate blocks (FB-03)
`/api/feedback/gate-blocks` — verify correct data source (ControlUiDatabase vs CentralDatabase).

### D-06: Frontend type alignment
Frontend `types.ts` declares parallel interfaces. After fixing backend data sources, verify `ui/src/types.ts` field names match actual service return shapes.

## Data Flow (from Phase 16 RESEARCH)

Frontend → api.ts → principles-console-route.ts → ControlUiQueryService → ControlUiDatabase (per-workspace `.state/trajectory.db`)

For feedback endpoints, may also read from HealthQueryService and EvolutionQueryService.

## Patterns to Follow

- `done()` wrapper pattern: `done(() => { service.method(); })` with `finally { service.dispose(); }`
- Service method returns camelCase objects from snake_case DB rows
- TypeScript interfaces in service files (not `types.ts`) — verify alignment

## Out of Scope

- UI visual changes (visual layer stays unchanged)
- Debug endpoint (Phase 16's debug endpoint was not executed — proceeding with static analysis from Phase 16 RESEARCH)
- Phase 17's CentralOverviewService (Phase 17 was for Overview page)

## Deferred Ideas

None — all 5 requirements are in scope

---

*Phase: 18-loop-feedback-page-fix*
*Context gathered: 2026-04-09*
