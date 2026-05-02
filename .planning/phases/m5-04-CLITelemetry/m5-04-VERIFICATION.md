---
plan: m5-04
phase: m5-04-CLITelemetry
status: passed
completed: 2026-04-24T15:45:00+0800
requirements:
  - CLIV-01
  - CLIV-02
  - CLIV-03
  - CLIV-04
  - CLIV-05
  - TELE-01
  - TELE-02
  - TELE-03
  - TELE-04
  - TELE-05
---

# Verification: m5-04 — CLI + Telemetry

## Goal
Operators can inspect artifacts and candidates via fixed CLI commands, commit operations emit telemetry.

## Must-Haves

### 1. CLI Functions (CLIV-01 through CLIV-05)

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| CLIV-01: `pd candidate list --task-id` | `candidateList()` in `diagnose.ts` calls `stateManager.getCandidatesByTaskId()` | ✓ PASS |
| CLIV-02: `pd candidate show <candidateId>` | `candidateShow()` calls `stateManager.getCandidate()` | ✓ PASS |
| CLIV-03: `pd artifact show <artifactId>` | `artifactShow()` calls `stateManager.getArtifactWithCandidates()` | ✓ PASS |
| CLIV-04: `pd diagnose status --json` extended | `DiagnoseStatusResult` has nullable `commitId`, `artifactId`, `candidateCount` | ✓ PASS |
| CLIV-05: Plain TypeScript types | All interfaces, no CLI framework dependency | ✓ PASS |

### 2. Telemetry Events (TELE-01 through TELE-05)

| Requirement | Implementation | Status |
|-------------|---------------|--------|
| TELE-01: `diagnostician_artifact_committed` | Emitted in `succeedTask()` after `committer.commit()` succeeds | ✓ PASS |
| TELE-02: `diagnostician_artifact_commit_failed` | Emitted in `succeedTask()` catch block when commit throws | ✓ PASS |
| TELE-03: `principle_candidate_registered` | Emitted per `kind='principle'` recommendation after commit success | ✓ PASS |
| TELE-04: All use `emitTelemetry()` | All 3 events use `StoreEventEmitter.emitTelemetry()` via `emitDiagnosticianEvent()` | ✓ PASS |
| TELE-05: `RunnerPhase.Committing` | Confirmed present at `runner-phase.ts:16` (added in m5-03) | ✓ PASS |

## Self-Check

```bash
# Verify telemetry events in telemetry-event.ts
grep -c "diagnostician_artifact_committed\|diagnostician_artifact_commit_failed\|principle_candidate_registered" src/telemetry-event.ts
# Expected: 6 (3 comment refs + 3 literal types)

# Verify events in diagnostician-runner.ts
grep -c "diagnostician_artifact_committed\|diagnostician_artifact_commit_failed\|principle_candidate_registered" src/runtime-v2/runner/diagnostician-runner.ts
# Expected: 3 (1 comment + 1 emit call each)

# Verify CLI functions in diagnose.ts
grep -c "candidateList\|candidateShow\|artifactShow" src/runtime-v2/cli/diagnose.ts
# Expected: 6+ (export declarations + function bodies)
```

## Tests

- `diagnostician-runner.test.ts`: 20/20 passing (4 new telemetry tests added)
- `diagnostician-committer.test.ts`: 10/10 passing
- TypeScript: clean (`npx tsc --noEmit`)

## Summary

**Score: 10/10 must-haves verified**
**Status: PASSED**

All CLIV and TELE requirements for m5-04 are implemented and verified.
