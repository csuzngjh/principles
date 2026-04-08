---
wave: 1
depends_on: null
files_modified:
  - packages/openclaw-plugin/src/http/principles-console-route.ts
  - packages/openclaw-plugin/ui/src/types.ts
  - packages/openclaw-plugin/src/service/control-ui-query-service.ts
  - packages/openclaw-plugin/src/service/health-query-service.ts
  - packages/openclaw-plugin/ui/src/api.ts
  - .planning/phases/16-data-source-tracing/DATA-FLOW-REPORT.md
  - .planning/phases/16-data-source-tracing/actual-shapes.json
autonomous: true
requirements:
  - TRACE-01
  - TRACE-02
---

## Phase 16: Data Source Tracing — Execution Plan

**Goal:** Map all 4 pages (Overview, Samples/Loop, Feedback, Gate Monitor) to their complete data flows. Document actual response shapes vs TypeScript type declarations. Fix trivial mismatches found during tracing.

**Hybrid method:** Static code analysis + temporary debug endpoint for runtime verification.

---

<task>
<name>add-debug-endpoint</name>
<read_first>
  - packages/openclaw-plugin/src/http/principles-console-route.ts (lines 100-200 for done() pattern, lines 135-195 for central/overview inline assembly as reference)
  - packages/openclaw-plugin/src/service/control-ui-query-service.ts (service methods to call)
  - packages/openclaw-plugin/src/service/health-query-service.ts (service methods to call)
  - packages/openclaw-plugin/src/service/evolution-query-service.ts (service methods to call)
</read_first>
<action>
Add a temporary `GET /api/debug/shapes` endpoint to `principles-console-route.ts` that collects actual response shapes from all 13 traced endpoints.

Insert the endpoint handler BEFORE the final 404 fallback (around line 640, before `service.dispose()` and `json(res, 404, ...)`). The endpoint must:

1. Be guarded by `process.env.PD_DEBUG === '1'` — if not set, return 404 immediately
2. Instantiate all three services (ControlUiQueryService, HealthQueryService, EvolutionQueryService) in try/finally blocks with proper dispose() calls
3. Call each service method and capture shapes using a recursive `extractShape(obj, prefix='')` function that:
   - Walks objects recursively, building dot-notation paths (e.g., `summary.repeatErrorRate`)
   - Records type via: `typeof val`, `Array.isArray(val)`, `val === null`
   - For arrays, samples the first element's shape
4. Returns a structured object keyed by endpoint path, each containing:
   - `fields`: Record of dot-path -> type string
   - `topLevelKeys`: Array of Object.keys() result
   - `hasCentralInfo`: boolean (specific check for /api/central/overview)
5. Also includes inline-assembled endpoints (central/overview, central/sync, central/workspaces) by calling their logic directly

The `extractShape` helper:
```typescript
function extractShape(obj: unknown, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  if (obj === null) { result[prefix || '(root)'] = 'null'; return result; }
  if (typeof obj !== 'object') { result[prefix || '(root)'] = typeof obj; return result; }
  if (Array.isArray(obj)) {
    result[prefix || '(root)'] = 'array';
    if (obj.length > 0) {
      const elem = obj[0];
      if (typeof elem === 'object' && elem !== null) {
        Object.assign(result, extractShape(elem, prefix ? `${prefix}[0]` : '[0]'));
      } else {
        result[prefix ? `${prefix}[0]` : '[0]'] = typeof elem;
      }
    }
    return result;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (val === null) {
      result[path] = 'null';
    } else if (Array.isArray(val)) {
      result[path] = `array<${val.length}>`;
      if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
        Object.assign(result, extractShape(val[0], `${path}[0]`));
      } else if (val.length > 0) {
        result[`${path}[0]`] = typeof val[0];
      }
    } else if (typeof val === 'object') {
      Object.assign(result, extractShape(val, path));
    } else {
      result[path] = typeof val;
    }
  }
  return result;
}
```

