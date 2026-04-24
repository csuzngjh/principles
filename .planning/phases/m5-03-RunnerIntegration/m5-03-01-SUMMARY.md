---
plan: m5-03-01
phase: m5-03
name: Runner Integration — Committer Injection + Succeed Task Pipeline
wave: 1
status: complete
completed: 2026-04-24
commits:
  - 1668182b feat(m5-03): wire DiagnosticianCommitter into runner pipeline
  - fb03f3ee test(m5-03): add 5 Runner+Committer integration tests
requirements:
  - RUNR-01
  - RUNR-02
  - RUNR-03
  - RUNR-04
  - RUNR-05
must_haves:
  - DiagnosticianRunnerDeps includes DiagnosticianCommitter as required dependency
  - succeedTask calls committer.commit() BEFORE markTaskSucceeded
  - resultRef changes from run://{runId} to commit://{commitId} on success
  - commit failure triggers retryOrFail with artifact_commit_failed category
  - RunnerPhase.Committing added to enum
  - artifact_commit_failed is NOT in PERMANENT_ERROR_CATEGORIES (can retry per RUNR-05)
---

# Summary: m5-03-01 — Runner Integration

## What Was Built

DiagnosticianCommitter wired into DiagnosticianRunner as a required dependency.
Every successful diagnosis now atomically commits its output before the task is
marked succeeded. Commit failures are retried, never silently succeed.

## Key Changes

### Task 1: RunnerPhase.Committing
Added `Committing = 'committing'` between `Validating` and `Completed` in
`RunnerPhase` enum. Phase is set immediately before the `committer.commit()` call.

### Task 2: Committer Dependency Injection
`DiagnosticianCommitter` added as required `readonly committer` field in both
`DiagnosticianRunnerDeps` interface and `DiagnosticianRunner` class.

### Task 3: succeedTask Pipeline Rewrite
`succeedTask` now executes in strict order:
1. `updateRunOutput` — store raw output (unchanged)
2. `this.phase = RunnerPhase.Committing` — new phase transition
3. `committer.commit({ runId, taskId, output, idempotencyKey })` — atomic commit
4. `markTaskSucceeded('commit://<commitId>')` — resultRef is now `commit://` URI
5. telemetry event with `commitId` + `candidateCount` payload

The old `run://{runId}` resultRef is gone.

### Task 4: Error Classification
Verified `artifact_commit_failed` is NOT in `PERMANENT_ERROR_CATEGORIES`. Commit
failures route through `retryOrFail` naturally, retrying until max attempts.

### Task 5: Integration Tests
5 new test cases added to `diagnostician-runner.test.ts`:
- `commit called before markTaskSucceeded` (call order)
- `resultRef uses commit:// scheme`
- `commit failure triggers retry with artifact_commit_failed`
- `commit failure with max attempts marks task failed`
- `RunnerPhase reaches Committing during commit`

## Verification

- TypeScript compiles clean
- 96/96 runner tests pass (91 pre-existing + 5 new)
- All 5 new tests pass individually
- No `run://` resultRef remains in `succeedTask`

## Deviations

None — implementation matched PLAN.md exactly.

## Next

m5-03 is now ready for `/gsd-verify-work` to run phase-level verification.
