---
phase: "12"
plan: "02"
status: complete
completed: 2026-04-20
---

## Summary

**Created:** `packages/pd-cli/src/commands/central-sync.ts`
**Modified:** `packages/pd-cli/src/index.ts` (added `central` command group + `sync` subcommand)

### What was built

`pd central sync` command that triggers `CentralDatabase.syncAll()` and reports per-workspace sync results. Exit code 0 on success, non-zero with detailed error message on failure.

### Key behaviors

- **D-03 (trigger + status)**: Runs sync AND reports results
- **D-04 (detailed errors)**: On failure prints `Error: Sync failed — {reason}` and exits with code 1
- **Success output**: `Sync complete — N records across W workspace(s).` plus per-workspace breakdown `  workspaceName: N records`
- No silent failures (D-04 enforced)

### Acceptance criteria

- [x] `packages/pd-cli/src/commands/central-sync.ts` exists
- [x] `handleCentralSync` is async and exports properly
- [x] On success: prints "Sync complete — N records across W workspace(s)." with per-workspace breakdown
- [x] On failure: prints "Error: Sync failed — {reason}" and exits with code 1
- [x] Never silent failures (D-04)
- [x] `pnpm tsc --noEmit` in pd-cli passes

### Notes

- Used same relative path import pattern as health.ts
- Registered as two-level subcommand: `central` command group + `sync` action
- Both plans required modifying `index.ts` — executed sequentially to avoid merge conflicts
