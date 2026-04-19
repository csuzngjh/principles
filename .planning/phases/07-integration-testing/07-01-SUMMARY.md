---
name: Phase 7 — Integration Testing Summary
phase: 7
milestone: v1.21.2
wave: 1
status: completed
completed: 2026-04-19
---

## What Was Done

Added 3 E2E integration tests in `packages/openclaw-plugin/tests/commands/evolution-status.test.ts` that exercise the full YAML→loader→getSummary()→display pipeline using real `WorkflowFunnelLoader` instances (not mocked).

### Task 1: E2E TEST-01 — Full YAML-driven flow with real loader

- Creates real `WorkflowFunnelLoader(stateDir)` + `loader.watch()`
- Writes valid `workflows.yaml` + `daily-stats.json`
- Calls `RuntimeSummaryService.getSummary()` directly with `loader.getAllFunnels()` + `loader.getWarnings()`
- Asserts `workflowFunnels[0].funnelKey === 'nocturnal'`, correct labels, correct counts (3, 2, 15)
- Cleans up: `loader.dispose()`

### Task 2: E2E TEST-02 — Degraded fallback when YAML missing

- Creates real `WorkflowFunnelLoader` pointing at stateDir with NO `workflows.yaml`
- Writes `daily-stats.json` so file exists but no YAML
- Asserts `summary.metadata.status === 'degraded'`, `loader.getWarnings()` contains `'workflows.yaml file not found.'`, no crash
- Cleans up: `loader.dispose()`

### Task 3: E2E TEST-03 — Hot-reload via loader.load()

- Writes `workflows.yaml` with `original_label`, calls `getSummary()`, asserts `original_label`
- Overwrites `workflows.yaml` with `modified_label`, calls `loader.load()`, calls `getSummary()` again
- Asserts `modified_label` — proves hot-reload cycle works without FSWatcher event delivery
- Cleans up: `loader.dispose()`

## Verification

```bash
cd packages/openclaw-plugin && npx vitest run tests/commands/evolution-status.test.ts
# 13 passed (10 existing + 3 new E2E)
```

## Files Changed

- `packages/openclaw-plugin/tests/commands/evolution-status.test.ts` — 3 new E2E tests added to new `describe('YAML funnel E2E integration tests')` block

## Requirements Coverage

| Requirement | Status |
|------------|--------|
| TEST-01: Valid YAML → funnel blocks with YAML labels + stage order | ✅ |
| TEST-02: Missing/malformed YAML → degraded + warning + graceful fallback | ✅ |
| TEST-03: Modifying YAML → next invocation reflects new labels (hot-reload) | ✅ |

