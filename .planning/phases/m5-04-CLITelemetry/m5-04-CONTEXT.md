# Phase m5-04: CLI + Telemetry - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** Operators can inspect artifacts and candidates via fixed CLI commands, commit operations emit telemetry events.

**This phase delivers:**
1. `pd candidate list --task-id <taskId>` — list principle candidates for a task
2. `pd candidate show <candidateId>` — show candidate detail
3. `pd artifact show <artifactId>` — show artifact content + associated candidates
4. `pd diagnose status --task-id <taskId> --json` extended with commitId, artifactId, candidateCount
5. Three new telemetry events: `diagnostician_artifact_committed`, `diagnostician_artifact_commit_failed`, `principle_candidate_registered`

**Phase dependency:** m5-03 (Runner Integration) — committer wired into runner, resultRef = `commit://<commitId>`
</domain>

<decisions>
## Implementation Decisions

### CLI Data Access
- **D-01:** All CLI data access goes through `RuntimeStateManager` interface — no direct store imports in CLI functions. This maintains store isolation. CLI functions receive `RuntimeStateManager` as a constructor/options dependency.

### CLI Result Types
- **D-02:** `DiagnoseStatusResult` extended with nullable `commitId`, `artifactId`, `candidateCount` fields (only populated when task status is `succeeded`). No separate result type needed.

### Telemetry Event Emission
- **D-03:** All telemetry events are emitted from `DiagnosticianRunner.succeedTask()` — committer logic stays pure (commit only), runner owns event emission. No eventEmitter injection needed inside `DiagnosticianCommitter`.

### Event Names
- **D-04:** Three new events per TELE-01/02/03:
  - `diagnostician_artifact_committed` — emitted on commit success in `succeedTask()`
  - `diagnostician_artifact_commit_failed` — emitted on commit failure in `handleValidationError()` (after committer throws `artifact_commit_failed`)
  - `principle_candidate_registered` — emitted per candidate after successful commit

### Candidate List Query
- **D-05:** `pd candidate list --task-id <taskId>` joins through: `tasks → runs → commits → principle_candidates` where `taskId` matches. Returns array of candidate records with full detail.

### Artifact Show Query
- **D-06:** `pd artifact show <artifactId>` returns the artifact record + inline list of associated candidates. Single query with JOIN.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Core Files
- `packages/principles-core/src/runtime-v2/cli/diagnose.ts` — existing CLI surface (run + status functions)
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager interface (data access layer)
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` — DiagnosticianCommitter interface + SqliteDiagnosticianCommitter
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner (succeedTask with committer)
- `packages/principles-core/src/runtime-v2/runner/runner-phase.ts` — RunnerPhase enum (Committing already added in m5-03)
- `packages/principles-core/src/runtime-v2/task-status.ts` — TaskRecord type
- `packages/principles-core/src/runtime-v2/runner/runner-result.ts` — RunnerResult type

### Requirements
- `.planning/milestones/pd-runtime-v2-m5/REQUIREMENTS.md` — CLIV-01 through CLIV-05, TELE-01 through TELE-05

### Prior Context
- `.planning/phases/m5-02-DiagnosticianCommitterCore/m5-02-CONTEXT.md` — Committer interface and transaction design

### Telemetry
- `packages/principles-core/src/telemetry-event.ts` — TelemetryEvent schema
- `packages/principles-core/src/runtime-v2/store/event-emitter.ts` — StoreEventEmitter interface

</canonical_refs>

<code_context>
### Reusable Assets
- `DiagnosticianCommitter` interface — used as-is (already implemented in m5-02)
- `RuntimeStateManager` — existing interface for all task/run queries
- `RunnerPhase` enum — `Committing` already added (m5-03)
- `emitDiagnosticianEvent()` private method in `DiagnosticianRunner` — existing pattern for telemetry

### Established Patterns
- CLI functions in `diagnose.ts` accept options objects (`{ taskId, stateManager }`)
- Result types are plain TypeScript interfaces (no class wrappers)
- Telemetry events use `eventEmitter.emitTelemetry()` with `TelemetryEvent` schema

### Integration Points
- `DiagnoseStatusResult` type in `diagnose.ts` — extend with nullable commit fields
- `RuntimeStateManager` needs new query methods: `getCandidatesByTaskId`, `getCandidate`, `getArtifact`, `getArtifactWithCandidates`
- `DiagnosticianRunner.succeedTask()` — add new telemetry emit calls after commit
</code_context>

<specifics>
## Specific Ideas

**No specific references or "like X" examples** — discussion stayed within standard patterns.
</specifics>

<deferred>
## Deferred Ideas

None — all scope items discussed and captured in decisions above.
</deferred>

---

*Phase: m5-04-CLITelemetry*
*Context gathered: 2026-04-24*
