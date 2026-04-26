# Phase m6-06: E2E Verification - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** End-to-end integration verification of the full `pd diagnose run --runtime openclaw-cli` pipeline — fake/mocked path plus real OpenClaw path when available. Verifies that all prior phases (m6-01~m6-05) wire together correctly and that hard gates HG-1, HG-3, HG-5 are satisfied.

**Scope anchor:** E2E tests cover the complete DiagnosticianRunner → OpenClawCliRuntimeAdapter → CliProcessRunner → DiagnosticianOutputV1 → SqliteDiagnosticianCommitter → artifact → candidates chain. Also covers `pd runtime probe`, `pd context build`, `pd candidate list`, `pd artifact show`, and legacy openclaw-history import path.

**Key distinction from m5-05:** m5-05 E2E tested DiagnosticianRunner with TestDoubleRuntimeAdapter (mock adapter, no CLI). m6-06 E2E tests OpenClawCliRuntimeAdapter with a FakeCliProcessRunner (real adapter, fake CLI process) — this is the actual runtime adapter being shipped.

</domain>

<decisions>
## Implementation Decisions

### Fake CliProcessRunner (E2EV-01)

- **E2EV-01-D01:** A `FakeCliProcessRunner` is created as a test utility that intercepts `runCliProcess()` calls.
  - Returns predefined `CliOutput` objects (stdout, stderr, exitCode, timedOut, durationMs)
  - Does NOT spawn real processes — enables adapter testing without openclaw binary
  - Injected via the existing `OpenClawCliRuntimeAdapter` constructor via a test hook pattern
  - Must not require modifying the production `runCliProcess` function

### E2E Test Strategy (E2EV-02, E2EV-03)

- **E2EV-02-D01:** E2E test creates a real `RuntimeStateManager` + `SqliteContextAssembler` + `DiagnosticianRunner` with a real `OpenClawCliRuntimeAdapter` configured with a `FakeCliProcessRunner`.
  - Full PD store chain exercised: task → context → run → output → artifact → candidates
  - FakeCliProcessRunner returns valid `DiagnosticianOutputV1` JSON that passes schema validation
  - Verifies the complete DiagnosticianOutputV1 → DiagnosticianCommitter → artifact/candidates path

- **E2EV-03-D01:** Separate regression test confirms `TestDoubleRuntimeAdapter` path is unaffected.
  - Uses existing dual-track-e2e.test.ts or m5-05-e2e.test.ts pattern
  - Ensures the addition of OpenClawCliRuntimeAdapter does not break the test-double path

### Real OpenClaw Path (E2EV-04 ~ E2EV-07)

- **E2EV-04-D01:** `pd runtime probe --runtime openclaw-cli --openclaw-local` succeeds (HG-1 verified) when openclaw binary is present.
  - Tests with `--json` flag for structured output validation
  - If openclaw binary not found → output blocked evidence, no fake success

- **E2EV-05-D01:** `pd context build` (via DiagnosticianContextPayload) produces valid context payload.
  - Must pass schema validation

- **E2EV-06-D01:** Real full flow: `pd diagnose run --runtime openclaw-cli --openclaw-local --agent <id>` → task → run → openclaw agent → DiagnosticianOutputV1 → artifact → candidates.
  - This is the ultimate E2E gate — actual end-to-end through the CLI
  - Requires real openclaw binary and valid auth

- **E2EV-07-D01:** `pd candidate list` and `pd artifact show` can retrieve openclaw-cli-produced artifacts and candidates.
  - Verifies committer wrote rows correctly

### HG-3 / HG-5 Verification

- **HG-3-D01:** `--openclaw-local` and `--openclaw-gateway` modes work as explicit config (HG-3 verified in m6-03).
  - E2E tests should exercise both modes to confirm no silent fallback

- **HG-5-D01:** Real `D:\.openclaw\workspace` is verified to exist and is accessible.
  - If not accessible → blocked evidence recorded

### Blocked Evidence (E2EV Note)

- **E2EV-BLOCKED-D01:** If real OpenClaw is unavailable (no binary or auth), E2E tests output `blocked evidence` — a structured record of what was tested, what blocked (with evidence/screenshots/logs), and what would need to pass for full verification.
  - Never fake success when the real path was not tested
  - `blocked evidence` format: `{ blocked: true, reason: string, evidence: string[], attemptedAt: ISO8601 }`

### Legacy Import (E2EV-08)

- **E2EV-08-D01:** Legacy import path (`openclaw-history` runtime) continues to work.
  - Regression test using existing m3-* integration tests or a new e2e test with the legacy import command

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema & Protocol
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1 schema
- `packages/principles-core/src/runtime-v2/context-payload.ts` — DiagnosticianContextPayload schema
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory, PDRuntimeError

### Core Adapter
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — OpenClawCliRuntimeAdapter (m6-02)
- `packages/principles-core/src/runtime-v2/utils/cli-process-runner.ts` — CliProcessRunner (m6-01)

