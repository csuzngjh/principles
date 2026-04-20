# Phase 11: Evolution Tasks CLI - Context

**Gathered:** 2026-04-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Users can view evolution tasks via `pd evolution tasks` command. The CLI reads from the trajectory database (`{workspaceDir}/.state/.trajectory.db`) using `TrajectoryDatabase.listEvolutionTasks()`, following the same SDK extraction pattern established in Phases 9 and 10.

</domain>

<decisions>
## Implementation Decisions

### Task Fields Displayed
- **D-01:** Standard detail level — each task line shows: `taskId`, `status`, `source`, `score`, `enqueuedAt`, `taskKind`
- Fields NOT shown by default: `id`, `traceId`, `reason`, `startedAt`, `completedAt`, `retryCount`, `maxRetries`, `lastError`, `resolution`, `resultRef`

### Default Filters
- **D-02:** No filter by default — `pd evolution tasks` shows ALL tasks regardless of status
- This matches Phase 10's `pd samples list` behavior which defaults to `pending` but allows `--status` override
- Support `--status` flag: `pending`, `in_progress`, `completed`, `all` (default: `all`)
- Support `--limit` flag (default: 50) and `--date-from` / `--date-to` flags

### Task Identity (CLI)
- **D-03:** Both numeric `id` and string `taskId` are supported for CLI interactions
- `pd evolution tasks show <id>` accepts either — numeric id or string taskId

### Additional Subcommand
- **D-04:** Include `pd evolution tasks show <id>` subcommand
  - Shows full `EvolutionTaskRecord` with all fields formatted
  - Accepts both numeric id and string taskId

### SDK Extraction Pattern
- **D-05:** Extract `listEvolutionTasks(workspaceDir, filters)` to `@principles/core/evolution-store.ts`
  - Mirrors Phase 10's `trajectory-store.ts` pattern
  - Uses `better-sqlite3` to read from `{workspaceDir}/.state/.trajectory.db`
  - Returns `EvolutionTaskRecord[]` (type imported/copied from trajectory-types)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Trajectory / Evolution Core
- `packages/openclaw-plugin/src/core/trajectory.ts` §534-587 — `TrajectoryDatabase.listEvolutionTasks()` implementation
- `packages/openclaw-plugin/src/core/trajectory-types.ts` §161-201 — `EvolutionTaskRecord`, `EvolutionTaskFilters` type definitions

### Phase 10 Pattern (SDK Extraction)
- `packages/principles-core/src/trajectory-store.ts` — Phase 10 extraction pattern for `listCorrectionSamples`, `reviewCorrectionSample`
- `packages/principles-core/package.json` — exports map + `better-sqlite3` dependency pattern
- `packages/pd-cli/src/commands/samples-list.ts` — Phase 10 CLI command pattern (list with status filter)
- `packages/pd-cli/src/commands/samples-review.ts` — Phase 10 CLI command pattern (review with decision)
- `packages/pd-cli/src/index.ts` — Commander registration pattern for samples subcommands
- `packages/pd-cli/src/resolve-workspace.ts` — `resolveWorkspaceDir()` for SDK functions

### Evolution Query Service (Display Formatting)
- `packages/openclaw-plugin/src/service/evolution-query-service.ts` — `TaskListFilters`, `calculateDuration()`, `STAGE_LABELS`, `STAGE_COLORS`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `resolveWorkspaceDir()` from `pd-cli/src/resolve-workspace.ts` — already available for SDK functions
- `better-sqlite3` already in `@principles/core` dependencies (added Phase 10)
- `trajectory-store.ts` pattern — pure function extraction from `TrajectoryDatabase` class methods

### Established Patterns
- CLI command pattern: Commander nested subcommands, `handleXxx` handler functions in `commands/`
- SDK extraction pattern: pure functions in `@principles/core`, workspaceDir as first arg, try/catch with graceful fallback
- Output format: human-readable `console.log` lines, one line per item, count summary at end

### Integration Points
- New command registered in `pd-cli/src/index.ts` under `evolution` subcommand
- New SDK functions exported from `@principles/core` via `evolution-store.ts`
- Same trajectory DB path as Phase 10: `{workspaceDir}/.state/.trajectory.db`

</code_context>

<specifics>
## Specific Ideas

- Task lines format: `[<status>] <taskId> (<taskKind>) score=<score> source=<source> enqueued=<enqueuedAt>`
- Example line: `[pending] task_042 (principle_proposal) score=72 source=diagnostician enqueued=2026-04-20T10:30:00Z`
- `show` subcommand output should be multi-line, one field per line, with field names labeled

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 11-evolution-tasks-cli*
*Context gathered: 2026-04-20*