All service instantiations must be wrapped in try/finally with dispose() calls. The endpoint itself must be inside a done() wrapper.
</action>
<acceptance_criteria>
1. Grep for `pathname === \`${API_PREFIX}/debug/shapes\`` finds exactly 1 match in principles-console-route.ts
2. Grep for `process.env.PD_DEBUG === '1'` finds the guard in the debug endpoint handler
3. Grep for `extractShape` finds the helper function definition
4. The endpoint returns JSON with keys covering at least: `/api/overview`, `/api/central/overview`, `/api/samples`, `/api/feedback/gfi`, `/api/gate/stats`, `/api/gate/blocks`
5. All service instances created in the endpoint are disposed in finally blocks (grep for `.dispose()` near the endpoint)
</acceptance_criteria>
<hints>
- The central/overview endpoint assembles inline, not via a service method — call its logic directly by duplicating the object construction or by temporarily refactoring into a helper
- For evolution endpoints, use `evolutionService()` helper already defined in the route file (line ~380)
- The debug endpoint should NOT make HTTP calls to itself — call service methods directly
- Do NOT add any npm dependencies
</hints>
</task>

<task>
<name>static-trace-overview-page</name>
<wave>2</wave>
<depends_on>add-debug-endpoint</depends_on>
<read_first>
  - packages/openclaw-plugin/ui/src/pages/OverviewPage.tsx
  - packages/openclaw-plugin/ui/src/api.ts (getOverview, getCentralOverview methods)
  - packages/openclaw-plugin/ui/src/types.ts (OverviewResponse interface, lines 1-48)
  - packages/openclaw-plugin/src/service/control-ui-query-service.ts (getOverview method, lines 200-400)
  - packages/openclaw-plugin/src/http/principles-console-route.ts (lines 135-195, central/overview inline)
  - packages/openclaw-plugin/src/service/central-database.ts (method signatures)
</read_first>
<action>
Perform static data flow tracing for the Overview page. Document the full chain for each of the 3 overview-related endpoints:

1. `GET /api/overview` — ControlUiQueryService.getOverview() → ControlUiDatabase queries
2. `GET /api/central/overview` — inline assembly in route handler → CentralDatabase queries
3. `GET /api/overview/health` — HealthQueryService.getOverviewHealth() → session state + ControlUiDatabase + config files

For each endpoint, create a documented trace covering:
- Which DB is read (trajectory.db vs aggregated.db vs session state)
- Column name mapping: DB snake_case → service camelCase → frontend camelCase
- Any hardcoded values (e.g., central/overview hardcodes gateBlocks:0, taskOutcomes:0, preview:[])
- Extra fields not in frontend types (e.g., centralInfo)
- Any nullable fields that should be marked optional

Write findings to `.planning/phases/16-data-source-tracing/DATA-FLOW-REPORT.md` under a "## Overview Page" section with a flow diagram for each endpoint in this format:
```
Frontend: OverviewPage.tsx → api.getOverview() → GET /api/overview
Backend:  route handler → done(() => service.getOverview(days))
Service:  ControlUiQueryService.getOverview() — returns OverviewResponse (service-local type, line N)
DB:       ControlUiDatabase (trajectory.db)
Columns:  tool_name→toolName, error_type→errorType, created_at→createdAt
Mismatches: [list each mismatch found]
```
</action>
<acceptance_criteria>
1. DATA-FLOW-REPORT.md exists at `.planning/phases/16-data-source-tracing/DATA-FLOW-REPORT.md`
2. The file contains a "## Overview Page" section
3. All 3 overview endpoints are documented with flow diagrams showing: Frontend → API → Route → Service → DB
4. The centralInfo field mismatch is documented (returned by /api/central/overview but not in frontend OverviewResponse type)
5. Hardcoded zeros in central/overview are documented (gateBlocks, taskOutcomes, principleEventCount)
6. sampleQueue.preview hardcoded to [] in central/overview is documented
7. At least 5 DB column→JS field mappings are listed per endpoint
</acceptance_criteria>
<hints>
- The service-layer OverviewResponse (control-ui-query-service.ts line 12) and frontend OverviewResponse (types.ts line 1) are separate declarations — compare them field by field
- The central/overview inline assembly returns a `centralInfo` field that the frontend handles with an intersection type cast in api.ts line ~85
- Check the getOverview method in the service — it's 200+ lines, read the entire thing
</hints>
</task>

<task>
<name>static-trace-samples-loop-page</name>
<wave>2</wave>
<depends_on>add-debug-endpoint</depends_on>
<read_first>
  - packages/openclaw-plugin/ui/src/pages/SamplesPage.tsx
  - packages/openclaw-plugin/ui/src/api.ts (listSamples, getSampleDetail, reviewSample methods)
  - packages/openclaw-plugin/ui/src/types.ts (SamplesResponse, SampleDetailResponse interfaces)
  - packages/openclaw-plugin/src/service/control-ui-query-service.ts (listSamples, getSampleDetail methods)
