# Roadmap: v2.5 M6 — Production Runtime Adapter: OpenClaw CLI Diagnostician

## Phases

- [ ] **Phase m6-01: CliProcessRunner + RuntimeKind Extension** — Foundation utility (process runner + schema)
- [ ] **Phase m6-02: OpenClawCliRuntimeAdapter Core** — One-shot adapter, output parsing, error mapping
- [x] **Phase m6-03: DiagnosticianPromptBuilder + Workspace Boundary** — Prompt construction + workspace isolation
- [ ] **Phase m6-04: PD CLI Extension + Error Mapping** — CLI commands + error category mapping
- [ ] **Phase m6-05: Telemetry Events** — runtime events emission
- [ ] **Phase m6-06: E2E Verification** — Full pipeline integration + hard gates

## Phase Details

### Phase m6-01: CliProcessRunner + RuntimeKind Extension

**Goal**: Generic process runner utility and RuntimeKind schema extension

**Depends on**: Nothing (first phase)

**Requirements**: RUNR-01, RUNR-02, RUNR-03, RUNR-04, RUK-01, RUK-02

**Success Criteria** (what must be TRUE):
1. `CliProcessRunner` accepts command, args, cwd, env, timeoutMs and spawns child process
2. Runner captures stdout, stderr, exitCode, durationMs and returns structured result
3. Runner kills child process on timeout and returns timeout error
4. No shell injection (spawn/execFile uses array args, not string concatenation)
5. Unit tests cover success, non-zero exit, timeout, invalid JSON scenarios
6. `RuntimeKindSchema` includes `openclaw-cli` literal; `TestDouble` retained as explicit test-only runtime

**Plans**: 2 plans

Plans:
- [ ] m6-01-01-PLAN.md — CliProcessRunner utility + unit tests
- [ ] m6-01-02-PLAN.md — RuntimeKindSchema extension with openclaw-cli

---

### Phase m6-02: OpenClawCliRuntimeAdapter Core

**Goal**: PDRuntimeAdapter implementation for openclaw-cli with one-shot run

**Depends on**: m6-01

**Requirements**: OCRA-01, OCRA-02, OCRA-03, OCRA-04, OCRA-05

**Success Criteria** (what must be TRUE):
1. `OpenClawCliRuntimeAdapter` implements `PDRuntimeAdapter` with `RuntimeKind = 'openclaw-cli'`
2. `startRun` synchronously invokes `openclaw agent --agent <id> --message <json> --json --local --timeout <ms>` and caches result
3. `fetchOutput` parses `CliOutput.text` and returns `DiagnosticianOutputV1`
4. CLI failures map to correct `PDErrorCategory`: ENOENT→runtime_unavailable, timeout→timeout, non-zero exit→execution_failed, invalid JSON→output_invalid, schema mismatch→output_invalid
5. One-shot run without session management complexity
6. Adapter is registered in runtime registry

**Plans**: 3 plans (m6-02-01 through m6-02-03)

Plans:
- [x] m6-02-01-PLAN.md — OpenClawCliRuntimeAdapter implementation
- [x] m6-02-02-PLAN.md — Unit tests for OpenClawCliRuntimeAdapter
- [x] m6-02-03-PLAN.md — Adapter export from index.ts

---

### Phase m6-03: DiagnosticianPromptBuilder + Workspace Boundary

**Goal**: Prompt builder for OpenClaw agent + explicit workspace boundary control

**Depends on**: m6-01, m6-02

**Requirements**: DPB-01, DPB-02, DPB-03, DPB-04, DPB-05, OCRA-06, OCRA-07

**Success Criteria** (what must be TRUE):
1. `DiagnosticianPromptBuilder` transforms `DiagnosticianContextPayload` into JSON message for OpenClaw agent
2. Prompt outputs only JSON (no markdown, file ops, tool calls)
3. JSON conforms to `DiagnosticianOutputV1` schema
4. Prompt includes contextHash, taskId, diagnosisTarget, conversationWindow summary, sourceRefs
5. LLM only analyzes; code handles PD database commits (not LLM)
6. Workspace boundary explicitly controlled via cwd/env/profile/agent config (HG-2)
7. PD workspace and OpenClaw agent workspace are distinct boundaries with explicit handoff
8. `--openclaw-local`/`--openclaw-gateway` mode explicit; no silent fallback; both failure paths tested (OCRA-07, HG-3)

**Plans**: 7 plans (m6-03-01 through m6-03-07)

Plans:
- [ ] m6-03-01-PLAN.md — PromptInput type + DiagnosticianPromptBuilder skeleton
- [ ] m6-03-02-PLAN.md — Unit tests for DiagnosticianPromptBuilder (DPB-01~05)
- [ ] m6-03-03-PLAN.md — OpenClawCliRuntimeAdapter runtimeMode + workspaceDir (OCRA-06, OCRA-07)
- [ ] m6-03-04-PLAN.md — buildPrompt() full implementation with DPB-04 field mapping
- [ ] m6-03-05-PLAN.md — OCRA-06/07 unit tests for OpenClawCliRuntimeAdapter
- [ ] m6-03-06-PLAN.md — DiagnosticianPromptBuilder exports from runtime-v2 index.ts
- [ ] m6-03-07-PLAN.md — Integration tests: DiagnosticianPromptBuilder → OpenClawCliRuntimeAdapter pipeline

---

### Phase m6-04: PD CLI Extension + Error Mapping

**Goal**: CLI commands routing to runtime adapter with error mapping

**Depends on**: m6-01, m6-02, m6-03

