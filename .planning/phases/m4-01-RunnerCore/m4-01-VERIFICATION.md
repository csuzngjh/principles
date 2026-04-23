---
phase: m4-01-RunnerCore
verified: 2026-04-23T13:10:00Z
status: passed
score: 11/11 must-haves verified
overrides_applied: 0
re_verification: false
---

# Phase m4-01: RunnerCore Verification Report

**Phase Goal:** Replace heartbeat-prompt-driven diagnostician execution with explicit runner-driven execution via DiagnosticianRunner class with full lifecycle (lease -> context -> invoke -> poll -> output -> validate -> succeed/fail)
**Verified:** 2026-04-23T13:10:00Z
**Status:** passed
**Re-verification:** No -- initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | RunnerPhase enum defines all 9 internal execution phases from CONTEXT.md D-01 | VERIFIED | runner-phase.ts: Idle, BuildingContext, CreatingRun, Invoking, Polling, FetchingOutput, Validating, Completed, Failed |
| 2 | RunnerResult discriminates succeeded/failed/retried with required fields | VERIFIED | runner-result.ts: RunnerResultStatus type + RunnerResult interface with status, taskId, attemptCount, optional output/errorCategory/failureReason/contextHash |
| 3 | RuntimeStateManager.markTaskRetryWait transitions task to retry_wait and emits telemetry | VERIFIED | runtime-state-manager.ts:243 -- sets status='retry_wait', clears lease fields, updates latest run to 'failed', emits 'task_retried' event |
| 4 | RuntimeStateManager.updateRunOutput writes outputPayload to latest run and emits telemetry | VERIFIED | runtime-state-manager.ts:281 -- sets outputPayload, executionStatus='succeeded', emits 'run_completed' event |
| 5 | DiagnosticianValidator interface defines validate method contract for m4-03 implementation | VERIFIED | diagnostician-validator.ts:25-34 -- DiagnosticianValidator interface with validate(output, taskId) returning DiagnosticianValidationResult; PassThroughValidator stub at line 40 |
| 6 | Runner executes full lifecycle: lease -> context -> invoke -> poll -> output -> validate -> succeed | VERIFIED | diagnostician-runner.ts:101-149 -- run() method follows exact pipeline order, each phase is independent method |
| 7 | Runner constructs StartRunInput with agentSpec.agentId='diagnostician' | VERIFIED | diagnostician-runner.ts:182-183 -- agentSpec: { agentId: 'diagnostician', schemaVersion: 'v1' }; unit test 8 verifies this |
| 8 | Runner polls runtime until terminal status or timeout, calls cancelRun on timeout | VERIFIED | diagnostician-runner.ts:194-209 -- pollUntilTerminal with deadline-based while loop, terminalStatuses array, cancelRun call on timeout |
| 9 | Runner marks task retry_wait on transient errors via stateManager.markTaskRetryWait | VERIFIED | diagnostician-runner.ts:281 -- retryOrFail calls markTaskRetryWait when shouldRetry=true and not permanent error |
| 10 | Runner marks task failed on permanent errors or max_attempts via stateManager.markTaskFailed | VERIFIED | diagnostician-runner.ts:273,287 -- markTaskFailed for permanent errors and max_attempts_exceeded |
| 11 | Runner does NOT import from evolution-worker.ts or prompt.ts | VERIFIED | grep for imports in runner/ directory returns only comment references, no actual imports |

