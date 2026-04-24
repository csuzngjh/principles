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

## Phases

- [ ] **Phase m5-01: Artifact Registry Schema** — SQL schema, migration, tables, indexes, idempotent creation
- [ ] **Phase m5-02: DiagnosticianCommitter Core** — Interface, commit logic, transaction safety, candidate extraction, failure handling
- [ ] **Phase m5-03: Runner Integration** — Runner calls committer, ordering guarantee, failure path, backward compatibility
- [ ] **Phase m5-04: CLI + Telemetry** — Candidate list/show, extended status, commit/candidate events, RunnerPhase.Committing
- [ ] **Phase m5-05: E2E Verification** — Full chain tests, idempotency, failure scenarios, traceability

## Phase Details

### Phase m5-01: Artifact Registry Schema
**Goal**: New `artifacts` and `principle_candidates` tables exist in state.db with correct foreign keys and indexes, created idempotently
**Depends on**: M4 baseline (SqliteConnection with tasks/runs tables)
**Requirements**: ARTF-01, ARTF-02, ARTF-03, ARTF-04
**Success Criteria** (what must be TRUE):
  1. Opening a state.db creates `artifacts` and `principle_candidates` tables without error (idempotent on re-open)
  2. Foreign keys from artifacts.run_id to runs.run_id and principle_candidates.artifact_id to artifacts.artifact_id are enforced (CASCADE delete verified)
  3. All four indexes (artifacts.task_id, artifacts.run_id, artifacts.artifact_kind, principle_candidates.status, principle_candidates.source_run_id) exist and are queryable
  4. Existing M2/M3 data (tasks, runs tables) is unaffected by the migration
**Plans**: 1 plan

Plans:
- [ ] m5-01-01-PLAN.md — Add artifacts + principle_candidates DDL to initSchema(), create artifact-schema.test.ts

### Phase m5-02: DiagnosticianCommitter Core
**Goal**: Committer commits diagnostician output as an artifact and extracts principle candidates atomically
**Depends on**: Phase m5-01 (tables exist)
**Requirements**: COMT-01, COMT-02, COMT-03, COMT-04, COMT-05, COMT-06
**Success Criteria** (what must be TRUE):
  1. Calling `committer.commit(input)` with valid DiagnosticianOutputV1 creates exactly one artifact row and one candidate row per `kind=principle` recommendation
  2. Artifact insertion and candidate extraction are wrapped in a single SQLite transaction — rollback on any failure leaves no partial rows
  3. Re-committing the same run_id returns the existing artifact_id with no duplicate candidates (idempotency)
  4. Commit failure returns `CommitResult` with `errorCategory` and does not leave orphaned rows
  5. `CommitResult` provides `{ artifactId, candidateCount }` on success for downstream consumption
**Plans**: TBD

### Phase m5-03: Runner Integration
**Goal**: DiagnosticianRunner commits artifacts before marking tasks succeeded, with full failure handling
**Depends on**: Phase m5-02 (committer interface and implementation)
**Requirements**: RUNR-01, RUNR-02, RUNR-03, RUNR-04, RUNR-05
**Success Criteria** (what must be TRUE):
  1. A succeeded task always has a committed artifact — resultRef is `artifact://{artifactId}`, not `run://{runId}`
  2. Commit failure prevents task from reaching `succeeded` status — task lands in `failed` with `artifact_commit_failed` error category
  3. Runner constructed without committer (undefined in deps) preserves M4 behavior — task succeeds with `run://` resultRef, no commit attempted
  4. Committing phase is observable via `RunnerPhase.Committing` between validating and completed
**Plans**: TBD

