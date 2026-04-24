# Phase m5-05: E2E Verification - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** Hard gate — full traceability chain verified with idempotency, failure, and CLI visibility

m5-05 E2E Verification is the final phase of M5. It runs end-to-end tests against real SQLite stores to verify all layers (m5-01 schema, m5-02 committer, m5-03 runner integration, m5-04 CLI + telemetry) work together correctly. All 4 E2E criteria (E2EV-01 through E2EV-04) must pass for M5 to be considered complete.

**E2EV-01 Happy Path:** Full chain: task → run → output → artifact → candidate → resultRef (`commit://<commitId>`). Full chain traversable.
**E2EV-02 Idempotency:** Same task/run committed twice → one artifact, no duplicate candidates, same commitId.
**E2EV-03 Failure:** Commit fails mid-transaction → task NOT succeeded, no candidates exist, error is `artifact_commit_failed`.
**E2EV-04 Traceability:** `task.resultRef → commit → artifact → candidates` fully traversable. `pd candidate list --task-id <id>` shows candidates. No broken links.

</domain>

<decisions>
## Implementation Decisions

### Test Architecture
- **D-01:** Based on m4-06 dual-track-e2e.test.ts pattern: real RuntimeStateManager + in-memory SQLite per test, TestDoubleRuntimeAdapter for runtime. Shares setup helpers (makeDiagnosticianOutput, makeDiagnosticianTaskInput, StubRuntimeAdapter, etc.) from dual-track-e2e.test.ts.
- **D-02:** Scenario-based structure: one `describe('E2E m5-05')` block with nested `describe('Scenario N: Name')` blocks for each E2E criterion. Each scenario is independently runnable.
- **D-03:** Test file: `packages/principles-core/src/runtime-v2/runner/__tests__/m5-05-e2e.test.ts` (new file, not merged into dual-track-e2e.test.ts to keep phase boundaries clean).

### E2EV-01: Happy Path
- **D-04:** Use real DiagnosticianCommitter implementation (not mock) so the full artifact + candidate creation pipeline runs. The committer is constructed with the same SqliteConnection used by stateManager.
- **D-05:** Assert `task.resultRef.startsWith('commit://')` and the referenced commit exists in DB.
- **D-06:** Assert artifact row in `artifacts` table with correct `run_id`, `task_id`, `artifact_kind='diagnostician_output'`.
- **D-07:** Assert candidate rows in `principle_candidates` table for each `kind='principle'` recommendation in output.

### E2EV-02: Idempotency
- **D-08:** Call `runner.run(taskId)` twice on same task (simulating retry after first succeeded). Verify only one artifact row and one candidate per kind=principle recommendation exists.
- **D-09:** Second call should return same `commitId` in resultRef (idempotencyKey: `${taskId}:${runId}`).

### E2EV-03: Failure Path
- **D-10:** Inject a committer that throws an error (simulates DB constraint violation mid-transaction). Use a committer wrapper that calls the real committer but throws after artifact insert.
- **D-11:** Verify task.status is NOT 'succeeded' after commit failure.
- **D-12:** Verify no orphaned artifact or candidate rows exist after rollback.
- **D-13:** Verify error category is `artifact_commit_failed` (PDErrorCategory).

### E2EV-04: Traceability
- **D-14:** Use direct SQL queries against the in-memory SQLite DB to verify the full chain: `task.resultRef → artifacts → principle_candidates`.
- **D-15:** Query pattern: `SELECT * FROM artifacts WHERE artifact_id = ?` → verify linked `run_id` and `task_id`.
- **D-16:** Query pattern: `SELECT * FROM principle_candidates WHERE artifact_id = ?` → verify candidates exist and are linked.
- **D-17:** CLI visibility verified by asserting `pd candidate list --task-id <id>` returns non-empty candidate list (import and call the CLI function directly, not via child process).

