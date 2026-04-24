---
plan: m5-04-03
phase: m5-04-CLITelemetry
name: Telemetry Events — diagnostician_artifact_committed, diagnostician_artifact_commit_failed, principle_candidate_registered
wave: 2
status: complete
completed: 2026-04-24T15:40:00+0800
requirements:
  - TELE-01
  - TELE-02
  - TELE-03
  - TELE-04
  - TELE-05
---

# Summary: m5-04-03 — Telemetry Events

## What was built

Added 3 new telemetry events emitted from `DiagnosticianRunner.succeedTask()`:

- `diagnostician_artifact_committed` (TELE-01): Emitted after successful `committer.commit()`, carries `commitId`, `artifactId`, `candidateCount`
- `diagnostician_artifact_commit_failed` (TELE-02): Emitted when `committer.commit()` throws, carries `errorCategory` and `errorMessage`
- `principle_candidate_registered` (TELE-03): Emitted once per `kind='principle'` recommendation after commit success, carries `candidateIndex`, `commitId`, `kind`, `description`, `sourceRunId`

## Key files modified

| File | Change |
|------|--------|
| `src/telemetry-event.ts` | Added 3 new literal types to `TelemetryEventType` union; updated comment header from 21→24 events |
| `src/runtime-v2/runner/diagnostician-runner.ts` | Wrapped `committer.commit()` in try-catch; added all 3 emit calls |
| `src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts` | 4 new tests covering all 3 events + TELE-04 verification |

## Technical notes

- `RunnerPhase.Committing` confirmed present at `runner-phase.ts:16` (was added in m5-03 Task 1)
- All events use existing `emitDiagnosticianEvent()` via `StoreEventEmitter.emitTelemetry()` — no new infrastructure
- `diagnostician_artifact_commit_failed` emits before re-throw, so telemetry is captured even on failure paths
- `principle_candidate_registered` uses `candidateIndex` (not generated `candidateId`) since IDs are created inside the committer
- 20/20 diagnostician-runner tests pass; 30/30 combined with diagnostician-committer tests

## Decisions applied

- D-03: TELE events emitted from `DiagnosticianRunner.succeedTask()`, not `DiagnosticianCommitter`
- D-04: Event names match exactly: `diagnostician_artifact_committed`, `diagnostician_artifact_commit_failed`, `principle_candidate_registered`
