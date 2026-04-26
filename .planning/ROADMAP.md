# Roadmap: v2.6 M7 -- Principle Candidate Intake

## Context

M6 shipped the full OpenClaw CLI pipeline:
`task -> run(openclaw-cli) -> DiagnosticianOutputV1 -> commit -> artifact -> principle_candidate(status=pending)`

The pipeline ends at `principle_candidates.status=pending`. M7's job is to consume pending
candidates and make them visible/consumable via `pd candidate intake`, turning them into
principle ledger entries -- without triggering pain signals, deleting legacy paths, or
resurrecting heartbeat/cron/subagent.

## Phases

- [x] **Phase m6-01: CliProcessRunner + RuntimeKind Extension** -- SHIPPED
- [x] **Phase m6-02: OpenClawCliRuntimeAdapter Core** -- SHIPPED
- [x] **Phase m6-03: DiagnosticianPromptBuilder + Workspace Boundary** -- SHIPPED
- [x] **Phase m6-04: PD CLI Extension + Error Mapping** -- SHIPPED
- [x] **Phase m6-05: Telemetry Events** -- SHIPPED
- [x] **Phase m6-06: E2E Verification** -- SHIPPED
- [x] **Phase m7-01: Candidate Intake Contract** -- Interface + schema for intake workflow (SHIPPED)
- [x] **Phase m7-02: PrincipleTreeLedger Adapter** -- LedgerAdapter implementation with field expansion + idempotency (SHIPPED 2026-04-26)
- [x] **Phase m7-03: Intake Service + Idempotency** -- Core service with deduplication (SHIPPED 2026-04-26)
	- [x] m7-03-01-PLAN.md -- CandidateIntakeService class: consume pending candidates, write via adapter, idempotency
	- [x] m7-03-02-PLAN.md -- CandidateIntakeService tests: happy path, deduplication, error handling
- [ ] **Phase m7-04: CLI: `pd candidate intake`** -- `pd candidate intake --candidate-id <id> --workspace <path> --json`
	- [ ] m7-04-01-PLAN.md -- CLI handler: parse args, call service, format output
- [ ] **Phase m7-05: E2E: candidate -> ledger entry** -- Full traceability + idempotency verification
	- [ ] m7-05-01-PLAN.md -- E2E test: full flow from candidate pending to ledger entry

---

## Phase Details

### Phase m7-01: Candidate Intake Contract (SHIPPED)

**Goal**: Define the intake boundary -- what a candidate is, what the committer wrote, what the ledger needs.

**Depends on**: M6 (principle_candidates table exists)

**Requirements**: INTAKE-01, INTAKE-02, INTAKE-03, INTAKE-04, LEDGER-01

**Success Criteria** (what must be TRUE):
1. `CandidateIntakeInput` schema captures: candidateId, workspaceDir (D-01: DB is single source of truth -- candidate data loaded by RuntimeStateManager)
2. `CandidateIntakeOutput` schema captures: candidateId, artifactId, ledgerRef, status='consumed'
3. Intake input does NOT accept arbitrary ledger entries -- it maps committer output to ledger contract
4. Ledger entry is a probation principle entry (status=probation, evaluability=weak_heuristic, 9 fields per D-03)
5. `CandidateIntakeError` class defines 5 error codes per D-12

See CONTEXT.md for authoritative success criteria. ROADMAP updated 2026-04-26 to reflect D-01 decision.

**Plans**: 2 plans

Plans:
- [x] m7-01-01-PLAN.md -- CandidateIntakeInput/Output schemas, error class, LedgerAdapter interface, tests (INTAKE-01~04)
- [x] m7-01-02-PLAN.md -- Ledger entry contract documentation, field provenance, default values, LEDGER-01 tests

---

### Phase m7-02: PrincipleTreeLedger Adapter

**Goal**: Implement `LedgerAdapter` interface as `PrincipleTreeLedgerAdapter` class that bridges 11-field `LedgerPrincipleEntry` to 18+ field `LedgerPrinciple`, writes to file-based ledger via `addPrincipleToLedger()`, and maintains in-memory `Map<candidateId, LedgerPrincipleEntry>` for idempotency.

