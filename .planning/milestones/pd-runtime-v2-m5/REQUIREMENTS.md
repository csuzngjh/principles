# M5: Unified Commit + Principle Candidate Intake — Requirements

> Status: Active
> Date: 2026-04-24
> Predecessor: M4 Diagnostician Runner v2 (PR #396, SHIPPED 2026-04-23)
> Source: runtime-v2-milestone-roadmap.md Section M5

## 1. Goal

Make diagnosis output commit atomic and define downstream principle-candidate consumption.

The diagnostician runner (M4) currently writes `run.outputPayload` + `task.resultRef = "run://{runId}"` on success, but does NOT persist structured artifacts or emit principle candidates. M5 closes this gap: every succeeded diagnosis must produce a committed artifact and any principle-candidate recommendations must be registered for downstream intake.

**Core truth:** All atomic commit state lives in SQLite `.pd/state.db`. PrincipleTreeLedger is adapter/bridge only, not part of atomic transaction.

## 2. Scope (IN Scope)

### 2.1 Artifact Registry (ARTF)

Schema and storage layer for committed diagnostician artifacts and principle candidates.

| REQ-ID | Category | Requirement |
|--------|----------|-------------|
| ARTF-01 | Schema | `artifacts` table in `state.db` with columns: artifact_id, run_id, task_id, artifact_kind, content_json, created_at. Idempotent migration via `CREATE TABLE IF NOT EXISTS`. |
| ARTF-02 | Schema | `principle_candidates` table in `state.db` with columns: candidate_id, artifact_id, kind, description, source_run_id, status (pending/consumed/expired), created_at, consumed_at. Idempotent migration. |
| ARTF-03 | Schema | Foreign keys: artifacts.run_id references runs.run_id, principle_candidates.artifact_id references artifacts.artifact_id. Both with `ON DELETE CASCADE`. |
| ARTF-04 | Index | Indexes on artifacts(task_id), artifacts(run_id), artifacts(artifact_kind), principle_candidates(status), principle_candidates(source_run_id). All idempotent. |
| ARTF-05 | resultRef | Define canonical resultRef URI scheme: `commit://<commitId>` for task.resultRef. One commit can associate multiple artifacts and candidates. Task.resultRef points to commit, not individual artifact. |

### 2.2 DiagnosticianCommitter (COMT)

Interface and implementation that commits diagnostician output to the artifact registry within a transaction.

| REQ-ID | Category | Requirement |
|--------|----------|-------------|
| COMT-01 | Interface | `DiagnosticianCommitter` interface with `commit(input: CommitInput): Promise<CommitResult>`. Runner depends on this interface, not implementation details. |
| COMT-02 | Transaction | Commit wraps artifact insertion + candidate extraction in a single SQLite transaction. Either both succeed or neither. |
| COMT-03 | Extraction | Commit extracts `DiagnosticianOutputV1.recommendations[]` where `kind === 'principle'` and registers each as a `principle_candidate` row. |
| COMT-04 | Idempotency | Re-committing the same run_id returns existing artifact_id without error. No duplicate candidates on retry. |
| COMT-05 | Failure | Commit failure sets task error to `artifact_commit_failed`. Task does NOT reach `succeeded` status if commit fails. |
| COMT-06 | Result | `CommitResult` returns `{ commitId, artifactId, candidateCount }` on success, `{ error, errorCategory }` on failure. |

### 2.3 Runner Integration (RUNR)

Wire DiagnosticianCommitter into DiagnosticianRunner succeedTask flow.

| REQ-ID | Category | Requirement |
|--------|----------|-------------|
| RUNR-01 | Ordering | Commit MUST happen before `markTaskSucceeded`. If commit fails, task is NOT marked succeeded. |
| RUNR-02 | Injection | `DiagnosticianCommitter` is injected via `DiagnosticianRunnerDeps`. Runner does not import committer implementation. |
| RUNR-03 | Failure | Commit failure triggers `handleCommitFailure`: marks task failed with `artifact_commit_failed`, emits telemetry, returns failed RunnerResult. |
| RUNR-04 | Result | On success, `task.resultRef` becomes `commit://<commitId>`. Commit record links to artifact and candidates. |
| RUNR-05 | Production path | Production M5 path MUST require committer before marking task succeeded. Runner may be constructed without committer ONLY in legacy/test compatibility mode with explicit opt-in flag. No silent fallback to "succeed without commit". |

### 2.4 CLI Visibility (CLIV)

CLI surface for inspecting artifacts and candidates. Fixed command shape — no drift.

| REQ-ID | Category | Requirement |
|--------|----------|-------------|
| CLIV-01 | List | `pd candidate list --task-id <taskId>` lists principle candidates for a task. Returns structured result. |
| CLIV-02 | Show | `pd candidate show <candidateId>` returns candidate detail (title, description, confidence, source, status). |
| CLIV-03 | Artifact | `pd artifact show <artifactId>` returns artifact content and associated candidates. |
| CLIV-04 | Status | `pd diagnose status --task-id <taskId> --json` extended to include commitId, artifactId, candidateCount for succeeded tasks. |
| CLIV-05 | Types | All CLI results are plain TypeScript types (library exports), no CLI framework dependency. JSON output must be usable for E2E test assertions. |

### 2.5 Telemetry (TELE)

Events for commit and candidate operations.

| REQ-ID | Category | Requirement |
|--------|----------|-------------|
| TELE-01 | Commit Success | Emit `diagnostician_artifact_committed` event with `{ commitId, artifactId, candidateCount, taskId, runId }`. |
| TELE-02 | Commit Failure | Emit `diagnostician_artifact_commit_failed` event with `{ taskId, runId, errorCategory, errorMessage }`. |
| TELE-03 | Candidate Registered | Emit `principle_candidate_registered` event with `{ candidateId, kind, description, sourceRunId }`. |
| TELE-04 | Event Infrastructure | All events use M2 `StoreEventEmitter.emitTelemetry()` and conform to `TelemetryEvent` schema. |
| TELE-05 | Runner Phase | New `RunnerPhase.Committing` added between `Validating` and `Completed`. Runner exposes `currentPhase` for observability. |

### 2.6 E2E Verification (E2EV)

End-to-end tests with hard gate criteria.

| REQ-ID | Category | Requirement |
|--------|----------|-------------|
| E2EV-01 | Happy Path | Full chain: task → run → output → artifact → candidate → resultRef. Verify `commit://<commitId>` in resultRef. |
| E2EV-02 | Idempotency | Same task/run committed twice → no duplicate candidates, same commitId returned. |
| E2EV-03 | Failure | Commit fails mid-transaction → task NOT succeeded, no candidates exist, error is `artifact_commit_failed`. |
| E2EV-04 | Traceability | From any task: `task.resultRef → commit → artifact → candidates` fully traversable. `pd candidate list --task-id` shows candidates. No broken links. |

## 3. Non-Goals (OUT of Scope)

1. **Principle promotion** — candidates are registered but not promoted to active principles. Future milestone.
2. **Active injection** — candidates are not injected into agent prompts. Future scope.
3. **Multi-runtime** — only TestDoubleRuntimeAdapter is used. Production adapter is M6+.
4. **Plugin demotion** — M6 scope.
5. **Candidate consumption** — M5 registers candidates; downstream consumer is future scope.
6. **PrincipleTreeLedger integration** — Ledger is adapter/bridge, not part of atomic transaction.
7. **M3/M4 finding rework** — M3/M4 findings already merged. M5 only confirms no regression.

## 4. Exit Criteria

M5 is minimally complete when:

1. Every succeeded diagnostician task has a committed artifact in `state.db`
2. Principle candidates from recommendations are registered in `state.db`
3. Commit and candidate registration are atomic (single SQLite transaction)
4. Commit failure prevents task from reaching succeeded status
5. CLI can list candidates and show artifact details via fixed commands
6. Telemetry events cover all commit and candidate operations
7. E2E test verifies: idempotency, failure path, full traceability, `pd candidate list` visibility
8. Test coverage >= 80% for new code
9. No "task succeeded but candidate missing" state is possible
10. resultRef format is `commit://<commitId>`, not `run://` or `artifact://`

## 5. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Transaction boundary too wide (artifact + candidate + task state) | HIGH | Keep task state mutation outside commit transaction; commit only touches artifacts + candidates |
| Candidate extraction logic brittle | MEDIUM | Strict extraction: only kind=principle recommendations become candidates |
| Idempotency edge case on partial write | HIGH | Use run_id as unique constraint; transaction rollback on any insert failure |
| Breaking M4 backward compatibility | HIGH | Legacy/test mode requires explicit opt-in; production path mandates committer |
| Schema migration conflicts with M2/M3 tables | LOW | All new tables; no ALTER on existing tasks/runs tables |
| resultRef format ambiguity | MEDIUM | Define upfront: `commit://<commitId>` as canonical; commit record links to artifacts/candidates |

## 6. Execution Constraints

1. **Atomic commit truth lives in SQLite state.db ONLY** — PrincipleTreeLedger is adapter/bridge, not part of atomic transaction
2. **Runner only depends on Committer interface** — does NOT know about artifact/candidate tables or ledger paths
3. **Task succeeded MUST happen after commit success** — commit failure = artifact_commit_failed
4. **Cannot produce "task succeeded but candidate missing" state** — transactional guarantee
5. **E2E verification is a hard gate** — task→run→output→artifact→candidate→resultRef full traceability
6. **No principle promotion, no active injection, no multi-runtime, no plugin demotion**
7. **Production M5 path MUST require committer** — no silent fallback to "succeed without commit"
8. **CLI commands are fixed** — `pd candidate list/show`, `pd artifact show`, `pd diagnose status --json`
9. **resultRef format: `commit://<commitId>`** — commit record links to artifacts and candidates

## 7. Dependencies

### Code Dependencies (M1-M4 Baseline)

| Location | Purpose | Milestone |
|----------|---------|-----------|
| `runtime-v2/diagnostician-output.ts` | DiagnosticianOutputV1 with recommendations[] | M1 |
| `runtime-v2/runner/diagnostician-runner.ts` | DiagnosticianRunner, succeedTask(), RunnerDeps | M4 |
| `runtime-v2/runner/runner-phase.ts` | RunnerPhase enum | M4 |
| `runtime-v2/runner/runner-result.ts` | RunnerResult type | M4 |
| `runtime-v2/store/sqlite-connection.ts` | SqliteConnection, initSchema() | M2 |
| `runtime-v2/store/event-emitter.ts` | StoreEventEmitter, emitTelemetry() | M2 |
| `runtime-v2/cli/diagnose.ts` | CLI surface (run, status) | M4 |
| `runtime-v2/adapter/test-double-runtime-adapter.ts` | TestDoubleRuntimeAdapter | M4 |

### Canonical Documents

| Document | Path | Relevance |
|----------|------|-----------|
| Milestone Roadmap | `docs/pd-runtime-v2/runtime-v2-milestone-roadmap.md` | Section M5 definition |
| Diagnostician v2 Design | `docs/spec/2026-04-21-diagnostician-v2-detailed-design.md` | Section 15 (Commit Flow) |
| Protocol Spec v1 | `docs/spec/2026-04-21-pd-runtime-protocol-spec-v1.md` | Section 19 (Artifact Commit) |

## 8. Suggested Phase Decomposition

### m5-01: Artifact Registry Schema
SQL schema, migration, table creation, indexes, idempotency, resultRef URI scheme definition.

### m5-02: DiagnosticianCommitter Core
Committer interface, commit logic, transaction safety, candidate extraction, failure handling.

### m5-03: Runner Integration
Runner calls committer in succeedTask(), ordering guarantee, failure handling, production path mandates committer.

### m5-04: CLI + Telemetry
Fixed CLI commands (`pd candidate list/show`, `pd artifact show`, `pd diagnose status --json`), commit/candidate telemetry events, RunnerPhase.Committing.

### m5-05: E2E Verification
Full chain tests with hard gates: idempotency, failure path, traceability, `pd candidate list` visibility.

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| ARTF-01 | m5-01 | Pending |
| ARTF-02 | m5-01 | Pending |
| ARTF-03 | m5-01 | Pending |
| ARTF-04 | m5-01 | Pending |
| ARTF-05 | m5-01 | Pending |
| COMT-01 | m5-02 | Pending |
| COMT-02 | m5-02 | Pending |
| COMT-03 | m5-02 | Pending |
| COMT-04 | m5-02 | Pending |
| COMT-05 | m5-02 | Pending |
| COMT-06 | m5-02 | Pending |
| RUNR-01 | m5-03 | Pending |
| RUNR-02 | m5-03 | Pending |
| RUNR-03 | m5-03 | Pending |
| RUNR-04 | m5-03 | Pending |
| RUNR-05 | m5-03 | Pending |
| CLIV-01 | m5-04 | Pending |
| CLIV-02 | m5-04 | Pending |
| CLIV-03 | m5-04 | Pending |
| CLIV-04 | m5-04 | Pending |
| CLIV-05 | m5-04 | Pending |
| TELE-01 | m5-04 | Pending |
| TELE-02 | m5-04 | Pending |
| TELE-03 | m5-04 | Pending |
| TELE-04 | m5-04 | Pending |
| TELE-05 | m5-04 | Pending |
| E2EV-01 | m5-05 | Pending |
| E2EV-02 | m5-05 | Pending |
| E2EV-03 | m5-05 | Pending |
| E2EV-04 | m5-05 | Pending |

**Coverage:**
- v2.4 requirements: 30 total
- Mapped to phases: 30
- Unmapped: 0 ✓
