---
phase: "12"
plan: null
type: discuss
status: ready_for_planning
gathered: "2026-04-20"
---

# Phase 12: Health + Central Sync CLI - Context

**Gathered:** 2026-04-20
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 12 delivers two CLI commands: `pd health` for workspace diagnostics and `pd central sync` for central server synchronization.

**In scope:**
- `pd health` — queries `CentralHealthService.getAllWorkspaceHealth()` for multi-workspace diagnostic status
- `pd central sync` — triggers a manual sync cycle and reports results

**Out of scope:**
- Local-only health (single workspace) — not implemented
- Background sync daemon — CentralSyncService already runs on interval internally

</domain>

<decisions>
## Implementation Decisions

### Health output detail (D-01)
- **Verbose all fields** — `pd health` shows every field from `getOverviewHealth()`:
  - `gfi: { current, peakToday, threshold, trend[] }`
  - `trust: { stage, stageLabel, score }`
  - `evolution: { tier, points }`
  - `painFlag: { active, source, score }`
  - `principles: { candidate, probation, active, deprecated }`
  - `queue: { pending, inProgress, completed }`
  - `activeStage: healthy | warning | critical`
  - Multi-line labeled format (one field per line, label=value)
  - Mirrors the verbose style of `pd evolution tasks show`

### Health target (D-02)
- **Central multi-workspace** — `pd health` queries `CentralHealthService.getAllWorkspaceHealth()` via the central database
- Requires central database connection — not a local-only command
- Shows health for all enabled workspaces in the central DB
- Graceful fallback: if central DB unreachable, report error with details

### Central sync behavior (D-03)
- **Trigger + status** — `pd central sync` runs one sync cycle AND reports results
- Calls `centralDb.syncAll()` to trigger the sync
- Reports: total records synced, per-workspace breakdown, duration
- Exit code 0 on success, non-zero on failure

### Error handling (D-04)
- **Detailed errors** — on failure: exit code + user message + reason + affected workspace
- Never silent failures
- Report: which operation failed, why, which workspace/endpoint was affected
- Error format mirrors the verbose diagnostic style

### CLI structure (D-05)
- `pd health` — registered under root `program` (not under evolution or tasks)
- `pd central sync` — two-level subcommand under `program`: `central` command group + `sync` action
- Mirrors Phase 9-11 pattern: `pd <noun> <verb>` structure

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core services
- `packages/openclaw-plugin/src/service/health-query-service.ts` — HealthQueryService.getOverviewHealth() returns all health fields
- `packages/openclaw-plugin/src/service/central-health-service.ts` — CentralHealthService.getAllWorkspaceHealth() aggregates across workspaces
- `packages/openclaw-plugin/src/service/central-sync-service.ts` — CentralSyncService.runSyncCycle() performs the sync
- `packages/openclaw-plugin/src/service/central-database.ts` — CentralDatabase.syncAll() returns Map<workspace, count>

### CLI patterns (prior phases)
- `packages/pd-cli/src/commands/evolution-tasks-show.ts` — verbose multi-line labeled output pattern to mirror
- `packages/pd-cli/src/commands/evolution-tasks-list.ts` — list command pattern
- `packages/pd-cli/src/index.ts` — current Commander registration

### SDK extraction (Phase 8, 10, 11)
- `packages/principles-core/src/evolution-store.ts` — SDK extraction pattern for Phase 12

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `HealthQueryService.getOverviewHealth()` — already returns full health object with all fields
- `CentralHealthService.getAllWorkspaceHealth()` — aggregates across all workspaces, returns `{workspaces[], generatedAt}`
- `CentralDatabase.syncAll()` — returns `Map<workspaceName, syncedCount>`

### Established Patterns
- Phase 11 `evolution-tasks-show.ts` uses multi-line labeled format: `field: value` per line
- All prior PD CLI commands use `resolveWorkspaceDir()` for workspace resolution
- SDK functions in `@principles/core` are pure and workspace-dir based

### Integration Points
- `pd health` → `CentralHealthService` → `HealthQueryService` (per workspace) → central DB
- `pd central sync` → `CentralDatabase.syncAll()` → per-workspace sync
- Both require central database connection (not local workspace)

</code_context>

<specifics>
## Specific Ideas

- `pd health` output format: verbose, matches `evolution-tasks-show` style
- `pd central sync` reports per-workspace sync counts like: `workspace1: 42 records, workspace2: 0 records`
- Error messages include the workspace or operation that failed

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
