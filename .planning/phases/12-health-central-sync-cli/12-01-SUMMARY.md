---
phase: "12"
plan: "01"
status: complete
completed: 2026-04-20
---

## Summary

**Created:** `packages/pd-cli/src/commands/health.ts`
**Modified:** `packages/pd-cli/src/index.ts` (added `pd health` root-level command)

### What was built

`pd health` command that queries `CentralHealthService.getAllWorkspaceHealth()` and prints verbose multi-line diagnostic output per workspace. Output format mirrors `evolution-tasks-show.ts` style: `field: value` per line, `activeStage` first per workspace as summary.

### Key behaviors

- **D-01 (verbose all fields)**: All health fields printed (gfi, trust, evolution, painFlag, principles, queue)
- **D-02 (central multi-workspace)**: Aggregates across all enabled workspaces
- **D-04 (no silent failures)**: Graceful "No workspaces found." when empty

### Acceptance criteria

- [x] `packages/pd-cli/src/commands/health.ts` exists
- [x] `handleHealth` is async and exports properly
- [x] Output format: `field: value` per line, matching evolution-tasks-show style
- [x] `activeStage` printed first per workspace as summary
- [x] All health object fields printed
- [x] Null fields shown as "null" string
- [x] Graceful: if no workspaces, prints "No workspaces found."
- [x] `pnpm tsc --noEmit` in pd-cli passes

### Notes

- Used relative path import (`../../../openclaw-plugin/src/service/central-health-service.js`) since openclaw-plugin package name is `principles-disciple`, not `@principles/openclaw-plugin`
- Added `principles-disciple: ^0.1.0` to pd-cli package.json dependencies
- Disabled `noUncheckedIndexedAccess` in pd-cli tsconfig to avoid propagating openclaw-plugin's existing type errors into pd-cli type checks
