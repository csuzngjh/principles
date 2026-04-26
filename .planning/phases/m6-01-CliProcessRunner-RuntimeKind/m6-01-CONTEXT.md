# Phase m6-01: CliProcessRunner + RuntimeKind Extension - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

**Domain:** Generic child process runner utility (`CliProcessRunner`) + `RuntimeKindSchema` extension with `openclaw-cli` literal.

This is the foundational utility phase for M6. `CliProcessRunner` is a standalone utility that spawns a child process, captures stdout/stderr/exitCode/durationMs, handles timeout with graceful tree kill, and returns a structured result. `RuntimeKindSchema` is extended to include the `openclaw-cli` literal while retaining `TestDouble` as explicit test-only runtime.

**Scope anchor:** CliProcessRunner does NOT know about DiagnosticianOutputV1 or PD concepts — it's a pure process runner. OpenClawCliRuntimeAdapter (m6-02) is the consumer.

</domain>

<decisions>
## Implementation Decisions

### Process Spawn API

- **D-01:** `spawn()` with array arguments (command + args as separate array elements).
  - Enables full shell features (glob expansion, piping, env expansion) via optional `shell: true`.
  - Proper process tree semantics — child inherits group, SIGTERM propagates to all children.
  - No shell injection risk when `shell: false` and args are properly separated.
  - Node.js `child_process.spawn()` is the canonical API for long-running CLI tools.

### Timeout Handling

- **D-02:** Graceful tree kill: SIGTERM first, then SIGKILL after grace period.
  1. On timeout: send SIGTERM to process group (`kill(-pid, 'SIGTERM')`)
  2. Wait grace period (default 3s, configurable via `killGracePeriodMs`)
  3. If still alive: send SIGKILL (`kill(-pid, 'SIGKILL')`)
  - Rationale: gracefully shuts down agents/background processes before force-killing.

### Environment Variable Strategy

- **D-03:** Merge with parent environment — `Object.assign({}, process.env, env)`.
  - PD CLI typically runs in the user's shell environment and needs inherited env vars (PATH, etc.).
  - Merge preserves parent context while allowing caller to add/override specific vars.
  - Explicit env param means empty env still gets full parent env (safe default).

### RuntimeKind Literal

- **D-04:** `RuntimeKindSchema` extended with `Type.Literal('openclaw-cli')` — explicit literal, not shared with `openclaw` or `openclaw-history`.
  - Distinct from `openclaw` (generic OpenClaw runtime) and `openclaw-history` (compatibility import).
  - `TestDouble` retained as explicit `Type.Literal('test-double')` — test-only runtime, not a fallback.
  - New literal is added, existing literals unchanged (RUK-01, RUK-02 satisfied).

### Output Capture

- **D-05:** Capture stdout only — CliOutput `{ stdout: string, stderr: string, exitCode: number | null, timedOut: boolean, durationMs: number }`.
  - `stderr` captured separately for diagnostic context but not returned as part of result (kept internal or logged).
  - `exitCode: null` indicates the process didn't exit (still running or killed).
  - No `throwOnNonZeroExit` — caller handles exit code check (m6-02 maps exit codes to PDErrorCategory).

### Timeout Configuration

- **D-06:** Configurable timeout via `timeoutMs` parameter (default undefined = no timeout).
  - Caller controls timeout (openclaw-cli adapter passes `--timeout <seconds>`).
  - `killGracePeriodMs` also configurable with sensible default (3000ms).
  - Internal timeout tracking based on `Date.now()` delta, not external timer.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Runtime Protocol (M1 frozen)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface, RuntimeKindSchema, RunHandle, RunStatus, StructuredRunOutput
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory enum

### Existing Pattern (M4 test-double)
- `packages/principles-core/src/runtime-v2/adapter/test-double-runtime-adapter.ts` — RuntimeKind='test-double' implementation as reference for how RuntimeKind literal extends schema

### OpenClaw CLI Contract
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — openclaw agent command contract, output structure (CliOutput.text), no --workspace flag, two-workspace boundary

### Project Context
- `.planning/PROJECT.md` — M6 goals, hard gates (HG-4 CliOutput.text → DiagnosticianOutputV1 parse+validate, HG-6 non-goals)
- `.planning/ROADMAP.md` §Phase m6-01 — RUNR-01~04, RUK-01~02 requirements, success criteria

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TestDoubleRuntimeAdapter` (adapter/test-double-runtime-adapter.ts) — shows how RuntimeKindSchema extends with Type.Literal(), pattern to follow for 'openclaw-cli' literal
- `PDRuntimeAdapter` interface (runtime-protocol.ts) — adapter MUST implement startRun/pollRun/fetchOutput/cancelRun/healthCheck/getCapabilities
- `RuntimeStateManager` pattern — how state managers are composed in runtime-v2

### Established Patterns
- TypeBox schema + Value.Check() for validation
- PDRuntimeError(category, message) for error throwing
- StoreEventEmitter for telemetry events
- Runner phase-based step pipeline pattern (from m4-01)

### Integration Points
- CliProcessRunner consumed by OpenClawCliRuntimeAdapter (m6-02) via startRun() → spawn openclaw agent
- RuntimeKind 'openclaw-cli' registered in runtime registry (m6-02)
- m6-04: pd runtime probe --runtime openclaw-cli uses healthCheck() from adapter

</code_context>

<specifics>
## Specific Ideas

- CliProcessRunner is framework-agnostic — no PD, no OpenClaw, no DiagnosticianOutputV1 references
- Result shape:
  ```ts
  interface CliOutput {
    stdout: string;
    stderr: string;       // internal capture, not in public result
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
  }
  ```
- Error handling: spawn errors (ENOENT) vs timeout vs non-zero exit are three distinct failure modes
- Tests must cover: success, non-zero exit, timeout, ENOENT (binary not found), invalid JSON (for m6-02)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within m6-01 scope.

</deferred>

---

*Phase: m6-01-CliProcessRunner-RuntimeKind*
*Context gathered: 2026-04-24*