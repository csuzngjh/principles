---
phase: 21-runtime-contract-and-end-to-end-hardening
plan: 01
subsystem: runtime-contract, e2e-hardening
tags: [rt-01, rt-02, rt-03, e2e-01, e2e-02, e2e-03, runtime, e2e]
key-files:
  modified:
    - packages/openclaw-plugin/src/utils/subagent-probe.ts
    - packages/openclaw-plugin/src/service/evolution-worker.ts
    - packages/openclaw-plugin/src/service/nocturnal-target-selector.ts
    - packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts
    - packages/openclaw-plugin/tests/service/*.test.ts
    - packages/openclaw-plugin/tests/hooks/*.test.ts
    - packages/openclaw-plugin/tests/commands/*.test.ts
metrics:
  files_changed: 7
  lines_added: N/A
  lines_removed: N/A
requirements-completed: [RT-01, RT-02, RT-03, E2E-01, E2E-02, E2E-03]
---

# Phase 21 Plan 01: Runtime Contract + End-to-End Hardening

## Commits

| Task | Commit | Description |
|------|--------|-------------|
| 1-6 | d671e55 | Local execution — runtime contract and E2E hardening |

## Deviations

None — all changes implemented as planned.

## Self-Check: PASSED

- `npx tsc --noEmit` passes
- 9 test files, 61 tests passing across service, hooks, commands, and integration tests
- `rg "constructor\.name === 'AsyncFunction'" packages/openclaw-plugin/src` returns zero source matches
- `runtime_unavailable` state distinct from generic downstream failures
- `/pd-reflect` uses shared workspace contract
- Pain signal `session_id` preserved end-to-end
- Session selection bounded to triggering timestamp
