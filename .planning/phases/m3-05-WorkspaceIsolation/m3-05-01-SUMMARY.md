---
phase: m3-05
plan: m3-05-01
status: complete
completed: "2026-04-22"
---

# Summary: Workspace Isolation + Integration

**Plan:** m3-05-01 — Workspace Isolation + Integration
**Status:** Complete
**Commit:** 50dff183

## What was built

- `pd trajectory locate` command (trajectory.ts)
- `pd history <taskId>` command (history.ts)
- `pd context <taskId>` command (context.ts)
- Workspace isolation integration tests (7 tests)
- Commands registered in pd-cli index.ts

## Key decisions

- RET-11/12 already satisfied by SqliteConnection architecture — no code changes needed
- CLI commands instantiate stores directly (no RuntimeStateManager changes)
- `--json` flag for machine-readable output on all commands
- Mock TaskStore used in isolation test for context assembler (same pattern as m3-03 tests)

## Key files

### created
- packages/pd-cli/src/commands/trajectory.ts
- packages/pd-cli/src/commands/history.ts
- packages/pd-cli/src/commands/context.ts
- packages/principles-core/src/runtime-v2/store/workspace-isolation.test.ts

### modified
- packages/pd-cli/src/index.ts

## Test results

- 7/7 workspace isolation tests pass
- 160/160 total runtime-v2 tests pass (0 regressions)