### Prompt Builder
- `packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.ts` — DiagnosticianPromptBuilder (m6-03)

### Runner & Store
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner
- `packages/principles-core/src/runtime-v2/runner/diagnostician-validator.ts` — DefaultValidator
- `packages/principles-core/src/runtime-v2/store/diagnostician-committer.ts` — SqliteDiagnosticianCommitter
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager

### CLI Surface
- `packages/pd-cli/src/commands/diagnose.ts` — handleDiagnoseRun with --runtime, --openclaw-local, --openclaw-gateway (m6-04)
- `packages/pd-cli/src/commands/runtime.ts` — handleRuntimeProbe (m6-04)
- `packages/pd-cli/src/commands/candidate.ts` — candidate list/show commands
- `packages/pd-cli/src/commands/artifact.ts` — artifact show command

### Existing E2E Tests (Reference Pattern)
- `packages/principles-core/src/runtime-v2/runner/__tests__/m5-05-e2e.test.ts` — m5-05 E2E with TestDoubleRuntimeAdapter (reference for structure)
- `packages/principles-core/src/runtime-v2/runner/__tests__/dual-track-e2e.test.ts` — M4 dual-track E2E (reference for fixture patterns)

### Prior Phases
- `.planning/phases/m6-05-Telemetry-Events/m6-05-CONTEXT.md` — TELE-01~04 event emission decisions
- `.planning/phases/m6-04-PD-CLI-Extension-Error-Mapping/m6-04-CONTEXT.md` — CLI routing, HG-01/HG-03
- `.planning/phases/m6-03-DiagnosticianPromptBuilder-Workspace/m6-03-CONTEXT.md` — DPB decisions, HG-02/HG-03
- `.planning/phases/m6-02-OpenClawCliRuntimeAdapter-Core/m6-02-CONTEXT.md` — OCRA decisions, HG-04

### Hard Gates
- HG-1: `pd runtime probe --runtime openclaw-cli` succeeds → implemented in m6-04
- HG-2: Two workspace boundaries controlled via cwd/env/profile/agent config → implemented in m6-03
- HG-3: `--openclaw-local`/`--openclaw-gateway` explicit, no silent fallback → implemented in m6-03/m6-04
- HG-4: CliOutput.text → DiagnosticianOutputV1 parse+validate → implemented in m6-02
- HG-5: Real `D:\.openclaw\workspace` verified → to be verified in m6-06
- HG-6: Non-goals respected (no heartbeat/prompt hook/sessions_spawn/marker file/plugin API) → verified across all phases

### M6 Requirements
- `.planning/REQUIREMENTS.md` §E2E/Integration Verification — E2EV-01~08 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Fake CliProcessRunner Strategy

The OpenClawCliRuntimeAdapter calls `runCliProcess()` as a module-level function (not injected). To fake it in tests:
1. **Module mocking via `vi.mock()`** (vitest): Mock the `cli-process-runner.ts` module in the test file
2. **Override the method**: Add a test hook to OpenClawCliRuntimeAdapter that allows injecting a fake runner (but this requires modifying production code)
3. **Proxy module pattern**: Create a test-specific entry point that re-exports the adapter with a mocked runner

**Recommended approach:** Use `vi.mock()` to mock `cli-process-runner.ts` in the E2E test file. The mock intercepts `runCliProcess` calls and returns predefined `CliOutput` objects. This is the cleanest approach — no production code changes needed.

### E2E Test File Location

Per m5-05-e2e.test.ts and dual-track-e2e.test.ts patterns: E2E tests go in `packages/principles-core/src/runtime-v2/runner/__tests__/`. New file: `m6-06-e2e.test.ts`.

### CLI Integration Test Approach

CLI integration tests (`pd diagnose run --runtime openclaw-cli`) require spawning the actual `pd` CLI as a subprocess. Use `runCliProcess` or `execFile` to spawn `node packages/pd-cli/dist/index.js diagnose run ...`. Parse stdout/stderr for success/failure validation.

### Test Data Fixtures

- `makeDiagnosticianOutputWithCandidates()` — from m5-05-e2e.test.ts: produces valid DiagnosticianOutputV1 with ≥2 principle recommendations
- Real taskId: use `randomUUID()` per test
- Real workspace: create temp dir via `os.tmpdir()` + `fs.mkdtemp()`

### Telemetry Verification

E2E tests can verify telemetry events by subscribing to the `StoreEventEmitter` used by the runner:
```typescript
const eventEmitter = new StoreEventEmitter();
const events: TelemetryEvent[] = [];
eventEmitter.on('telemetry', (event) => events.push(event));
// ... run test ...
expect(events).toContainEqual(expect.objectContaining({ eventType: 'runtime_adapter_selected' }));
```

</code_context>

<deferred>
## Deferred Ideas

- End-to-end test with real OpenClaw auth (requires manual credential setup)
- Performance/load testing for the CLI runner (not in scope for m6-06)
</deferred>

---

*Phase: m6-06-E2E-Verification*
*Context gathered: 2026-04-25*