**Score:** 11/11 truths verified

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | M4-REQ-2.3: Full DiagnosticianValidator (schema + semantic + evidence back-check) | m4-03 Validator | REQUIREMENTS.md 2.3; PassThroughValidator is documented stub resolved by m4-03 |
| 2 | M4-REQ-2.5: Retry/Lease/Recovery integration tests (crash recovery, concurrent execution, expired lease) | m4-04 RetryLeaseIntegration | REQUIREMENTS.md 2.5; ROADMAP.md lists m4-04 as dedicated phase |
| 3 | M4-REQ-2.7: Diagnostician-specific telemetry events (diagnostician_task_leased, etc.) | m4-05 TelemetryCLI | REQUIREMENTS.md 2.7; m4-01 uses existing event types (task_retried, run_completed) |
| 4 | M4-REQ-2.8: CLI surface (pd diagnose run/status) | m4-05 TelemetryCLI | REQUIREMENTS.md 2.8; ROADMAP.md lists m4-05 as Telemetry+CLI phase |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `runner/runner-phase.ts` | RunnerPhase enum with 9 phases | VERIFIED | 19 lines, 9 enum values, matches CONTEXT.md D-01 |
| `runner/runner-result.ts` | RunnerResult type + RunnerResultStatus | VERIFIED | 21 lines, discriminated result type |
| `runner/diagnostician-runner-options.ts` | Options interface with defaults | VERIFIED | 40 lines, DiagnosticianRunnerOptions + ResolvedDiagnosticianRunnerOptions + DEFAULT_RUNNER_OPTIONS + resolveRunnerOptions |
| `runner/diagnostician-validator.ts` | Validator interface + PassThroughValidator | VERIFIED | 45 lines, interface definition + stub implementation |
| `runner/diagnostician-runner.ts` | DiagnosticianRunner class | VERIFIED | 335 lines, full lifecycle pipeline with phase-based methods, DI via DiagnosticianRunnerDeps |
| `runner/__tests__/diagnostician-runner.test.ts` | Unit tests (11 scenarios) | VERIFIED | 458 lines, 11 test scenarios covering happy path, polling, timeout, failure, validation, lease conflict, max attempts, openclaw compat |
| `runner/__tests__/diagnostician-runner.integration.test.ts` | Integration tests with real SQLite | VERIFIED | 493 lines, 4 scenarios with real RuntimeStateManager + SqliteContextAssembler, only adapter mocked |
| `store/runtime-state-manager.ts` | markTaskRetryWait + updateRunOutput methods | VERIFIED | Lines 243-300, both methods follow established pattern |
| `index.ts` | Runner type re-exports | VERIFIED | Lines 149-156, exports DiagnosticianRunner, RunnerPhase, PassThroughValidator, resolveRunnerOptions, DEFAULT_RUNNER_OPTIONS, plus type exports |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `diagnostician-runner.ts` | `store/runtime-state-manager.ts` | acquireLease / markTaskSucceeded / markTaskFailed / markTaskRetryWait / updateRunOutput / getRunsByTask | WIRED | 7 call sites verified (lines 104, 165, 221, 225, 273, 281, 287) |
| `diagnostician-runner.ts` | `store/context-assembler.ts` | contextAssembler.assemble(taskId) | WIRED | Line 155, calls assemble with taskId |
| `diagnostician-runner.ts` | `runtime-protocol.ts` | runtimeAdapter.startRun / pollRun / fetchOutput / cancelRun | WIRED | Lines 191, 199, 207, 212 -- all 4 adapter methods used |
| `diagnostician-runner.ts` | `runner/diagnostician-validator.ts` | validator.validate(output, taskId) | WIRED | Line 138, delegates validation to injected validator |
| `runner/__tests__/integration.test.ts` | `store/runtime-state-manager.ts` | new RuntimeStateManager({ workspaceDir }) | WIRED | Line 227, real instance with temp directory |
| `runner/__tests__/integration.test.ts` | `store/sqlite-context-assembler.ts` | new SqliteContextAssembler(taskStore, historyQuery, runStore) | WIRED | Line 237, real instance with real stores |
| `index.ts` | `runner/diagnostician-runner.ts` | export { DiagnosticianRunner } | WIRED | Line 150, runtime-v2 barrel export |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| `diagnostician-runner.ts` | `leasedTask` (TaskRecord) | `stateManager.acquireLease()` | Yes -- creates real lease with deterministic run record | FLOWING |
| `diagnostician-runner.ts` | `context` (DiagnosticianContextPayload) | `contextAssembler.assemble(taskId)` | Yes -- integration test verifies real SqliteContextAssembler produces valid context with sourceRefs | FLOWING |
| `diagnostician-runner.ts` | `runHandle` (RunHandle) | `runtimeAdapter.startRun(startInput)` | Yes -- integration test StubRuntimeAdapter returns real RunHandle with runId | FLOWING |
| `diagnostician-runner.ts` | `output` (DiagnosticianOutputV1) | `runtimeAdapter.fetchOutput(runId)` + JSON parse | Yes -- integration test verifies real JSON output stored in run record | FLOWING |
| `diagnostician-runner.ts` | `storeRunId` (string) | `stateManager.getRunsByTask()` lookup | Yes -- resolves store runId for updateRunOutput, verified in integration test | FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| All runner tests pass | `cd packages/principles-core && npx vitest run src/runtime-v2/runner/` | 2 test files, 15 tests passed, 580ms | PASS |
| TypeScript compiles cleanly | `cd packages/principles-core && npx tsc --noEmit` | Exit code 0, no output (clean) | PASS |
| Runner types exported from index.ts | `grep DiagnosticianRunner src/runtime-v2/index.ts` | Line 150: `export { DiagnosticianRunner }` | PASS |
| No forbidden imports | `grep -r "from.*evolution-worker\|from.*prompt\.ts" src/runtime-v2/runner/` | No matches | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| M4-REQ-2.1 | Plans 01, 02, 03 | DiagnosticianRunner: lease, context, run, invoke, poll, fetch output, validate, succeed/fail | SATISFIED | Full lifecycle implemented in diagnostician-runner.ts:101-149; 11 unit tests + 4 integration tests pass |
| M4-REQ-2.2 | Plans 02, 03 | Runtime Invocation Path: StartRunInput with agentSpec:diagnostician | SATISFIED | diagnostician-runner.ts:182-191 constructs StartRunInput with agentSpec.agentId='diagnostician'; unit test 8 verifies |
| M4-REQ-2.3 | Plan 01 (interface only) | DiagnosticianValidator: interface defined, PassThroughValidator stub | PARTIALLY SATISFIED | Interface + stub complete; full validation deferred to m4-03 (documented) |
| M4-REQ-2.4 | Plans 01, 02, 03 | Runner State Transitions: pending->leased->running->validating->succeeded/retry_wait/failed | SATISFIED | RunnerPhase enum (9 values) for internal tracking; only PDTaskStatus values persisted; integration test 4 verifies retry_wait transition |
| M4-REQ-2.6 | Plans 02, 03 | Compatibility with imported openclaw-history context | SATISFIED | Unit test 11 + integration test 3 verify openclaw-history compatibility; context passes through without rejection |

