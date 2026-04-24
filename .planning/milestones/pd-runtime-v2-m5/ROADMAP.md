# M5: Unified Commit + Principle Candidate Intake — Roadmap

> Status: Active
> Date: 2026-04-24
> Milestone: v2.4
> Phase numbering: m5-01 through m5-05 (continuing from M4)

## Boundary Constraints (M5)

- Atomic commit truth lives in SQLite `.pd/state.db` ONLY
- Runner only depends on Committer interface, does NOT know about artifact/candidate tables
- Task succeeded MUST happen after commit success; commit failure = `artifact_commit_failed`
- Cannot produce "task succeeded but candidate missing" state
- E2E verification is a hard gate: task -> run -> output -> artifact -> candidate -> resultRef full traceability
- No principle promotion, no active injection, no multi-runtime, no plugin demotion
- Production M5 path MUST require committer — no silent fallback
- CLI commands are fixed: `pd candidate list/show`, `pd artifact show`, `pd diagnose status --json`
- resultRef format: `commit://<commitId>` — commit record links to artifacts and candidates

## Phases

- [ ] **Phase m5-01: Artifact Registry Schema** — SQL schema, migration, tables, indexes, resultRef URI scheme
- [ ] **Phase m5-02: DiagnosticianCommitter Core** — Interface, commit logic, transaction safety, candidate extraction, failure handling
- [ ] **Phase m5-03: Runner Integration** — Runner calls committer, ordering guarantee, production path mandates committer, failure path
- [ ] **Phase m5-04: CLI + Telemetry** — Fixed CLI commands, commit/candidate events, RunnerPhase.Committing
- [ ] **Phase m5-05: E2E Verification** — Hard gate: idempotency, failure path, traceability, candidate list visibility

## Phase Details

### Phase m5-01: Artifact Registry Schema
**Goal**: New `artifacts` and `principle_candidates` tables in state.db with FK, indexes, and resultRef URI scheme
**Depends on**: M4 baseline (SqliteConnection with tasks/runs tables)
**Requirements**: ARTF-01, ARTF-02, ARTF-03, ARTF-04, ARTF-05
**Success Criteria** (what must be TRUE):
  1. Opening a state.db creates `artifacts` and `principle_candidates` tables without error (idempotent on re-open)
  2. Foreign keys enforced with CASCADE delete verified (artifacts.run_id → runs.run_id, candidates.artifact_id → artifacts.artifact_id)
  3. All indexes queryable (artifacts.task_id, artifacts.run_id, artifacts.artifact_kind, candidates.status, candidates.source_run_id)
  4. Existing M2/M3 data (tasks, runs tables) unaffected by migration
  5. resultRef URI scheme defined: `commit://<commitId>` — commit record associates artifact + candidates
**Plans**: TBD

### Phase m5-02: DiagnosticianCommitter Core
**Goal**: Committer commits diagnostician output as artifact and extracts principle candidates atomically
**Depends on**: Phase m5-01 (tables exist)
**Requirements**: COMT-01, COMT-02, COMT-03, COMT-04, COMT-05, COMT-06
**Success Criteria** (what must be TRUE):
  1. `committer.commit(input)` with valid output creates one artifact row + one candidate per `kind=principle` recommendation
  2. Artifact + candidates in single SQLite transaction — rollback on failure leaves no partial rows
  3. Re-commit same run_id returns existing commitId, no duplicate candidates (idempotency)
  4. Commit failure returns `CommitResult` with errorCategory, no orphaned rows
  5. `CommitResult` provides `{ commitId, artifactId, candidateCount }` on success
**Plans**: TBD

### Phase m5-03: Runner Integration
**Goal**: DiagnosticianRunner commits before succeed, production path mandates committer
**Depends on**: Phase m5-02 (committer interface and implementation)
**Requirements**: RUNR-01, RUNR-02, RUNR-03, RUNR-04, RUNR-05
**Success Criteria** (what must be TRUE):
  1. Succeeded task has `task.resultRef = "commit://<commitId>"` with committed artifact + candidates
  2. Commit failure prevents succeeded status — task lands in appropriate state with `artifact_commit_failed`
  3. Production M5 path requires committer in deps; no committer = explicit legacy/test mode with opt-in flag
  4. Committing phase observable via `RunnerPhase.Committing` between Validating and Completed
**Plans**: TBD