**Requirements**: CLI-01, CLI-02, CLI-03, CLI-04, ERR-01, ERR-02, ERR-03, ERR-04, ERR-05

**Success Criteria** (what must be TRUE):
1. `pd diagnose run --runtime test-double` continues to work (regression)
2. `pd diagnose run --runtime openclaw-cli --agent <id> [--json]` routes to `OpenClawCliRuntimeAdapter`
3. `pd runtime probe --runtime openclaw-cli` returns runtime health and capabilities (HG-1 HARD GATE)
4. All CLI output supports `--json` format
5. `openclaw` binary not found / ENOENT → `runtime_unavailable` (ERR-01)
6. CliProcessRunner timeout → `timeout` (ERR-02)
7. Non-zero CLI exit code → `execution_failed` (ERR-03)
8. CliOutput.text JSON parse failed → `output_invalid` (ERR-04)
9. CliOutput.text not valid DiagnosticianOutputV1 → `output_invalid` (ERR-05)

**Plans**: 3 plans

Plans:
- [ ] m6-04-01-PLAN.md — Adapter export + CLI routing + error output (CLI-01, CLI-02, CLI-04, ERR-01~ERR-05)
- [ ] m6-04-02-PLAN.md — pd runtime probe command (CLI-03, HG-01 HARD GATE)
- [ ] m6-04-03-PLAN.md — Regression tests (CLI-01 regression, CLI-03, CLI-04)

---

### Phase m6-05: Telemetry Events

**Goal**: Runtime telemetry events for observability

**Depends on**: m6-02, m6-03, m6-04

**Requirements**: TELE-01, TELE-02, TELE-03, TELE-04

**Success Criteria** (what must be TRUE):
1. `runtime_adapter_selected` event emitted when openclaw-cli runtime is selected
2. `runtime_invocation_started` event emitted when CLI process starts
3. `runtime_invocation_succeeded` / `runtime_invocation_failed` event emitted on CLI completion (includes errorCategory)
4. `output_validation_succeeded` / `output_validation_failed` event emitted during DiagnosticianOutputV1 validation

**Plans**: 2 plans

Plans:
- [ ] m6-05-01-PLAN.md — Telemetry event emission in adapter and runner
- [ ] m6-05-02-PLAN.md — Telemetry event verification

---

### Phase m6-06: E2E Verification

**Goal**: Full pipeline integration with hard gates

**Depends on**: m6-01, m6-02, m6-03, m6-04, m6-05

**Requirements**: E2EV-01, E2EV-02, E2EV-03, E2EV-04, E2EV-05, E2EV-06, E2EV-07, E2EV-08

**Success Criteria** (what must be TRUE):
1. Fake CliProcessRunner proves openclaw-cli adapter path without real openclaw binary
2. `pd diagnose run --runtime openclaw-cli --agent <id>` complete flow with mock runner (E2EV-02)
3. `TestDoubleRuntimeAdapter` path unaffected (E2EV-03 regression)
4. `pd runtime probe --runtime openclaw-cli` succeeds and returns healthy status (HG-1 verified)
5. `pd context build` produces valid `DiagnosticianContextPayload`
6. `pd diagnose run --runtime openclaw-cli --agent <id>` real flow: task → run → openclaw agent → DiagnosticianOutputV1 → artifact → candidates
7. `pd candidate list` / `pd artifact show` show openclaw-cli produced artifacts and candidates
8. Legacy import path (openclaw-history runtime) continues to work (E2EV-08)
9. `--openclaw-local` / `--openclaw-gateway` mode works as explicit config (HG-3, OCRA-07)
10. Real `D:\.openclaw\workspace` verified (HG-5)
11. If real OpenClaw unavailable: blocked evidence recorded, no fake success

**Plans**: 3 plans

Plans:
- [x] m6-06-01-PLAN.md — FakeCliProcessRunner E2E (E2EV-01, E2EV-02, E2EV-03, HG-3)
- [ ] m6-06-02-PLAN.md — Real OpenClaw CLI path + hard gates (E2EV-04, E2EV-05, E2EV-06, E2EV-07, HG-1, HG-5)
- [ ] m6-06-03-PLAN.md — Legacy openclaw-history import regression (E2EV-08)

---

## Progress Table

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| m6-01: CliProcessRunner + RuntimeKind | 0/2 | Planning | — |
| m6-02: OpenClawCliRuntimeAdapter Core | 3/3 | Planning | — |
| m6-03: DiagnosticianPromptBuilder + Workspace | 0/7 | Planning | — |
| m6-04: PD CLI Extension + Error Mapping | 0/3 | Planning | — |
| m6-05: Telemetry Events | 0/2 | Planning | — |
| m6-06: E2E Verification | 1/3 | Planning | — |

---

## Hard Gates (HG-1 ~ HG-6)

| ID | Description | Phase |
|----|-------------|-------|
| HG-1 | `pd runtime probe --runtime openclaw-cli` must deliver | m6-04 |
| HG-2 | OpenClaw CLI no `--workspace`; two workspace boundaries explicitly controlled | m6-03 |
| HG-3 | `--openclaw-local`/`--openclaw-gateway` must be explicit; no silent fallback | m6-03 |
| HG-4 | CliOutput.text -> DiagnosticianOutputV1 parse + validate | m6-02 |
| HG-5 | Real `D:\.openclaw\workspace` verification | m6-06 |
| HG-6 | Non-goals respected (no heartbeat/prompt hook/sessions_spawn/marker file/plugin API) | All |

---

_Last updated: 2026-04-25 after m6-06 planning_