**Depends on**: m7-01

**Requirements**: LEDGER-01, LEDGER-02, LEDGER-03

**Success Criteria** (what must be TRUE):
1. `PrincipleTreeLedgerAdapter` implements `LedgerAdapter` with `writeProbationEntry()` and `existsForCandidate()`
2. Field expansion: 11-field entry -> 18+ field LedgerPrinciple with correct defaults (status 'probation'->'candidate', version:1, priority:'P1', scope:'general', etc.)
3. UUID v4 from entry.id used directly as LedgerPrinciple.id (Decision A)
4. triggerPattern/action pass through as-is from entry (Decision B); adapter does NOT parse sourceRecommendationJson
5. sourceRef, artifactRef, taskRef are NOT written to the ledger file (Decision C, Q3 resolved)
6. `existsForCandidate()` uses in-memory Map for O(1) lookup (Decision D)
7. `writeProbationEntry()` is idempotent -- second call with same candidateId returns existing entry from Map
8. `derivedFromPainIds` populated with `[candidateId]` (Q1 resolved)
9. Write failures throw `CandidateIntakeError` with `LEDGER_WRITE_FAILED` code
10. Adapter constructor accepts `{ stateDir: string }` options object (DI pattern)

**Plans**: 2 plans

Plans:
- [ ] m7-02-01-PLAN.md -- PrincipleTreeLedgerAdapter class: constructor, writeProbationEntry, existsForCandidate, field expansion, idempotency
- [ ] m7-02-02-PLAN.md -- Comprehensive tests: happy path, idempotency, field expansion defaults, provenance exclusion, error handling, instance isolation

---

### Phase m7-03: Intake Service + Idempotency

**Goal**: `CandidateIntakeService` that consumes pending candidates with deduplication.

**Depends on**: m7-01, m7-02

**Requirements**: INTAKE-05, INTAKE-06, INTAKE-07

**Success Criteria** (what must be TRUE):
1. `CandidateIntakeService.intake(candidateId)` transitions candidate: `pending` -> `consumed`
2. Same candidate ID intake twice: second call is no-op, returns existing ledger entry
3. Intake failure (invalid candidate, ledger write error): candidate stays `pending`, error returned
4. Candidate without artifact: rejected with descriptive error
5. All CLI-facing functions return plain TypeScript types, no CLI framework dependency

**Plans**: 2 plans

Plans:
 - [x] m7-03-01-PLAN.md -- CandidateIntakeService implementation + idempotency logic
 - [x] m7-03-02-PLAN.md -- Intake service unit tests (happy path, double-intake, failure)

---

### Phase m7-04: CLI: `pd candidate intake`

**Goal**: `pd candidate intake --candidate-id <id> --workspace <path> --json` command.

**Depends on**: m7-03

**Requirements**: CLI-INTAKE-01, CLI-INTAKE-02, CLI-INTAKE-03

**Success Criteria** (what must be TRUE):
1. `pd candidate intake --candidate-id <id> --workspace <path> --json` succeeds
2. Output is machine-readable JSON: `{ candidateId, status, ledgerEntryId }`
3. `pd candidate intake --candidate-id <id> --workspace <path> --json --dry-run` returns what would be written without writing
4. Intaking non-existent candidate: error with descriptive message (no crash)

**Plans**: 2 plans

Plans:
- [ ] m7-04-01-PLAN.md -- `pd candidate intake` CLI command + dry-run
- [ ] m7-04-02-PLAN.md -- Intake CLI integration tests

---

### Phase m7-05: E2E: candidate -> ledger entry

**Goal**: Full traceability from pending candidate to ledger entry with idempotency verified.

**Depends on**: m7-04

**Requirements**: E2E-INTAKE-01, E2E-INTAKE-02, E2E-INTAKE-03, E2E-INTAKE-04

