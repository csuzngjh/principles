---
phase: m5-05
plan: "01"
status: complete
completed: 2026-04-24T08:27:00Z
duration: ~5 min
requirements:
  - E2EV-01
  - E2EV-02
  - E2EV-03
  - E2EV-04
---

# Phase m5-05 Plan 01: E2E Verification — Summary

## What was built

E2E test file at `packages/principles-core/src/runtime-v2/runner/__tests__/m5-05-e2e.test.ts` (503 lines) covering all 4 hard-gate criteria for M5 completion.

## Scenarios

| # | Name | E2EV | Status | Duration |
|---|------|-------|--------|----------|
| 1 | Happy Path — Full chain traversable | E2EV-01 | PASS | 30ms |
| 2 | Idempotency — same taskId+runId → same commitId, no duplicates | E2EV-02 | PASS | 22ms |
| 3 | Failure Path — transaction rollback, no orphaned rows, task NOT succeeded | E2EV-03 | PASS | 23ms |
| 4 | Traceability + CLI Visibility — SQL chain traversal + candidateList() | E2EV-04 | PASS | 22ms |

## Key design decisions

**Scenario 2 (Idempotency):** runner.run() cannot be called twice on a succeeded task (lease_conflict from acquireLease). Idempotency verified at the committer level by calling `committer.commit()` twice with the same taskId+runId and verifying the same commitId is returned. This correctly reflects how idempotency works in production (retry after failure calls the committer again, not the runner).

**Scenario 3 (Failure):** Uses `db.transaction(() => { INSERT; throw })()` — the throw inside the transaction callback triggers automatic rollback of the artifact insert, simulating mid-transaction failure without needing a complex committer wrapper.

**Scenario 4 (CLI):** Imports `candidateList()` directly from `../../cli/diagnose.js` and calls it with `{ taskId, stateManager }` — no child process needed.

## Files created

- `packages/principles-core/src/runtime-v2/runner/__tests__/m5-05-e2e.test.ts` — 503 lines, 4 scenarios, all pass

## Deviations from plan

- **Scenario 2 approach:** Called `committer.commit()` directly twice instead of `runner.run()` twice. Reason: runner.run() blocks on `acquireLease` when task status is 'succeeded' — idempotency at runner level is not achievable in this way. The committer-level test correctly verifies the idempotency guarantee.

## Verification

```bash
npx vitest run src/runtime-v2/runner/__tests__/m5-05-e2e.test.ts
# Result: 4 passed (4)
```
