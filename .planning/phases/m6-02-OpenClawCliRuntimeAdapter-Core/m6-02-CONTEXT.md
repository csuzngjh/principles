# Phase m6-02: OpenClawCliRuntimeAdapter Core - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** OpenClawCliRuntimeAdapter — PDRuntimeAdapter implementation for openclaw-cli with one-shot run, output parsing, and error mapping.

**Scope anchor:** Adapter wraps `openclaw agent` CLI via CliProcessRunner (m6-01), parses `CliOutput.text` into DiagnosticianOutputV1, and maps CLI failures to PDErrorCategory. Does NOT handle prompt construction (m6-03) or CLI routing (m6-04).

</domain>

<decisions>
## Implementation Decisions

### Execution Model

- **D-01:** One-shot async — `startRun()` spawns the `openclaw agent` process, blocks until close, stores result in memory for `pollRun()`/`fetchOutput()`. No separate worker, no session management.
  - `startRun()` returns immediately with RunHandle (runId, startedAt)
  - The spawned process resolves the Promise when the CLI exits
  - No `pollRun()` polling needed — status is known at `startRun()` return time
  - `pollRun()` returns status synchronously from in-memory state
  - `fetchOutput()` parses the stored CliOutput.text and returns StructuredRunOutput

### OpenClaw CLI Invocation

- **D-02:** Command form: `openclaw agent --agent <id> --message <json> --json --local`
  - `--json` always passed — adapter parses CliOutput.text as JSON
  - `--local` always passed — explicit local mode (HG-3 satisfied)
  - `--timeout <seconds>` — derived from StartRunInput.timeoutMs (converted from ms to seconds)
  - `<json>` — JSON message constructed by m6-03 DiagnosticianPromptBuilder (this phase receives it as inputPayload)

### Workspace / Environment Control

- **D-03:** CLI flags only — adapter passes `--local` as explicit flag. No env vars for workspace control in this phase. Gateway/local mode is controlled by presence/absence of `--local` flag (explicit, not silent default).
  - OpenClaw CLI has NO `--workspace` flag (HG-2 enforced by contract, not by adapter code)
  - Two-workspace boundary is handled by m6-03 (DiagnosticianPromptBuilder + workspace boundary control)

### Error Mapping

- **D-04:** Map all 5 error categories:
  1. ENOENT (binary not found) → `runtime_unavailable`
  2. CLI timeout (CliProcessRunner.timedOut=true) → `timeout`
  3. Non-zero CLI exit code → `execution_failed`
  4. CliOutput.text JSON parse failure → `output_invalid`
  5. DiagnosticianOutputV1 schema validation failure → `output_invalid`

### CliOutput.text Parsing

- **D-05:** CliOutput.text is parsed as raw JSON string. Adapter attempts:
  1. `JSON.parse(CliOutput.text)` first
  2. If fails, attempt `extractBalancedJsonFragments()` or similar extraction
  3. If all fail → `output_invalid`
- DiagnosticianOutputV1 validation via `DiagnosticianOutputV1Schema` (from diagnostician-output.ts) — Value.Check() returns true/false
- If validation fails → `output_invalid`

### Adapter Registration

- **D-06:** Adapter registered in runtime registry by kind: `RuntimeKind = 'openclaw-cli'`. Adapter must be imported/registered before `pd runtime probe --runtime openclaw-cli` works.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol & Schema
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface, RuntimeKindSchema, RunHandle, RunStatus, StructuredRunOutput
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1 schema (DiagnosticianOutputV1Schema)
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory enum, PDRuntimeError
- `packages/principles-core/src/runtime-v2/adapter/test-double-runtime-adapter.ts` — Pattern to follow for RuntimeKind='openclaw-cli' implementation

### OpenClaw CLI Contract
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — openclaw agent command contract, output structure (CliOutput.text), no --workspace flag, two-workspace boundary

### M6 Context
- `.planning/phases/m6-01-CliProcessRunner-RuntimeKind/m6-01-CONTEXT.md` — CliProcessRunner decisions (D-01~D-06)
- `.planning/phases/m6-01-CliProcessRunner-RuntimeKind/m6-01-RESEARCH.md` — Technical research (detached: true, taskkill, etc.)
- `.planning/ROADMAP.md` §Phase m6-02 — Success criteria, requirements OCRA-01~05

### Project Context
- `.planning/PROJECT.md` — M6 goals, hard gates (HG-1~HG-6), non-goals
- `.planning/STATE.md` — Current phase and progress

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TestDoubleRuntimeAdapter` (adapter/test-double-runtime-adapter.ts) — Pattern to follow for `kind()` returning RuntimeKind literal and implementing all PDRuntimeAdapter methods
- `CliProcessRunner.runCliProcess()` (utils/cli-process-runner.ts) — Consumed by adapter via `runCliProcess({ command, args, cwd, env, timeoutMs })`
- `DiagnosticianOutputV1Schema` (diagnostician-output.ts) — Used for validation in fetchOutput
- `PDRuntimeError` (error-categories.ts) — Used for error throwing with PDErrorCategory

### Established Patterns
- TypeBox schema + Value.Check() for validation
- PDRuntimeError(category, message) for structured errors
- RuntimeAdapter pattern: kind() returns literal, methods return Promise<T>
- RunHandle has { runId, runtimeKind, startedAt }

### Integration Points
- CliProcessRunner: startRun() calls runCliProcess() to spawn openclaw agent
- DiagnosticianPromptBuilder (m6-03): Produces JSON message passed as --message arg
- Runtime registry: Adapter registered by kind='openclaw-cli'
- m6-04 pd runtime probe: healthCheck() must return healthy:true

</code_context>

<specifics>
## Specific Ideas

- One-shot: startRun() blocks until CLI process completes (Promise resolves on 'close' event)
- startRun() receives StartRunInput with inputPayload containing JSON from DiagnosticianPromptBuilder (m6-03)
- The --message argument is the JSON string serialized from inputPayload
- No session management — each run is independent
- Adapter does NOT construct the --message JSON itself (that comes from m6-03)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within m6-02 scope.

</deferred>

---

*Phase: m6-02-OpenClawCliRuntimeAdapter-Core*
*Context gathered: 2026-04-24*
