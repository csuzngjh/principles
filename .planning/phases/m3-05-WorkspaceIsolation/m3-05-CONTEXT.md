---
phase: m3-05
milestone: v2.2 M3
status: context_gathered
gathered: "2026-04-22"
---

# Context: Workspace Isolation + Integration (m3-05)

## Phase Goal

Enforce workspace scoping on all operations, wire M3 retrieval into CLI, end-to-end integration tests.

## Requirements

- **RET-11**: Workspace ID required for all operations → **Already satisfied by architecture** (SqliteConnection per-workspace DB)
- **RET-12**: No cross-workspace data leakage → **Already satisfied** (separate DB files, no cross-DB queries)
- **RET-13**: CLI commands for locate / query / build → **Needs implementation**

## Current Architecture

### Workspace Isolation (already done)

- `SqliteConnection(workspaceDir)` creates DB at `<workspaceDir>/.pd/state.db`
- All store components accept `SqliteConnection` → scoped to that workspace
- No workspace ID columns in schema — isolation is filesystem-level
- Cross-workspace leakage is architecturally impossible

### CLI Infrastructure

- Package: `packages/pd-cli/` with commander v12
- Binary: `"bin": { "pd": "./dist/index.js" }`
- Workspace resolution: `resolveWorkspaceDir()` defaults to `process.cwd()`
- Existing commands: `pd task list/show`, `pd run list/show`, `pd pain record`, `pd health`, etc.
- Pattern: `resolveWorkspaceDir()` → `RuntimeStateManager({ workspaceDir })` → command logic → `close()`

### Missing Commands (RET-13)

1. `pd trajectory locate` — locate trajectory by criteria
2. `pd history query <taskId>` — query run history with pagination
3. `pd context build <taskId>` — assemble diagnostician context payload

## Decisions

### D1: No changes needed for RET-11/12
- Workspace isolation already enforced at SqliteConnection level
- Add integration tests to verify (two workspaces, no cross-leakage)

### D2: CLI command structure
- `pd trajectory locate --task <taskId> | --run <runId> | --pain <painId> | --from <date> --to <date>`
- `pd history query <taskId> [--limit N] [--cursor <cursor>]`
- `pd context build <taskId>`

### D3: Output format
- Default: human-readable table (consistent with existing commands)
- `--json` flag for machine-readable output

### D4: No RuntimeStateManager changes
- CLI commands instantiate stores directly (SqliteConnection + specific stores)
- RuntimeStateManager wraps different concerns; M3 stores are standalone