**Orphaned requirements check:** Plans declare M4-REQ-2.1, 2.2, 2.3, 2.4, 2.6. M4-REQ-2.5 (Retry/Lease), 2.7 (Telemetry), and 2.8 (CLI) are not declared in any plan's `requirements` field. However, they are correctly deferred to later milestone phases (m4-04, m4-05) per the REQUIREMENTS.md suggested decomposition. Not flagged as orphaned -- they are out of m4-01 scope by design.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `runner/__tests__/integration.test.ts` | 174 | `return null` in StubRuntimeAdapter.fetchOutput | Info | Test-only code, not production. Returns null when no output configured (expected behavior) |
| `runner/__tests__/integration.test.ts` | 183 | `return []` in StubRuntimeAdapter.fetchArtifacts | Info | Test-only code, not production. Empty artifacts is valid for test double |

No blocker or warning anti-patterns found in production code.

### Human Verification Required

No human verification items identified. All truths are programmatically verifiable:
- Lifecycle execution is verified through 15 automated tests (11 unit + 4 integration)
- State transitions are verified by checking task/run records in real SQLite stores
- The "no heartbeat dependency" constraint is verified by import analysis
- OpenClaw history compatibility is verified by dedicated integration test

### Gaps Summary

No gaps found. All 11 must-have truths verified with concrete evidence in the codebase:

1. **Type contracts** (Plan 01): RunnerPhase, RunnerResult, Options, Validator interface -- all present and substantive
2. **RuntimeStateManager extensions** (Plan 01): markTaskRetryWait and updateRunOutput -- both implemented with telemetry emission
3. **DiagnosticianRunner lifecycle** (Plan 02): Full phase-based pipeline with error classification, retry policy evaluation, and proper store interactions
4. **Integration verification** (Plan 03): 4 integration tests with real SQLite stores, including openclaw-history compatibility
5. **Public API** (Plan 03): All runner types exported from runtime-v2/index.ts

The PassThroughValidator is a documented stub explicitly planned for replacement in m4-03. This is not a gap -- it is intentional phased delivery.

---

_Verified: 2026-04-23T13:10:00Z_
_Verifier: Claude (gsd-verifier)_
