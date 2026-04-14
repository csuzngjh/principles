---
phase: 22-bc02-residual-fallback-cleanup
plan: 01
subsystem: workspace-resolution
tags: [bc-02, fallback-removal, boundary-contract]
key-files:
  modified:
    - packages/openclaw-plugin/src/tools/deep-reflect.ts
    - packages/openclaw-plugin/src/tools/critique-prompt.ts
metrics:
  files_changed: 2
  lines_added: 10
  lines_removed: 10
---

# Phase 22 Plan 01: BC-02 Residual Fallback Cleanup

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1-2 | 8587a75 | fix(tools): remove last api.resolvePath('.') fallbacks (BC-02) |

## Deviations

None — both files changed exactly as planned.

## Self-Check: PASSED

- `rg "api\.resolvePath" packages/openclaw-plugin/src/tools/` returns zero matches
- deep-reflect.ts throws `WorkspaceNotFoundError` when workspace cannot be resolved
- critique-prompt.ts throws `Error` when workspace cannot be resolved (no fallback)
- TypeScript compiles without errors
