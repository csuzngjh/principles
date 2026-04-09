# Phase 16: Data Source Tracing — Research

**Date:** 2026-04-08
**Status:** Research complete
**Purpose:** Answer "What do I need to know to PLAN this phase well?"

---

## 1. Architecture Summary (from codebase analysis)

### 1.1 Data Flow Layers

The application follows a 4-tier architecture:

```
Frontend (React/TypeScript)
  └─ api.ts (fetch wrappers with typed generics)
      └─ types.ts (TypeScript interfaces — compile-time only, no runtime validation)
          └─ Page components (field access via dot notation, e.g., data.summary.repeatErrorRate)

Backend HTTP Layer
  └─ principles-console-route.ts (plain Node.js http, no framework)
      └─ Service layer (ControlUiQueryService, HealthQueryService, EvolutionQueryService)
          └─ Database layer (ControlUiDatabase = better-sqlite3, CentralDatabase = better-sqlite3)
```

### 1.2 Key Architectural Facts

**No runtime validation library exists.** The project does NOT use Zod, Joi, Yup, or any schema validation library. TypeScript types in `types.ts` are compile-time only — there is zero runtime enforcement that backend responses match frontend type declarations. This is the root cause of potential data source drift.

**Dual database model:**
- `ControlUiDatabase` — per-workspace, reads from `.state/trajectory.db`
- `CentralDatabase` — cross-workspace aggregation, reads from `~/.openclaw/.central/aggregated.db`

**Route handler pattern:** Most endpoints use the `done()` wrapper which calls the service method and returns JSON. The critical exception is `/api/central/overview` which assembles its response inline (60+ lines of object construction directly in the route handler, bypassing the service layer entirely).

**Service return shapes are defined in the service files themselves**, not in `types.ts`. Each service file declares its own TypeScript interfaces:
- `control-ui-query-service.ts` declares `OverviewResponse`, `SamplesResponse`, `SampleDetailResponse`, etc.
- `health-query-service.ts` declares inline return types on each method
- `central-database.ts` declares `WorkspaceInfo` and inline return types

The frontend `types.ts` declares **parallel** interfaces with the same names but potentially different field names. This is the drift problem.

### 1.3 Field Naming Conventions Identified

**Backend (snake_case from SQLite):**
- `tool_name`, `error_type`, `occurrences`, `sample_id`, `session_id`, `quality_score`, `review_status`, `created_at`, `updated_at`, `bad_assistant_turn_id`, `user_correction_turn_id`, `recovery_tool_span_json`, `principle_ids_json`, `diff_excerpt`, `failure_mode`, `related_thinking_count`, `thinking_turns`, `tool_calls`, `user_corrections`

**Service layer converts to camelCase:**
- `control-ui-query-service.ts` maps snake_case DB columns → camelCase in return objects (e.g., `row.tool_name` → `toolName: row.tool_name`)
- `central-database.ts` returns snake_case directly from SQL (`SELECT tool_name as toolName` — mixed approach)
- `health-query-service.ts` returns camelCase (manually constructed objects)

**Frontend types expect camelCase:**
- All interfaces in `types.ts` use camelCase (`toolName`, `errorType`, `sampleId`, etc.)
- Page components access via camelCase dot notation (`data.summary.repeatErrorRate`)

### 1.4 Already-Identified Risk: `/api/central/overview`

The inline assembly in `principles-console-route.ts` (lines ~150-210) constructs an `OverviewResponse` directly. Key differences from the per-workspace `/api/overview`:

| Aspect | `/api/overview` (service) | `/api/central/overview` (inline) |
|--------|---------------------------|----------------------------------|
| `dataSource` | `'trajectory_db_analytics'` | `'central_aggregated_db'` |
| `runtimeControlPlaneSource` | `'pd_evolution_status'` | `'all_workspaces'` |
| `summary.gateBlocks` | from DB query | hardcoded `0` |
| `summary.taskOutcomes` | from DB query | hardcoded `0` |
| `summary.principleEventCount` | from DB query | hardcoded `0` |
| `sampleQueue.preview` | from DB (5 rows) | hardcoded `[]` |
| Extra field | none | `centralInfo` (not in `OverviewResponse` type) |

