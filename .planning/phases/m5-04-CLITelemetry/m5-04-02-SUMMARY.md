# Phase M5 Plan 04-02: CLI Functions - Candidate/Artifact Inspection + Diagnose Status Extension

## One-liner

JWT auth with refresh rotation using jose library

## Metadata

| Field | Value |
|-------|-------|
| plan | m5-04-02 |
| phase | m5-04-CLITelemetry |
| subsystem | CLI / Diagnose |
| tags | cli, diagnostician, candidates, artifacts, cliv-01, cliv-02, cliv-03, cliv-04, cliv-05 |
| dependency-graph | requires: m5-04-01 (RuntimeStateManager query methods) |
| tech-stack-added | TypeScript interfaces (plain, no CLI framework) |
| key-files | `packages/principles-core/src/runtime-v2/cli/diagnose.ts` |
| decisions | All CLI results are plain TypeScript interfaces returned from async functions; no CLI framework; all data access via RuntimeStateManager |
| completed | 2026-04-24 |
| duration | ~8 min |

## Must-Haves (Verification)

| Requirement | Status |
|-------------|--------|
| pd candidate list --task-id returns candidates for that task | DONE |
| pd candidate show returns title, description, confidence, source, status | DONE |
| pd artifact show returns artifact content + associated candidates | DONE |
| diagnose status extended with nullable commitId, artifactId, candidateCount | DONE |
| All results are plain TypeScript interfaces, no CLI framework | DONE |

## Tasks Completed

| # | Task | Status | Commit |
|---|------|--------|--------|
| 1 | Add new CLI option interfaces and result types to diagnose.ts | DONE | 9f37b9a8 |
| 2 | Implement candidateList() function | DONE | 9f37b9a8 |
| 3 | Implement candidateShow() function | DONE | 9f37b9a8 |
| 4 | Implement artifactShow() function | DONE | 9f37b9a8 |
| 5 | Extend DiagnoseStatusResult and status() for CLIV-04 | DONE | 9f37b9a8 |
| 6 | Verify all exports and TypeScript compilation | DONE | 9f37b9a8 |

## Commits

- `9f37b9a8` feat(m5-04-02): implement CLI candidate/artifact inspection + diagnose status extension

## Deviations from Plan

None - plan executed exactly as written.

## Test Results

- `diagnose.test.ts`: 3/3 passed
- `sqlite-history-query.test.ts`: 3 failures are pre-existing, unrelated to this plan (stashed and verified)

## CLIV Requirement Mapping

| Requirement | Function | Verification |
|-------------|----------|--------------|
| CLIV-01: pd candidate list --task-id | candidateList() | getCandidatesByTaskId(taskId) returns CandidateRecord[] |
| CLIV-02: pd candidate show | candidateShow() | getCandidate(candidateId) returns full CandidateRecord fields |
| CLIV-03: pd artifact show | artifactShow() | getArtifactWithCandidates(artifactId) returns artifact + candidates |
| CLIV-04: diagnose status extension | status() | commitId/artifactId/candidateCount populated for succeeded tasks |
| CLIV-05: plain TypeScript types | All interfaces | No class instances, no CLI framework |

## Self-Check: PASSED

- diagnose.ts exists with all 4 CLI functions
- TypeScript compiles clean (no output from tsc --noEmit)
- diagnose.test.ts passes (3/3)
- DiagnoseStatusResult has 7 fields (original 5 + commitId + artifactId + candidateCount)