### Phase m5-04: CLI + Telemetry
**Goal**: Operators can inspect artifacts and candidates via CLI, and all commit/candidate operations emit telemetry
**Depends on**: Phase m5-03 (runner integration complete)
**Requirements**: CLIV-01, CLIV-02, CLIV-03, CLIV-04, TELE-01, TELE-02, TELE-03, TELE-04, TELE-05
**Success Criteria** (what must be TRUE):
  1. `pd diagnose candidates --task-id <id>` returns a list of principle candidates associated with that task's artifacts
  2. `pd diagnose artifact --artifact-id <id>` returns the artifact content and its associated candidates
  3. `pd diagnose status --task-id <id>` includes artifactId and candidateCount for succeeded tasks
  4. Telemetry events `diagnostician_artifact_committed`, `diagnostician_artifact_commit_failed`, and `principle_candidate_registered` are emitted at the correct lifecycle points
  5. All CLI functions return plain TypeScript types with no CLI framework dependency
**Plans**: TBD
**UI hint**: yes

### Phase m5-05: E2E Verification
**Goal**: Full traceability chain verified end-to-end: task -> run -> artifact -> candidate -> resultRef
**Depends on**: Phase m5-04 (all layers complete)
**Requirements**: E2EV-01, E2EV-02, E2EV-03, E2EV-04
**Success Criteria** (what must be TRUE):
  1. Happy path: task created through runner execution produces a committed artifact with principle candidates, and resultRef resolves to the artifact
  2. Failure path: commit failure leaves task in failed state with no artifacts or candidates, and the error is recoverable
  3. Idempotency: running the same task twice produces one artifact with no duplicate candidates
  4. Traceability: from any task, the full chain (task -> runs -> artifact -> candidates) is traversable with no broken links
**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: m5-01 -> m5-02 -> m5-03 -> m5-04 -> m5-05

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| m5-01. Artifact Registry Schema | 0/1 | Planned | - |
| m5-02. DiagnosticianCommitter Core | 0/? | Not started | - |
| m5-03. Runner Integration | 0/? | Not started | - |
| m5-04. CLI + Telemetry | 0/? | Not started | - |
| m5-05. E2E Verification | 0/? | Not started | - |

## Requirements Traceability

| REQ-ID | Requirement | Phase | Status |
|--------|-------------|-------|--------|
| ARTF-01 | artifacts table schema | m5-01 | Pending |
| ARTF-02 | principle_candidates table schema | m5-01 | Pending |
| ARTF-03 | Foreign keys with CASCADE | m5-01 | Pending |
| ARTF-04 | Indexes on artifacts and candidates | m5-01 | Pending |
| COMT-01 | DiagnosticianCommitter interface | m5-02 | Pending |
| COMT-02 | Transaction-wrapped commit | m5-02 | Pending |
| COMT-03 | Principle candidate extraction | m5-02 | Pending |
| COMT-04 | Idempotent re-commit | m5-02 | Pending |
| COMT-05 | Commit failure handling | m5-02 | Pending |
| COMT-06 | CommitResult type | m5-02 | Pending |
| RUNR-01 | Commit before succeed | m5-03 | Pending |
| RUNR-02 | Committer injection via deps | m5-03 | Pending |
| RUNR-03 | Commit failure path | m5-03 | Pending |
| RUNR-04 | resultRef becomes artifact:// | m5-03 | Pending |
| RUNR-05 | Backward compatibility without committer | m5-03 | Pending |
| CLIV-01 | Candidate list CLI | m5-04 | Pending |
| CLIV-02 | Artifact show CLI | m5-04 | Pending |
| CLIV-03 | Extended status with artifact info | m5-04 | Pending |
| CLIV-04 | Plain TypeScript types | m5-04 | Pending |
| TELE-01 | artifact_committed event | m5-04 | Pending |
| TELE-02 | artifact_commit_failed event | m5-04 | Pending |
| TELE-03 | candidate_registered event | m5-04 | Pending |
| TELE-04 | Event infrastructure reuse | m5-04 | Pending |
| TELE-05 | RunnerPhase.Committing | m5-04 | Pending |
| E2EV-01 | Happy path E2E test | m5-05 | Pending |
| E2EV-02 | Commit failure E2E test | m5-05 | Pending |
| E2EV-03 | Idempotency E2E test | m5-05 | Pending |
| E2EV-04 | Full traceability E2E test | m5-05 | Pending |