### Phase m5-04: CLI + Telemetry
**Goal**: Operators can inspect artifacts and candidates via fixed CLI commands, commit operations emit telemetry
**Depends on**: Phase m5-03 (runner integration complete)
**Requirements**: CLIV-01, CLIV-02, CLIV-03, CLIV-04, CLIV-05, TELE-01, TELE-02, TELE-03, TELE-04, TELE-05
**Fixed CLI Commands**:
  - `pd candidate list --task-id <taskId>` — list candidates for a task
  - `pd candidate show <candidateId>` — show candidate detail
  - `pd artifact show <artifactId>` — show artifact content + associated candidates
  - `pd diagnose status --task-id <taskId> --json` — extended with commitId, artifactId, candidateCount
**Success Criteria** (what must be TRUE):
  1. `pd candidate list --task-id <id>` returns candidates for that task's artifacts
  2. `pd candidate show <candidateId>` returns title, description, confidence, source, status
  3. `pd diagnose status --task-id <id> --json` includes commitId, artifactId, candidateCount
  4. Telemetry events emitted at correct lifecycle points: `diagnostician_artifact_committed`, `diagnostician_artifact_commit_failed`, `principle_candidate_registered`
  5. All CLI returns are plain TypeScript types, no CLI framework dependency. JSON usable for E2E assertions.
**Plans**: TBD

### Phase m5-05: E2E Verification
**Goal**: Hard gate — full traceability chain verified with idempotency, failure, and CLI visibility
**Depends on**: Phase m5-04 (all layers complete)
**Requirements**: E2EV-01, E2EV-02, E2EV-03, E2EV-04
**Hard Gate Criteria**:
  1. **Happy path**: task → run → output → artifact → candidate → resultRef (`commit://<commitId>`). Full chain traversable.
  2. **Idempotency**: same task/run committed twice → one artifact, no duplicate candidates, same commitId
  3. **Failure**: commit fails mid-transaction → task NOT succeeded, no candidates exist, error is `artifact_commit_failed`
  4. **CLI visibility**: `pd candidate list --task-id <id>` shows candidates; `task.resultRef` resolves to commit → artifact → candidates
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: m5-01 -> m5-02 -> m5-03 -> m5-04 -> m5-05

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| m5-01. Artifact Registry Schema | 1/1 | Complete | 2026-04-24 |
| m5-02. DiagnosticianCommitter Core | 1/1 | Complete | 2026-04-24 |
| m5-03. Runner Integration | 1/1 | Complete | 2026-04-24 |
| m5-04. CLI + Telemetry | 3/3 | Complete | 2026-04-24 |
| m5-05. E2E Verification | 0/? | Not started | - |

## Requirements Traceability

| REQ-ID | Requirement | Phase | Status |
|--------|-------------|-------|--------|
| ARTF-01 | artifacts table schema | m5-01 | Complete |
| ARTF-02 | principle_candidates table schema | m5-01 | Complete |
| ARTF-03 | Foreign keys with CASCADE | m5-01 | Complete |
| ARTF-04 | Indexes on artifacts and candidates | m5-01 | Complete |
| ARTF-05 | resultRef URI scheme (commit://) | m5-01 | Complete |
| COMT-01 | DiagnosticianCommitter interface | m5-02 | Pending |
| COMT-02 | Transaction-wrapped commit | m5-02 | Pending |
| COMT-03 | Principle candidate extraction | m5-02 | Pending |
| COMT-04 | Idempotent re-commit | m5-02 | Pending |
| COMT-05 | Commit failure handling | m5-02 | Pending |
| COMT-06 | CommitResult type with commitId | m5-02 | Complete |
| RUNR-01 | Commit before succeed | m5-03 | Complete |
| RUNR-02 | Committer injection via deps | m5-03 | Complete |
| RUNR-03 | Commit failure path | m5-03 | Complete |
| RUNR-04 | resultRef becomes commit:// | m5-03 | Complete |
| RUNR-05 | Production path mandates committer | m5-03 | Complete |
| CLIV-01 | pd candidate list | m5-04 | Complete |
| CLIV-02 | pd candidate show | m5-04 | Complete |
| CLIV-03 | pd artifact show | m5-04 | Complete |
| CLIV-04 | pd diagnose status --json extended | m5-04 | Complete |
| CLIV-05 | Plain TypeScript types | m5-04 | Complete |
| TELE-01 | artifact_committed event | m5-04 | Complete |
| TELE-02 | artifact_commit_failed event | m5-04 | Complete |
| TELE-03 | candidate_registered event | m5-04 | Complete |
| TELE-04 | Event infrastructure reuse | m5-04 | Complete |
| TELE-05 | RunnerPhase.Committing | m5-04 | Complete |
| E2EV-01 | Happy path E2E | m5-05 | Pending |
| E2EV-02 | Idempotency E2E | m5-05 | Pending |
| E2EV-03 | Commit failure E2E | m5-05 | Pending |
| E2EV-04 | Full traceability + CLI E2E | m5-05 | Pending |
