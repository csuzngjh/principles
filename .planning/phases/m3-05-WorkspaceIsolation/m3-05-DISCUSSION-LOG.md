---
phase: m3-05
status: decisions_locked
locked: "2026-04-22"
---

# Discussion Log: Workspace Isolation + Integration (m3-05)

## Decisions Locked

### D1: RET-11/12 already satisfied by architecture
- Workspace isolation enforced at `SqliteConnection(workspaceDir)` level
- Each workspace gets its own DB file at `<workspaceDir>/.pd/state.db`
- No workspace ID columns in schema — isolation is filesystem-level
- Cross-workspace leakage is architecturally impossible

### D2: RET-13 via CLI integration
- `pd trajectory locate --task/--run/--pain/--from/--to/--status [--json]`
- `pd history <taskId> [--limit N] [--cursor <cursor>] [--json]`
- `pd context <taskId> [--json]`

### D3: Output format
- Human-readable table by default (consistent with existing commands)
- `--json` flag for machine-readable output

### D4: No RuntimeStateManager changes needed
- CLI commands instantiate stores directly: `SqliteConnection + specific stores`
- M3 stores are standalone composable components

## Scope
- In scope: CLI commands, workspace isolation tests, RET-13
- Out of scope: diagnostician runner (M4), unified commit (M5)