</read_first>
<action>
Perform static data flow tracing for the Samples/Loop page. Document the full chain for each endpoint:

1. `GET /api/samples` — ControlUiQueryService.listSamples() → ControlUiDatabase
2. `GET /api/samples/:id` — ControlUiQueryService.getSampleDetail() → ControlUiDatabase
3. `POST /api/samples/:id/review` — ControlUiQueryService.reviewSample() → ControlUiDatabase

For each endpoint, follow the same documentation pattern as the Overview page trace. Note:
- The `done()` wrapper pattern is used for /api/samples but NOT for /api/samples/:id and /api/samples/:id/review (they have custom try/catch/finally)
- The .map() pattern converts snake_case DB columns to camelCase — verify each field mapping
- Check if `diffExcerpt` field in SamplesResponse is actually populated or truncated
</action>
<acceptance_criteria>
1. DATA-FLOW-REPORT.md contains a "## Samples/Loop Page" section
2. All 3 samples endpoints are documented with full flow chains
3. DB column mappings are listed for each endpoint (at least 5 per endpoint)
4. The done() vs custom error handling difference is noted
5. Any field name or type differences between service return types and frontend types.ts are documented
</acceptance_criteria>
<hints>
- listSamples uses pagination (page, pageSize) — check if the pagination object fields match between service and frontend types
- getSampleDetail returns nested objects (badAttempt, userCorrection, recoveryToolSpan, relatedPrinciples, relatedThinkingHits, reviewHistory) — verify each sub-object's fields match the frontend type
- The reviewSample endpoint returns the updated database record — check what shape it returns vs what the frontend expects
</hints>
</task>

<task>
<name>static-trace-feedback-page</name>
<wave>2</wave>
<depends_on>add-debug-endpoint</depends_on>
<read_first>
  - packages/openclaw-plugin/ui/src/pages/FeedbackPage.tsx
  - packages/openclaw-plugin/ui/src/api.ts (getFeedbackGfi, getEmpathyEvents, getFeedbackGateBlocks methods)
  - packages/openclaw-plugin/ui/src/types.ts (FeedbackGfiResponse, EmpathyEvent, FeedbackGateBlock interfaces)
  - packages/openclaw-plugin/src/service/health-query-service.ts (getFeedbackGfi, getFeedbackEmpathyEvents, getFeedbackGateBlocks methods, lines 179-258)
</read_first>
<action>
Perform static data flow tracing for the Feedback page. Document the full chain for each endpoint:

1. `GET /api/feedback/gfi` — HealthQueryService.getFeedbackGfi() → session state + ControlUiDatabase.pain_events
2. `GET /api/feedback/empathy-events` — HealthQueryService.getFeedbackEmpathyEvents() → merged event log filtering
3. `GET /api/feedback/gate-blocks` — HealthQueryService.getFeedbackGateBlocks() → ControlUiDatabase.gate_blocks

Key areas to verify:
- `gfiAfter` field in EmpathyEvent: the service reads `data.gfiAfter ?? data.gfi_after ?? data.gfi` — check if the frontend type matches
- `getFeedbackGateBlocks` returns objects with `timestamp, toolName, reason, gfi, trustStage` — verify these match `FeedbackGateBlock` in types.ts
- `getFeedbackGfi` returns `current, peakToday, threshold, trend, sources` — verify against `FeedbackGfiResponse` in types.ts
</action>
<acceptance_criteria>
1. DATA-FLOW-REPORT.md contains a "## Feedback Page" section
2. All 3 feedback endpoints are documented with full flow chains
3. The gfiAfter field fallback chain (gfiAfter → gfi_after → gfi) is documented
4. Field mappings for each endpoint are listed (at least 5 per endpoint)
5. Any mismatches between service return types and frontend types are documented
</acceptance_criteria>
<hints>
- getFeedbackEmpathyEvents reads from `readMergedEvents()` which pulls from the event log system, not SQLite — this is a different data source than the other endpoints
- getFeedbackGateBlocks and getGateBlocks in health-query-service share the same `readGateBlocksRaw()` method but return different field sets (feedback version omits filePath and gateType)
- The FeedbackGateBlock type in types.ts does NOT have filePath, but GateBlockItem DOES — verify the correct type is used for each endpoint
</hints>
</task>