The frontend `types.ts` `OverviewResponse` declares `dataSource?: string` and `runtimeControlPlaneSource?: string` as optional, which is correct since the central endpoint returns different values. But the `centralInfo` field is NOT in the type — the frontend casts it with an intersection type: `OverviewResponse & { centralInfo?: ... }`.

---

## 2. Best Practices for Data Flow Tracing

### 2.1 Static Analysis Approach (What We Already Know)

The most effective static tracing pattern for this codebase:

1. **Start from the frontend page** — identify which `api.*` methods are called
2. **Follow to `api.ts`** — identify the URL path and generic type parameter
3. **Match URL to route handler** — find the `if (pathname === ...)` block in `principles-console-route.ts`
4. **Check if `done()` wrapper or inline** — `done()` calls a service method; inline assembles manually
5. **Follow service method** — read the return object construction, note any DB column → JS field mapping
6. **Check DB query** — verify SQL column names match what the service expects
7. **Compare with frontend type** — check `types.ts` interface for field name/type mismatches

### 2.2 Runtime Verification Approach (Debug Endpoint)

**Recommended pattern for the temporary debug endpoint:**

```
GET /api/debug/shapes
```

This endpoint should:
1. Hit each of the 13 API endpoints programmatically (internal function calls, not HTTP loops)
2. For each endpoint, capture:
   - Actual field names returned (via `Object.keys()` recursively)
   - Actual value types (via `typeof`, `Array.isArray()`)
   - Sample values (first non-null value for each field)
3. Compare with the corresponding frontend type
4. Return a structured diff

**Production safety measures:**
- Guard with `process.env.NODE_ENV !== 'production'` check
- OR use a feature flag / environment variable: `process.env.PD_DEBUG_SHAPES === '1'`
- OR register the route only in development mode
- **Best approach for this codebase**: Add a compile-time guard that strips the route in production builds, or use the existing `validateGatewayAuth()` + an additional env var check

Given the project uses plain Node.js http (no framework, no build-time route elimination), the **env var guard** is the simplest and safest:

```typescript
if (pathname === `${API_PREFIX}/debug/shapes` && method === 'GET') {
  if (process.env.PD_DEBUG !== '1') {
    json(res, 404, { error: 'not_found' });
    return true;
  }
  return done(() => collectAllShapes());
}
```

### 2.3 Field Mismatch Detection Techniques

**Compile-time (TypeScript):**
- `tsc --noEmit` only catches type errors when types are explicitly violated. Since `api.ts` uses generic `requestJson<T>()`, the compiler trusts the type parameter — it does NOT validate that the actual JSON response matches `T`. This is a fundamental limitation.
- **No compile-time guarantee exists** between backend response shape and frontend type declaration.

**Runtime detection approaches:**
1. **Manual shape extraction** — `Object.keys()` + `typeof` on each response field
2. **Schema generation** — Use a library like `json-schema-generator` or `typeof` to auto-generate schemas from runtime data
3. **Zod inference** — If Zod were added, `z.infer<typeof schema>` would give types from runtime validation, but this is out of scope for this phase

**For this phase, the recommended approach is:**
- Manual tracing via code reading (static analysis) — most reliable for understanding the full chain
- Supplement with runtime shape extraction from the debug endpoint — catches dynamic behavior (conditional fields, null handling)
- Document mismatches in a structured format

---

## 3. JSON Schema Generation for API Response Validation

### 3.1 Approach Without Adding Dependencies

Since the project has no runtime validation library, the simplest approach for Phase 16 deliverables is:

1. **Manual schema documentation** — Write JSON Schema files by hand based on static analysis
2. **Shape extraction from debug endpoint** — Auto-generate field lists with types
3. **Comparison report** — Structured diff between expected (types.ts) and actual (runtime)

### 3.2 JSON Schema Structure

For each endpoint, the `actual-shapes.json` should contain:

```json
{
  "GET /api/overview": {
    "actualFields": {
      "workspaceDir": "string",
      "generatedAt": "string",
      "dataFreshness": "string|null",
      "dataSource": "string",
      "summary.repeatErrorRate": "number",
      "summary.userCorrectionRate": "number",
      "...": "..."
    },
    "expectedType": "OverviewResponse",
    "mismatches": [],
    "notes": "..."
  }
}
```

---

## 4. Reusable Patterns from Existing Codebase

### 4.1 The `done()` Wrapper Pattern

```typescript
const done = (fn: () => unknown): boolean => {
  try {
    const payload = fn();
    json(res, 200, payload);
    return true;
  } catch (error) {
    // error handling
  } finally {
    service.dispose();
  }
};
```

This is the dominant pattern. For tracing, any endpoint using `done()` has a clear service → DB chain. Endpoints NOT using `done()` (like `/api/central/overview`) are the high-risk areas.

### 4.2 Service Disposal Pattern

Every service class has a `dispose()` method that closes the SQLite connection. The debug endpoint must call `dispose()` on all services it instantiates.

### 4.3 Existing Type Duplication

The following types are declared in BOTH service files AND frontend `types.ts`:

| Type | Service File | Frontend types.ts |
|------|-------------|-------------------|
| `OverviewResponse` | `control-ui-query-service.ts` L12 | `types.ts` L1 |
| `SamplesResponse` | `control-ui-query-service.ts` L60 | `types.ts` L48 |
| `SampleDetailResponse` | `control-ui-query-service.ts` L78 | `types.ts` L66 |
| `ThinkingOverviewResponse` | `control-ui-query-service.ts` L125 | `types.ts` L108 |
| `ThinkingModelDetailResponse` | `control-ui-query-service.ts` L148 | `types.ts` L131 |

These parallel declarations are the primary source of drift. Phase 16 must verify that field names, types, and optionality match between each pair.

### 4.4 Column Mapping Pattern in Services

The service layer consistently uses `.map()` to transform DB rows to camelCase objects:

```typescript
// Pattern seen throughout control-ui-query-service.ts:
items.map((row) => ({
  sampleId: row.sample_id,       // snake_case DB → camelCase JS
  sessionId: row.session_id,
  reviewStatus: row.review_status,
  qualityScore: Number(row.quality_score),  // Also explicit Number() coercion
  failureMode: row.failure_mode,
  createdAt: row.created_at,
}))
```

This pattern is generally reliable but must be verified endpoint by endpoint.

---

## 5. Specific Risks for Phase 16

### 5.1 High-Risk Endpoints

| Endpoint | Risk | Reason |
|----------|------|--------|
| `GET /api/central/overview` | **HIGH** | Inline assembly, 60+ lines, bypasses service layer, hardcoded zeros, missing `sampleQueue.preview`, extra `centralInfo` field not in type |
| `GET /api/overview` | MEDIUM | Service method is long (200+ lines), many DB queries, but follows established mapping pattern |
| `GET /api/feedback/gfi` | MEDIUM | Reads from multiple sources (session state, ControlUiDatabase pain_events, config files) |
| `GET /api/overview/health` | MEDIUM | Aggregates from many sources (session, scorecard, evolution, pain flag, queue, trajectory) |
| All other endpoints | LOW-MEDIUM | Follow `done()` + service pattern with consistent column mapping |

### 5.2 Known Type Issues to Watch For

1. **`centralInfo` field** — Returned by `/api/central/overview` but not in `OverviewResponse` type (frontend works around with intersection type cast)
2. **Nullable fields** — Some fields are nullable in DB but not marked optional in types (e.g., `dataFreshness` can be null)
3. **Number coercion** — SQLite returns numbers as numbers via better-sqlite3, but some paths use `Number()` coercion while others don't
4. **Empty arrays vs null** — Some endpoints return `[]` for empty results, others might return `null`

### 5.3 Scope Discipline

Phase 16 should:
- Document all 13 endpoints with full data flow chains
- Fix trivial mismatches (field name typos, missing optional markers)
- NOT fix architectural issues (inline assembly, wrong data source) — those go to Phases 17-19
- NOT change visual layer

