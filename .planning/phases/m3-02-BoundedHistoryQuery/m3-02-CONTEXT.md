# Phase m3-02: Bounded History Query - Context

**Gathered:** 2026-04-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Build the bounded history query layer: `HistoryQuery` interface + `SqliteHistoryQuery` implementation with cursor-based pagination and time-window scoping.

Purpose: Given a trajectory (located via TrajectoryLocator), retrieve bounded history entries from run records with cursor pagination. This is the second stage of the M3 retrieval pipeline — TrajectoryLocator finds trajectories, HistoryQuery retrieves their detailed history.

Output: HistoryQuery interface, SqliteHistoryQuery class with cursor pagination, HistoryQueryCursor type, comprehensive test suite, updated index exports.

</domain>

<decisions>
## Implementation Decisions

### Data Source Mapping
- **D-01:** HistoryQueryEntry data comes from RunRecord field mapping — no new storage tables needed
- **D-02:** Each RunRecord maps to 2 HistoryQueryEntry items:
  - Entry 1: `role='system'`, `text=run.inputPayload`, `ts=run.startedAt`
  - Entry 2: `role='assistant'`, `text=run.outputPayload`, `ts=run.startedAt` (or `endedAt` if available)
- **D-03:** `toolName` and `toolResultSummary` derived from run metadata when available (runtime_kind mapping)
- **D-04:** If inputPayload/outputPayload is null/empty, corresponding entry has `text=undefined` — not omitted, still produces entry for timestamp continuity

### Pagination Strategy
- **D-05:** Opaque JSON cursor — base64-encoded JSON `{taskId, lastRunId, direction}`
- **D-06:** Client receives opaque string, does not parse it. Server decodes to resume query position.
- **D-07:** Cursor is position-based (not offset-based), so new data insertion does not affect pagination stability
- **D-08:** `HistoryQueryResult.truncated` (already defined in context-payload.ts) indicates more entries exist beyond the returned page

### Dependency on TrajectoryLocator
- **D-09:** HistoryQuery depends on TrajectoryLocator — the query flow is: locate() → get runs for trajectory → map to entries → apply bounds → return with cursor
- **D-10:** HistoryQuery accepts a `trajectoryRef` (taskId) as primary input, not a raw TrajectoryLocateQuery
- **D-11:** Caller is responsible for using TrajectoryLocator first, then passing the trajectoryRef to HistoryQuery

### Boundary Constraints
- **D-12:** Default page size: 50 entries per query (configurable constant)
- **D-13:** Default time window: last 24 hours (configurable constant)
- **D-14:** Hard max: 200 entries per query (prevents unbounded queries)
- **D-15:** Cursor does not expire — it is position-based, not time-based
- **D-16:** Time window applies as a filter on run.started_at, narrowing the scope before pagination

### Claude's Discretion
- Exact cursor encoding format (JSON structure details)
- Error handling for malformed cursors
- Whether to add a `HistoryQueryOptions` type for limit/timeWindow overrides
- How to handle runs with no payload data (skip entry or include empty)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Output Type Contracts
- `packages/principles-core/src/runtime-v2/context-payload.ts` — Defines HistoryQueryEntry, HistoryQueryResult, TrajectoryLocateQuery, TrajectoryCandidate (locked output types)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDRuntimeError, error categories including `history_not_found`

### Dependency (m3-01 output)
- `packages/principles-core/src/runtime-v2/store/trajectory-locator.ts` — TrajectoryLocator interface (must use for trajectory resolution)
- `packages/principles-core/src/runtime-v2/store/sqlite-trajectory-locator.ts` — SqliteTrajectoryLocator implementation

### Data Source (M2)
- `packages/principles-core/src/runtime-v2/store/run-store.ts` — RunStore interface, RunRecord type (source data for entry mapping)
- `packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts` — SqliteRunStore implementation pattern to follow
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` — SqliteConnection, runs table schema

### Project Constraints
- `.planning/phases/m3-01-TrajectoryLocator/CONTEXT.md` — M3 boundary constraints (no LLM, no OpenClaw, PD-owned stores only)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TrajectoryLocator` interface — already built in m3-01, provides locate() for trajectory resolution
- `RunStore.listRunsByTask(taskId)` — M2 method that returns all runs for a task, directly usable for history retrieval
- `HistoryQueryResultSchema` / `HistoryQueryEntrySchema` — output contracts already defined in context-payload.ts with TypeBox validation

### Established Patterns
- Interface + SqliteImplementation pattern: `run-store.ts` → `sqlite-run-store.ts`, `trajectory-locator.ts` → `sqlite-trajectory-locator.ts`
- Constructor injection of `SqliteConnection` — single parameter, follows all existing stores
- TypeBox `Value.Check()` validation on return values — consistent with SqliteRunStore pattern
- `--no-verify` on commits in worktree mode, normal commits in sequential mode

### Integration Points
- `TrajectoryLocator.locate()` returns `TrajectoryCandidate.trajectoryRef` (= taskId) — this feeds into HistoryQuery
- `RunStore.listRunsByTask(taskId)` returns `RunRecord[]` — this is the raw data to map
- `packages/principles-core/src/runtime-v2/index.ts` — needs updated exports for new types
- `context-payload.ts` — already has all output types, may need `HistoryQueryCursor` type if it doesn't exist

</code_context>

<specifics>
## Specific Ideas

No specific requirements — standard bounded query pattern with cursor pagination.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: m3-02-BoundedHistoryQuery*
*Context gathered: 2026-04-22*