**Success Criteria** (what must be TRUE):
1. Happy path: pending candidate -> intake -> consumed -> ledger entry visible
2. `pd candidate list --task-id <taskId>` shows candidate with correct status after intake
3. Idempotency: intake same candidate twice -> one ledger entry, no duplicate
4. Traceability: `pd candidate show <id>` shows ledger entry link (E2E-INTAKE-04)
5. Tests + build green

**Plans**: 1 plan

Plans:
- [ ] m7-05-01-PLAN.md -- E2E tests: happy path, idempotency, traceability, CLI show

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| m6-01: CliProcessRunner + RuntimeKind | 2/2 | Complete | 2026-04-25 |
| m6-02: OpenClawCliRuntimeAdapter Core | 3/3 | Complete | 2026-04-25 |
| m6-03: DiagnosticianPromptBuilder + Workspace | 7/7 | Complete | 2026-04-25 |
| m6-04: PD CLI Extension + Error Mapping | 3/3 | Complete | 2026-04-25 |
| m6-05: Telemetry Events | 3/3 | Complete | 2026-04-25 |
| m6-06: E2E Verification | 2/3 | Complete | 2026-04-25 |
| m7-01: Candidate Intake Contract | 2/2 | SHIPPED | 2026-04-26 |
| m7-02: PrincipleTreeLedger Adapter | 0/2 | Planned | -- |
| m7-03: Intake Service + Idempotency | 0/2 | Planning | -- |
| m7-04: CLI: pd candidate intake | 0/2 | Planning | -- |
| m7-05: E2E: candidate -> ledger entry | 0/1 | Planning | -- |

---

## Backlog: Future Milestones

### v2.7 M8 -- Pain Signal -> Diagnostician Bridge

**Goal**: Trigger runtime-v2 task intake from pain signals (without heartbeat/cron/subagent).

**Depends on**: M7

**Non-goals**: No legacy deletion, no principle promotion.

**Canonical source:** `packages/principles-core/src/runtime-v2/`

**Plans**: TBD

---

### v2.8 M9 -- Legacy Path Decommission

**Goal**: Retire legacy evolution-worker, heartbeat injection, cron-based diagnostician.

**Depends on**: M7, M8

**Constraints**: Zero regressions in active principle injection; legacy path removal only after M8 verifies pain->candidate bridge.

**Non-goals**: No breaking changes to active principle lifecycle.

**Plans**: TBD

---

## Hard Gates (HG-1 ~ HG-6) -- M6

| ID | Description | Status |
|----|-------------|--------|
| HG-1 | `pd runtime probe --runtime openclaw-cli` must deliver | PASS |
| HG-2 | OpenClaw CLI no `--workspace`; two workspace boundaries explicitly controlled | PASS |
| HG-3 | `--openclaw-local`/`--openclaw-gateway` must be explicit; no silent fallback | PASS |
| HG-4 | CliOutput.text -> DiagnosticianOutputV1 parse + validate | PASS |
| HG-5 | Real `D:\.openclaw\workspace` verification | PASS |
| HG-6 | Non-goals respected (no heartbeat/prompt hook/sessions_spawn/marker file/plugin API) | PASS |

---

## M7 Success Criteria

1. `pd candidate list --task-id <taskId>` shows pending candidate.
2. `pd candidate intake --candidate-id <id> --workspace <path> --json` succeeds.
3. Candidate status changes from pending -> consumed.
4. Principle ledger/read model contains a new traceable candidate/probation principle.
5. Running intake twice is idempotent and does not duplicate the principle.
6. CLI can show candidate -> artifact -> task/run -> principle ledger reference.
7. Tests + build pass.

## M7 Explicit Non-Goals

- No pain signal bridge in M7.
- No legacy path deletion in M7.
- No heartbeat/cron/subagent resurrection.
- No OpenClaw adapter changes unless M6 regression is discovered.
- No direct promotion to active principle.

---

_Last updated: 2026-04-26 after m7-02 planning_