<task>
<name>static-trace-gate-monitor-page</name>
<wave>2</wave>
<depends_on>add-debug-endpoint</depends_on>
<read_first>
  - packages/openclaw-plugin/ui/src/pages/GateMonitorPage.tsx
  - packages/openclaw-plugin/ui/src/api.ts (getGateStats, getGateBlocks methods)
  - packages/openclaw-plugin/ui/src/types.ts (GateStatsResponse, GateBlockItem interfaces)
  - packages/openclaw-plugin/src/service/health-query-service.ts (getGateStats, getGateBlocks methods, lines 261-340)
</read_first>
<action>
Perform static data flow tracing for the Gate Monitor page. Document the full chain for each endpoint:

1. `GET /api/gate/stats` — HealthQueryService.getGateStats() → ControlUiDatabase.gate_blocks + session state
2. `GET /api/gate/blocks` — HealthQueryService.getGateBlocks() → ControlUiDatabase.gate_blocks

Key areas to verify:
- `getGateStats` returns nested `today, trust, evolution` objects — verify each sub-field matches `GateStatsResponse`
- `getGateBlocks` returns `timestamp, toolName, filePath, reason, gateType, gfi, trustStage` — verify each field matches `GateBlockItem` in types.ts
- The `gateType` field resolution logic (`resolveGateType()` method) — check how it determines the type from raw DB data
- The SQL query for gate_blocks uses `substr(created_at, 1, 10)` for date filtering — verify this matches the frontend's expectations
</action>
<acceptance_criteria>
1. DATA-FLOW-REPORT.md contains a "## Gate Monitor Page" section
2. Both gate monitor endpoints are documented with full flow chains
3. GateBlockItem vs FeedbackGateBlock difference is documented (GateBlockItem has filePath + gateType, FeedbackGateBlock does not)
4. The resolveGateType() and resolveGateBlockGfi() helper methods are documented
5. Any mismatches between service return types and frontend types are documented
</acceptance_criteria>
<hints>
- GateBlockItem and FeedbackGateBlock are two DIFFERENT types in types.ts — GateBlockItem is used by /api/gate/blocks, FeedbackGateBlock by /api/feedback/gate-blocks
- getGateBlocks in the service returns filePath and gateType; getFeedbackGateBlocks does NOT — this is intentional, not a bug
- The `today` object in GateStatsResponse counts blocks by reason keyword matching (gfi, stage, p03, bypass, p16) — verify the keywords match what's actually in the DB
</hints>
</task>

<task>
<name>fix-trivial-mismatches</name>
<wave>3</wave>
<depends_on>static-trace-overview-page,static-trace-samples-loop-page,static-trace-feedback-page,static-trace-gate-monitor-page</depends_on>
<read_first>
  - .planning/phases/16-data-source-tracing/DATA-FLOW-REPORT.md (completed by prior tasks)
  - packages/openclaw-plugin/ui/src/types.ts
  - packages/openclaw-plugin/src/service/control-ui-query-service.ts
  - packages/openclaw-plugin/src/service/health-query-service.ts
  - packages/openclaw-plugin/src/http/principles-console-route.ts
</read_first>
<action>
Fix all trivial mismatches identified during static tracing. "Trivial" means: field name typos, missing optional markers, wrong primitive types, obvious naming differences. DO NOT fix architectural issues (wrong DB source, inline assembly, missing data) — those go to Phases 17-19.

Specific fixes to apply (based on RESEARCH.md findings):

1. **Add `centralInfo` to frontend OverviewResponse type** — The `/api/central/overview` endpoint returns a `centralInfo` field. Add it as an optional field to the frontend `OverviewResponse` in types.ts OR add a dedicated `CentralOverviewResponse` type. The current workaround uses an intersection type cast in api.ts.

2. **Verify and fix any field name typos** found during tracing — if any field is named differently in service return vs frontend type and the difference is clearly a typo (not an intentional rename), fix the wrong side.

3. **Mark nullable fields as optional** — If a field can be null at runtime but is not marked with `| null` in the frontend type, add the null union.

4. **Fix Number() coercion gaps** — If the service returns a string where the frontend expects a number (or vice versa), fix the service to return the correct type.

For each fix, add a "## Fixes Applied" section to DATA-FLOW-REPORT.md documenting:
- What was wrong
- Which file was changed
- Before/after field definition