---

## 6. Implementation Plan Recommendations

### 6.1 Debug Endpoint Design

Location: Add to `principles-console-route.ts` in the `handleApiRoute` function.

The endpoint should:
1. Instantiate each service (ControlUiQueryService, HealthQueryService, EvolutionQueryService)
2. Call each method that corresponds to a traced endpoint
3. Recursively walk each response object to extract field paths and types
4. Compare with `types.ts` declarations (by importing or parsing them)
5. Return structured comparison
6. **Must be guarded by `process.env.PD_DEBUG === '1'`**

### 6.2 Deliverable Structure

```
.planning/phases/16-data-source-tracing/
├── DATA-FLOW-REPORT.md          # Human-readable, one section per page
├── actual-shapes.json            # Machine-readable, one entry per endpoint
└── 16-RESEARCH.md               # This file
```

### 6.3 Tracing Order (Recommended)

1. Start with `/api/overview` (service-based, well-structured) — establish the tracing template
2. Then `/api/central/overview` (inline, highest risk) — compare with step 1
3. Then `/api/samples` → `/api/samples/:id` (same service, related)
4. Then Feedback page endpoints (multiple services involved)
5. Then Gate Monitor endpoints
6. Finally Evolution/Thinking endpoints (if time permits — may be lower priority)

### 6.4 Fix Strategy During Tracing

When a mismatch is found:
1. **If it's a simple naming difference** (snake_case vs camelCase in the wrong layer) — fix the wrong side immediately
2. **If it's a missing optional field** — add `?` to the type
3. **If it's a type mismatch** (number vs string) — fix the side that's wrong
4. **If it's architectural** (wrong DB, missing data, inline assembly bugs) — document and defer to Phases 17-19

### 6.5 Testing the Debug Endpoint

The debug endpoint should be tested by:
1. Setting `PD_DEBUG=1` env var
2. Starting the OpenClaw plugin
3. Calling `GET /plugins/principles/api/debug/shapes`
4. Verifying the output contains all 13 endpoints with field shapes
5. **Removing or guarding the endpoint before production deployment**

---

## 7. Tools and Techniques Reference

### 7.1 No New Dependencies Needed

Phase 16 can be completed without adding any npm packages. The debug endpoint can use plain `typeof`, `Object.keys()`, and recursive walking. The report is hand-written markdown.

### 7.2 Useful Node.js APIs

- `Object.keys(obj)` — list field names
- `typeof value` — primitive type detection
- `Array.isArray(value)` — array detection
- `value === null` — null detection (distinct from `typeof null === 'object'`)
- `value instanceof Date` — Date detection
- Recursive walk: for nested objects, concatenate path with dots (e.g., `summary.repeatErrorRate`)

### 7.3 TypeScript Type Extraction

Since `types.ts` cannot be imported at runtime (it's TypeScript), the comparison must be done by:
1. Reading `types.ts` as a string and parsing interface declarations (regex-based, fragile)
2. OR manually writing the expected shapes based on reading the type declarations
3. OR using the TypeScript compiler API (overkill for this phase)

**Recommendation:** Manual comparison. Read the type declaration, read the actual response, note differences. This is what "tracing" means in this context — human-driven verification, not automated tooling.

---

## 8. Summary of Key Decisions for PLAN.md

| Decision | Rationale |
|----------|-----------|
| Hybrid static + runtime tracing | Static analysis catches the full chain; runtime catches dynamic behavior |
| Debug endpoint with env var guard | Simplest production safety; no build-time changes needed |
| Manual comparison over automated parsing | TypeScript types can't be imported at runtime; regex parsing is fragile |
| Fix trivial mismatches in-place | Low risk, high value, prevents repeated visits |
| Defer architectural fixes | Scope boundary — Phases 17-19 handle structural issues |
| No new dependencies | Phase 16 is investigation + documentation, not infrastructure |
| Deliverables: MD report + JSON shapes | Human-readable for team, machine-readable for future automation |

---

*Research completed: 2026-04-08*
*Ready for: /gsd-plan-phase 16*