### Test Isolation
- **D-18:** Each scenario gets its own temp directory + in-memory SQLite (per-test `beforeEach` setup).
- **D-19:** Tests run with `pollIntervalMs: 50` and `timeoutMs: 3000` for fast feedback.

### Coverage Target
- **D-20:** >= 80% coverage for new m5-05 test code. Existing m5-01 through m5-04 code is covered by their own tests.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Prior Phase Contexts
- `packages/principles-core/src/runtime-v2/runner/__tests__/dual-track-e2e.test.ts` — Existing E2E pattern with StubRuntimeAdapter, makeDiagnosticianOutput, makeDiagnosticianTaskInput helpers
- `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.integration.test.ts` — Integration test pattern with real RuntimeStateManager + temp dir setup
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — Runner with RunnerPhase.Committing, commit call in succeedTask(), resultRef = `commit://<commitId>`
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` — DiagnosticianCommitter interface and implementation (m5-02)
- `packages/principles-core/src/runtime-v2/cli/diagnose.ts` — CLI functions: candidateList(), candidateShow(), artifactShow() (m5-04)
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — stateManager.getTask(), getRunsByTask(), markTaskSucceeded() etc.
- `packages/principles-core/src/runtime-v2/store/sqlite-connection.ts` — SqliteConnection for direct SQL queries

### M5 Milestone Documents
- `.planning/milestones/pd-runtime-v2-m5/REQUIREMENTS.md` — E2EV-01 through E2EV-04 requirements (Section 2.6)
- `.planning/milestones/pd-runtime-v2-m5/ROADMAP.md` — Phase m5-05 description and hard gate criteria
- `.planning/STATE.md` — M5 phase progress, boundary constraints

### Prior Phase Outputs
- `.planning/phases/m5-04-CLITelemetry/m5-04-VERIFICATION.md` — m5-04 verified requirements (CLIV-01 through CLIV-05, TELE-01 through TELE-05)

### Existing Test Patterns
- `packages/principles-core/src/runtime-v2/runner/__tests__/diagnostician-runner.test.ts` — Unit test pattern with PassThroughValidator, mock committer
- `packages/principles-core/src/runtime-v2/store/sqlite-run-store.test.ts` — Direct SQL query pattern in tests

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `makeDiagnosticianOutput(taskId)` — creates DiagnosticianOutputV1 with recommendations (can add kind='principle' items for candidate tests)
- `makeDiagnosticianTaskInput(options)` — creates TaskRecord with diagnosticJson
- `StubRuntimeAdapter` / `TestDoubleRuntimeAdapter` — test doubles for PDRuntimeAdapter
- `RuntimeStateManager` with temp dir per test — real SQLite stores
- `PassThroughValidator` — always passes validation
- `FailingValidator` / `AlwaysInvalidValidator` — always fails validation
- `StoreEventEmitter` — in-memory event collection

### Established Patterns
- Tests use `path.join(os.tmpdir(), 'pd-e2e-m5-05-${pid}')` per test session
- `beforeEach` creates temp dir + stateManager; `afterEach` closes + cleans up
- `createRunner()` helper accepts validator + committer overrides
- Committer is injected via `DiagnosticianRunnerDeps.committer`

### Integration Points
- New test file connects: DiagnosticianRunner → DiagnosticianCommitter → SQLite `artifacts`/`principle_candidates` tables → CLI functions → stateManager
- Direct SQL queries via `sqliteConn.prepare()` on the connection from stateManager

</code_context>

<specifics>
## Specific Ideas

- E2EV-01 output.recommendations should include at least 2 items with `kind: 'principle'` to verify candidate extraction works correctly
- Use `uuidv4()` for taskId/runId to avoid collisions across test scenarios
- Committer failure injection: wrap a real committer but override `commit()` to throw after artifact insert (simulates mid-transaction failure)

</specifics>

<deferred>
## Deferred Ideas

None — all discussion stayed within E2E verification scope.

</deferred>

---

*Phase: m5-05-E2EVerification*
*Context gathered: 2026-04-24*
