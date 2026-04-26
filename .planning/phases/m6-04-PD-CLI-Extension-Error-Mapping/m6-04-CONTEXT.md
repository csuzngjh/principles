# Phase m6-04: PD CLI Extension + Error Mapping - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** PD CLI commands (`pd diagnose run --runtime openclaw-cli`, `pd runtime probe --runtime openclaw-cli`) routing to `OpenClawCliRuntimeAdapter` with full error mapping.

**Scope anchor:** m6-02 OCRA adapter + m6-03 DiagnosticianPromptBuilder → actual CLI commands. Error mapping (ERR-01~05) surfaces through CLI output. HG-1 must be delivered.

</domain>

<decisions>
## Implementation Decisions

### CLI Routing — Runtime Selection

- **CLI-01:** `pd diagnose run --runtime test-double` continues to work — regression test required.
- **CLI-02:** `pd diagnose run --runtime openclaw-cli --agent <id> [--json]` routes to `OpenClawCliRuntimeAdapter`.
  - `runtimeKind` passed to DiagnosticianRunner config
  - Adapter selected via import (not dynamic — m6-04 registers adapter by kind)

### runtimeMode CLI Flag (HG-03)

- **HG-03 (enforced):** `--openclaw-local`/`--openclaw-gateway` must be explicit CLI flags — no silent fallback.
- **M4-01:** CLI passes `runtimeMode: 'local' | 'gateway'` via constructor options to `OpenClawCliRuntimeAdapter`.
  - `--openclaw-local` flag → `runtimeMode: 'local'`
  - `--openclaw-gateway` flag → `runtimeMode: 'gateway'`
  - Neither flag present → CLI exits with error (no silent default)
- Both flags present → CLI exits with error (mutually exclusive)

### pd runtime probe — HG-1 HARD GATE

- **HG-01 (HARD GATE):** `pd runtime probe --runtime openclaw-cli` must deliver.
- **M4-02:** Probe implemented as direct `healthCheck()` + `getCapabilities()` call on `OpenClawCliRuntimeAdapter`.
  - `adapter.healthCheck()` → `{ healthy, degraded, warnings, lastCheckedAt }`
  - `adapter.getCapabilities()` → `{ supportsStructuredJsonOutput, supportsToolUse, ... }`
  - No separate `probe()` interface needed — direct adapter method calls
  - Console output: human-readable status + capabilities table
  - `--json` flag: structured JSON output with health + capabilities fields
- **CLI-03:** Probe command returns runtime health and capabilities (HG-1 satisfied by M4-02)

### CLI Output Format

- **CLI-04:** All CLI output supports `--json` format.
- **M4-03:** Human-readable + exit code by default; `--json` flag enables structured JSON output.
  - Console mode: `error: <readable message> (errorCategory)` + exit 1 for errors
  - JSON mode: `{ status, errorCategory?, message?, details? }` structure
  - Success JSON: `{ status: 'succeeded', output: {...} }`
  - Error JSON: `{ status: 'failed', errorCategory, message, runtimeKind }`

### Error Mapping (ERR-01~05)

- **ERR-01:** `openclaw` binary not found / ENOENT → `runtime_unavailable`
- **ERR-02:** CliProcessRunner timeout → `timeout`
- **ERR-03:** Non-zero CLI exit code (non-ENOENT) → `execution_failed`
- **ERR-04:** CliOutput.text JSON parse failed → `output_invalid`
- **ERR-05:** CliOutput.text parse succeeds but fails DiagnosticianOutputV1 schema → `output_invalid`

Error mapping is implemented in `OpenClawCliRuntimeAdapter.fetchOutput()` (m6-02 D-04). CLI surfaces these as structured output per M4-03.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Schema & Protocol
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface, RuntimeKind, RuntimeCapabilities, RuntimeHealth
- `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — OpenClawCliRuntimeAdapter with healthCheck(), getCapabilities(), startRun(), fetchOutput()
- `packages/principles-core/src/runtime-v2/diagnostician-prompt-builder.ts` — DiagnosticianPromptBuilder (m6-03)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory, PDRuntimeError
- `packages/principles-core/src/runtime-v2/runner/diagnostician-runner.ts` — DiagnosticianRunner config (runtimeKind passed here)

### CLI Surface
- `packages/principles-core/src/runtime-v2/cli/diagnose.ts` — Existing diagnose library functions (run, status, candidateList, etc.)
- `packages/pd-cli/src/commands/diagnose.ts` — Existing pd diagnose run/status implementation (TestDouble adapter hardcoded)
- `packages/pd-cli/src/commands/run.ts` — pd run list/show pattern for reference

### Prior Phases
- `.planning/phases/m6-03-DiagnosticianPromptBuilder-Workspace/m6-03-CONTEXT.md` — DiagnosticianPromptBuilder decisions (DPB-01~09, HG-02, HG-03)
- `.planning/phases/m6-02-OpenClawCliRuntimeAdapter-Core/m6-02-CONTEXT.md` — OCRA decisions (D-01~D-06), error mapping (D-04)
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — OpenClaw CLI contract

### M6 Roadmap
- `.planning/ROADMAP.md` §Phase m6-04 — Success criteria (CLI-01~04, ERR-01~05), HG-1 HARD GATE
- `.planning/REQUIREMENTS.md` — CLI-01~04, ERR-01~05 requirements

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `DiagnosticianRunner` config: `{ stateManager, contextAssembler, runtimeAdapter, eventEmitter, validator, committer, owner, runtimeKind, pollIntervalMs, timeoutMs }` — runtimeKind passed at construction
- `OpenClawCliRuntimeAdapterOptions`: `{ runtimeMode: 'local' | 'gateway', workspaceDir?: string }` — from m6-03
- `DiagnosticianPromptBuilder.buildPrompt(payload)` → returns `{ message, promptInput }` — message is JSON string for --message arg
- Existing `pd diagnose run` pattern: stateManager → contextAssembler → runtimeAdapter → runner → committer

### Established Patterns
- CLI `--json` flag pattern already exists in `handleDiagnoseRun()` and `handleDiagnoseStatus()`
- `pd run list/show` pattern for console table output
- Error handling: `process.exit(1)` for errors
- health.ts pattern for console table output (no --json, but shows structure)

### Integration Points
- `DiagnosticianRunner` constructor: `runtimeKind` field determines which adapter is used
- `OpenClawCliRuntimeAdapter` registered by kind `'openclaw-cli'` in adapter registry
- CLI commands import from `@principles/core/runtime-v2/index.js`

</code_context>

<deferred>
## Deferred Ideas

None — discussion stayed within m6-04 scope.
</deferred>

---

*Phase: m6-04-PD-CLI-Extension-Error-Mapping*
*Context gathered: 2026-04-24*
