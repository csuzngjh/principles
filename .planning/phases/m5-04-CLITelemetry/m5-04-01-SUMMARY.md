---
phase: m5-04-CLITelemetry
plan: m5-04-01
subsystem: runtime-v2/store
tags: [runtime-state-manager, query-methods, m5, cli-telemetry]
dependency_graph:
  requires: []
  provides: [CLIV-01, CLIV-02, CLIV-03]
  affects: [diagnose-status, artifact-view, candidate-view]
tech_stack:
  added: [CommitRecord, CandidateRecord, ArtifactRecord, ArtifactWithCandidates interfaces]
  patterns: [assertInitialized guard, direct SQL via db.prepare(), JOIN queries]
key_files:
  created: []
  modified:
    - packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts
decisions:
  - Used direct SQL via `this.connection.getDb()` since candidates/artifacts tables are not managed by TaskStore/RunStore
  - getArtifactWithCandidates delegates to getArtifact + separate candidates query (per D-06 spec)
  - All row mappers inline to avoid creating new helper functions for simple transformations
metrics:
  duration: "~2 min"
  completed: "2026-04-24T15:29:00Z"
  tasks: 3/3
  files: 1
---

# Phase m5-04-01 Plan: RuntimeStateManager Query Methods

**One-liner:** 5 new query methods added to RuntimeStateManager for CLI artifact/candidate/commit access

## Completed Tasks

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Read existing RuntimeStateManager and schema context | — | — |
| 2 | Add 5 query methods + new result types | `82912a0c` | `runtime-state-manager.ts` |
| 3 | Verify type exports + TypeScript compilation | `82912a0c` (same commit) | `runtime-state-manager.ts` |

## What Was Implemented

Added 5 query methods to `RuntimeStateManager`:

1. **getCommitByTaskId(taskId)** — Returns `CommitRecord | null`. Queries `commits` table ordered by `created_at DESC LIMIT 1`. For diagnose status to return commitId/artifactId for succeeded tasks.

2. **getCandidatesByTaskId(taskId)** — Returns `CandidateRecord[]`. JOIN through `tasks → runs → commits → principle_candidates`. Per D-05 chain.

3. **getCandidate(candidateId)** — Returns `CandidateRecord | null`. Single-row lookup from `principle_candidates`.

4. **getArtifact(artifactId)** — Returns `ArtifactRecord | null`. Single-row lookup from `artifacts`.

5. **getArtifactWithCandidates(artifactId)** — Returns `ArtifactWithCandidates | null`. Delegates to getArtifact then queries candidates by artifact_id.

Exported types: `CommitRecord`, `CandidateRecord`, `ArtifactRecord`, `ArtifactWithCandidates`.

## Deviations from Plan

None — plan executed exactly as written.

## Test Results

```
1 failed | 34 passed (35 test files)
3 failed | 379 passed (382 tests)
```

Pre-existing failures in `sqlite-history-query.test.ts` (3 tests) unrelated to these changes. All new methods compile clean with `npx tsc --noEmit`.

## Self-Check

- [x] All 5 methods present in runtime-state-manager.ts
- [x] TypeScript compiles clean (noEmit passed)
- [x] All new types exported
- [x] Commit `82912a0c` verified in git log