After all fixes, run `npx tsc --noEmit` in the `packages/openclaw-plugin` directory to verify no new type errors are introduced.
</action>
<acceptance_criteria>
1. DATA-FLOW-REPORT.md has a "## Fixes Applied" section listing every fix made
2. At least 1 fix is documented (the centralInfo field addition is confirmed needed)
3. `npx tsc --noEmit` in packages/openclaw-plugin exits with code 0 (no new type errors)
4. No architectural changes were made (no inline assembly refactoring, no DB source changes, no API redesign)
5. All fixed fields are verified to match between service return types and frontend types
</acceptance_criteria>
<hints>
- The centralInfo field should be added as optional: `centralInfo?: { workspaceCount: number; enabledWorkspaceCount: number; workspaces: string[]; enabledWorkspaces: string[] }` — this matches what the route handler returns
- Be careful not to "fix" the hardcoded zeros in central/overview — those are architectural issues for Phase 17
- If tsc fails due to pre-existing errors, document them separately and only ensure no NEW errors were introduced by our fixes
</hints>
</task>

<task>
<name>generate-actual-shapes-json</name>
<wave>3</wave>
<depends_on>static-trace-overview-page,static-trace-samples-loop-page,static-trace-feedback-page,static-trace-gate-monitor-page</depends_on>
<read_first>
  - .planning/phases/16-data-source-tracing/DATA-FLOW-REPORT.md (completed trace doc)
  - packages/openclaw-plugin/ui/src/types.ts (all type declarations)
  - packages/openclaw-plugin/src/service/control-ui-query-service.ts (service-level type declarations)
  - packages/openclaw-plugin/src/service/health-query-service.ts (method return type declarations)
</read_first>
<action>
Create `actual-shapes.json` at `.planning/phases/16-data-source-tracing/actual-shapes.json` with machine-readable documentation of all 13 API endpoint response shapes.

Each entry must follow this structure:
```json
{
  "GET /api/overview": {
    "actualFields": {
      "workspaceDir": "string",
      "generatedAt": "string",
      "dataFreshness": "string|null",
      "dataSource": "string",
      "summary.repeatErrorRate": "number",
      "...": "..."
    },
    "expectedType": "OverviewResponse",
    "mismatches": [],
    "notes": "..."
  }
}
```

Cover all 13 endpoints:
1. GET /api/overview
2. GET /api/central/overview
3. GET /api/overview/health
4. GET /api/samples
5. GET /api/samples/:id
6. POST /api/samples/:id/review
7. GET /api/feedback/gfi
8. GET /api/feedback/empathy-events
9. GET /api/feedback/gate-blocks
10. GET /api/gate/stats
11. GET /api/gate/blocks
12. GET /api/evolution/tasks
13. GET /api/evolution/events
14. GET /api/evolution/stats
15. GET /api/evolution/trace/:id

For nested objects, use dot-notation paths (e.g., `summary.repeatErrorRate`). For arrays, note the element type (e.g., `dailyTrend: array<{day: string, ...}>`).
</action>
<acceptance_criteria>
1. actual-shapes.json exists at `.planning/phases/16-data-source-tracing/actual-shapes.json`
2. The file is valid JSON (parseable by `node -e "JSON.parse(require('fs').readFileSync('.planning/phases/16-data-source-tracing/actual-shapes.json','utf8'))"`)
3. At least 13 endpoint entries exist (matching the 13 endpoints listed above)
4. Each entry has `actualFields`, `expectedType`, `mismatches`, and `notes` keys
5. Nested fields use dot-notation paths (verified by at least one entry having a `.` in a field key)
6. The mismatches array for each entry accurately reflects documented differences from DATA-FLOW-REPORT.md
</acceptance_criteria>
<hints>
- For array-typed fields, include the element shape: `"items": "array<{sampleId: string, ...}>"` or list the first element's fields separately
- The `mismatches` array should contain strings describing each mismatch, e.g., `"centralInfo field returned by backend but not in OverviewResponse type"`
- Cross-reference with DATA-FLOW-REPORT.md to ensure consistency — the JSON should be a machine-readable version of the same data
</hints>
</task>

<task>
<name>static-trace-evolution-thinking</name>
<wave>2</wave>
<depends_on>add-debug-endpoint</depends_on>
<read_first>
  - packages/openclaw-plugin/ui/src/pages/EvolutionPage.tsx
  - packages/openclaw-plugin/ui/src/pages/ThinkingModelsPage.tsx
  - packages/openclaw-plugin/ui/src/api.ts (evolution and thinking methods)
  - packages/openclaw-plugin/ui/src/types.ts (EvolutionTaskItem, EvolutionStatsResponse, ThinkingOverviewResponse, ThinkingModelDetailResponse)
  - packages/openclaw-plugin/src/service/evolution-query-service.ts
  - packages/openclaw-plugin/src/service/control-ui-query-service.ts (thinking methods)
</read_first>
<action>
Perform static data flow tracing for the Evolution and Thinking pages. Document the full chain for each endpoint:

1. `GET /api/evolution/tasks` — EvolutionQueryService.getEvolutionTasks() → workspace data sources
2. `GET /api/evolution/events` — EvolutionQueryService.getEvolutionEvents() → workspace data sources
3. `GET /api/evolution/stats` — EvolutionQueryService.getEvolutionStats() → workspace data sources
4. `GET /api/evolution/trace/:id` — EvolutionQueryService.getEvolutionTrace() → workspace data sources
5. `GET /api/thinking` — ControlUiQueryService.getThinkingOverview() → ControlUiDatabase
6. `GET /api/thinking/models/:id` — ControlUiQueryService.getThinkingModelDetail() → ControlUiDatabase

Append findings to DATA-FLOW-REPORT.md under "## Evolution Page" and "## Thinking Models Page" sections following the same flow diagram format as prior tracing tasks.
</action>
<acceptance_criteria>
1. DATA-FLOW-REPORT.md contains "## Evolution Page" and "## Thinking Models Page" sections
2. All 6 evolution/thinking endpoints are documented with full flow chains
3. DB column mappings are listed for each endpoint (at least 5 per endpoint)
4. Any mismatches between service return types and frontend types are documented
</acceptance_criteria>
<hints>
- Evolution endpoints use EvolutionQueryService which is a newer service — check if it follows the same snake_case→camelCase mapping pattern
- Thinking endpoints are in ControlUiQueryService but use different DB tables than overview/samples
- EvolutionTraceResponse has a nested `task` object — verify all fields match between service return and frontend type
</hints>
</task>

<task>
<name>remove-debug-endpoint</name>
<wave>4</wave>
<depends_on>generate-actual-shapes-json</depends_on>
<read_first>
  - packages/openclaw-plugin/src/http/principles-console-route.ts
</read_first>
<action>
Remove the temporary debug endpoint (`GET /api/debug/shapes`) and the `extractShape` helper function from `principles-console-route.ts`. This endpoint was added for runtime verification during Phase 16 and must not ship to production.

Steps:
1. Remove the entire `if (pathname === \`${API_PREFIX}/debug/shapes\` ...)` handler block
2. Remove the `extractShape` helper function
3. Verify no other references to the debug endpoint remain
4. Verify no `PD_DEBUG` environment variable checks remain in the route file
</action>
<acceptance_criteria>
1. Grep for `debug/shapes` in principles-console-route.ts returns 0 matches
2. Grep for `extractShape` in principles-console-route.ts returns 0 matches
3. Grep for `PD_DEBUG` in principles-console-route.ts returns 0 matches
4. All other routes in principles-console-route.ts remain intact (no accidental deletions)
</acceptance_criteria>
<hints>
- The debug endpoint was added near the 404 fallback — remove the entire if block including the handler
- The extractShape helper was likely added near the top of the file or inside the handler — remove it completely
- Double-check that no import statements were added for the debug functionality
</hints>
</task>

## Verification Criteria

1. **DATA-FLOW-REPORT.md** exists at `.planning/phases/16-data-source-tracing/DATA-FLOW-REPORT.md` with all 6 pages (Overview, Samples/Loop, Feedback, Gate Monitor, Evolution, Thinking) traced to their data sources
2. **actual-shapes.json** exists at `.planning/phases/16-data-source-tracing/actual-shapes.json` with all 19 endpoints documented
3. **Debug endpoint added and removed** — temporarily present during execution, confirmed removed in final code (0 grep matches for `debug/shapes`, `extractShape`, `PD_DEBUG`)
4. **All trivial mismatches fixed** — verified by `npx tsc --noEmit` in `packages/openclaw-plugin` producing no new errors
5. **TRACE-01 satisfied**: All pages mapped to API endpoints, route handlers, service methods, and database queries
6. **TRACE-02 satisfied**: Actual response shapes documented vs TypeScript type declarations for each endpoint
