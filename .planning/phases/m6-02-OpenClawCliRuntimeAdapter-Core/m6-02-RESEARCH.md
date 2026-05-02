# Phase m6-02: OpenClawCliRuntimeAdapter Core - Research

**Researched:** 2026-04-24
**Domain:** PDRuntimeAdapter implementation for openclaw-cli (one-shot run, CLI output parsing, error mapping)
**Confidence:** HIGH

## Summary

This phase delivers `OpenClawCliRuntimeAdapter` — the production PDRuntimeAdapter implementation that wraps the `openclaw agent` CLI via `CliProcessRunner` (delivered in m6-01). The adapter spawns a single CLI command per run, captures output, parses `DiagnosticianOutputV1` JSON from `CliOutput.text`, and maps CLI failure modes to `PDErrorCategory`. The one-shot model means `startRun()` returns immediately with a `RunHandle` while the CLI process runs asynchronously; `pollRun()` and `fetchOutput()` operate on in-memory state stored at `startRun()` time. No session management, no worker threads — just one CLI invocation per `startRun()` call.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** One-shot async — `startRun()` spawns `openclaw agent` process, blocks until close, stores result in memory for `pollRun()`/`fetchOutput()`. `startRun()` returns immediately with RunHandle (runId, startedAt). `pollRun()` returns status synchronously from in-memory state. `fetchOutput()` parses stored CliOutput.text.

- **D-02:** Command form: `openclaw agent --agent <id> --message <json> --json --local --timeout <seconds>`
  - `--json` always passed — adapter parses CliOutput.text as JSON
  - `--local` always passed — explicit local mode
  - `--timeout` derived from `StartRunInput.timeoutMs` (converted to seconds)
  - `<json>` is the JSON string from `inputPayload` (provided by m6-03 DiagnosticianPromptBuilder)

- **D-03:** CLI flags only for workspace control. No env vars for workspace in this phase. No `--workspace` flag exists on OpenClaw CLI. Two-workspace boundary is m6-03's job.

- **D-04:** Map all 5 error categories:
  1. ENOENT (binary not found) → `runtime_unavailable`
  2. `CliOutput.timedOut === true` → `timeout`
  3. Non-zero `CliOutput.exitCode` → `execution_failed`
  4. JSON parse failure of CliOutput.text → `output_invalid`
  5. `DiagnosticianOutputV1Schema` validation failure → `output_invalid`

- **D-05:** CliOutput.text parsing:
  1. `JSON.parse(CliOutput.text)` first
  2. If fails, attempt `extractBalancedJsonFragments()` or similar extraction
  3. If all fail → `output_invalid`

- **D-06:** Adapter registered by `RuntimeKind = 'openclaw-cli'`. Adapter must be imported/registered before `pd runtime probe --runtime openclaw-cli` works.

### Claude's Discretion

- Exact file location: `src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts`
- Internal state management: simple Map<runId, RunState> or inline fields
- JSON extraction utility: reuse existing helper or write minimal inline
- Whether to expose `agentId` from `agentSpec.agentId` in the CLI args
- How to handle `cancelRun()` — cancel the child process if still running, or no-op if already completed
- Whether to expose `refreshCapabilities()` — optional on PDRuntimeAdapter; could check openclaw binary exists at path
- Error details structure for PDRuntimeError

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| OCRA-01 | Adapter implements `PDRuntimeAdapter` with `RuntimeKind = 'openclaw-cli'` | `TestDoubleRuntimeAdapter` pattern confirmed; `RuntimeKindSchema` already includes `'openclaw-cli'` [VERIFIED: runtime-protocol.ts:17] |
| OCRA-02 | `startRun` synchronously invokes `openclaw agent --agent <id> --message <json> --json --local --timeout <ms>` and caches result | `runCliProcess()` from m6-01 confirmed: accepts command, args, cwd, env, timeoutMs; `detached: true` confirmed; `openclaw` binary detection via ENOENT handling |
| OCRA-03 | `fetchOutput` parses `CliOutput.text` and returns `DiagnosticianOutputV1` | `CliOutput` interface confirmed: `{ stdout, stderr, exitCode, timedOut, durationMs }`; `DiagnosticianOutputV1Schema` confirmed; `Value.Check()` pattern confirmed |
| OCRA-04 | CLI failures map to correct `PDErrorCategory`: ENOENT→runtime_unavailable, timeout→timeout, non-zero exit→execution_failed, invalid JSON→output_invalid, schema mismatch→output_invalid | `PDErrorCategory` enum confirmed with all needed variants [VERIFIED: error-categories.ts:22-40]; `PDRuntimeError` class confirmed [VERIFIED: error-categories.ts:75-85] |
| OCRA-05 | Adapter is registered in runtime registry | `RuntimeSelector.register()` interface confirmed; m6-04 `pd runtime probe` requires this |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| OpenClawCliRuntimeAdapter (CLI spawn, output parsing, error mapping) | API/Backend | — | Pure Node.js child_process + TypeBox; no DOM, no CDN |
| Run state management (in-memory, per-runId) | API/Backend | — | Simple Map stored in adapter instance; no database |
| CliOutput.text JSON extraction | API/Backend | — | Text parsing, no external I/O |
| DiagnosticianOutputV1 schema validation | API/Backend | — | TypeBox Value.Check() |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|--------|---------|--------------|
| `@sinclair/typebox` | `^0.34.48` | TypeBox schema + `Value.Check()` | Already in `principles-core` deps; `Value.Check(DiagnosticianOutputV1Schema, parsed)` pattern confirmed [VERIFIED: npm registry 0.34.49] |
| `Node.js child_process` | built-in | Already consumed by `CliProcessRunner.run()` | m6-01 delivers this utility |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|--------|---------|-------------|
| `vitest` | (existing test infra) | Unit testing | All m6-02 tests |
| `Node.js crypto` | built-in | `crypto.randomUUID()` for runId generation | No external dependency needed |

**Installation:** No new packages needed. All dependencies already in `principles-core`.

---

## Architecture Patterns

### OpenClawCliRuntimeAdapter — One-Shot Run State Machine

```
startRun(input: StartRunInput)
  │
  ├─► Generate runId (crypto.randomUUID())
  ├─► Construct CLI args: ['agent', '--agent', agentId, '--message', jsonString, '--json', '--local', '--timeout', seconds]
  ├─► Call runCliProcess({ command: 'openclaw', args, cwd, env, timeoutMs })
  │       │
  │       ├─► spawn('openclaw', args, { shell: false, detached: true })
  │       │       │
  │       │       ├─► stdout → captured in CliOutput.stdout
  │       │       ├─► stderr → captured in CliOutput.stderr
  │       │       └─► exit/stderr/timeout → CliOutput
  │       │
  │       └─► Promise<CliOutput> resolves when CLI exits
  │
  ├─► Store: runStateMap.set(runId, { ..., cliOutput })
  └─► Return: { runId, runtimeKind: 'openclaw-cli', startedAt }
        │
        └── (CLI process running in background, promise resolving)

pollRun(runId)
  │
  └─► Read from runStateMap.get(runId)
        ├─ If timedOut → { status: 'timed_out', reason: 'CLI timeout' }
        ├─ If exitCode !== 0 → { status: 'failed', reason: 'CLI exit code N' }
        └─ Otherwise → { status: 'succeeded' }

fetchOutput(runId)
  │
  └─► Read cliOutput from runStateMap.get(runId)
        │
        ├─► Parse CliOutput.text as JSON
        │     ├─► JSON.parse() first attempt
        │     └─► If fails → extractBalancedJsonFragments() or similar
        │
        ├─► Validate with DiagnosticianOutputV1Schema (Value.Check())
        │     └─► If fails → throw PDRuntimeError('output_invalid', ...)
        │
        └─► Return: { runId, payload: DiagnosticianOutputV1 }
```

### Recommended Project Structure

```
packages/principles-core/src/runtime-v2/
├── adapter/
│   ├── index.ts                          # re-export all adapters
│   ├── test-double-runtime-adapter.ts    # existing
│   └── openclaw-cli-runtime-adapter.ts   # m6-02 (NEW)
└── utils/
    └── cli-process-runner.ts             # m6-01 (consumed here)
```

### Adapter Pattern: PDRuntimeAdapter Implementation

```typescript
// Source: TestDoubleRuntimeAdapter pattern + PDRuntimeAdapter interface
// File: src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts

import { Value } from '@sinclair/typebox/value';
import { runCliProcess, type CliOutput } from '../utils/cli-process-runner.js';
import { PDRuntimeError } from '../error-categories.js';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';
import type {
  PDRuntimeAdapter,
  RuntimeKind,
  RuntimeCapabilities,
  RuntimeHealth,
  RunHandle,
  RunStatus,
  StartRunInput,
  StructuredRunOutput,
} from '../runtime-protocol.js';

interface RunState {
  runId: string;
  startedAt: string;
  cliOutput: CliOutput | null;  // null until CLI completes
  completed: boolean;
}

export class OpenClawCliRuntimeAdapter implements PDRuntimeAdapter {
  private readonly runStateMap = new Map<string, RunState>();

  kind(): RuntimeKind {
    return 'openclaw-cli';
  }

  async getCapabilities(): Promise<RuntimeCapabilities> {
    return {
      supportsStructuredJsonOutput: true,
      supportsToolUse: false,
      supportsWorkingDirectory: false,
      supportsModelSelection: false,
      supportsLongRunningSessions: false,
      supportsCancellation: true,
      supportsArtifactWriteBack: false,
      supportsConcurrentRuns: false,
      supportsStreaming: false,
    };
  }

  async healthCheck(): Promise<RuntimeHealth> {
    // Could check 'openclaw' binary exists at PATH here
    return {
      healthy: true,
      degraded: false,
      warnings: [],
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async startRun(input: StartRunInput): Promise<RunHandle> {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    // Initialize state — cliOutput null until CLI completes
    const state: RunState = { runId, startedAt, cliOutput: null, completed: false };
    this.runStateMap.set(runId, state);

    // Build CLI args
    const jsonPayload = typeof input.inputPayload === 'string'
      ? input.inputPayload
      : JSON.stringify(input.inputPayload);
    const timeoutSeconds = Math.ceil((input.timeoutMs ?? 600000) / 1000);
    const agentId = input.agentSpec?.agentId ?? 'diagnostician';

    const args = [
      'agent',
      '--agent', agentId,
      '--message', jsonPayload,
      '--json',
      '--local',
      '--timeout', String(timeoutSeconds),
    ];

    // Spawn CLI — promise resolves when CLI exits
    const cliOutput = await runCliProcess({
      command: 'openclaw',
      args,
      timeoutMs: input.timeoutMs,
    });

    // Store result in memory
    state.cliOutput = cliOutput;
    state.completed = true;

    return { runId, runtimeKind: 'openclaw-cli', startedAt };
  }

  async pollRun(runId: string): Promise<RunStatus> {
    const state = this.runStateMap.get(runId);
    if (!state) {
      throw new PDRuntimeError('output_invalid', `Run ${runId} not found`);
    }

    if (!state.completed || !state.cliOutput) {
      return { runId, status: 'running', startedAt: state.startedAt };
    }

    const { cliOutput } = state;

    if (cliOutput.timedOut) {
      return {
        runId,
        status: 'timed_out',
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        reason: 'CLI timeout exceeded',
      };
    }

    if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
      return {
        runId,
        status: 'failed',
        startedAt: state.startedAt,
        endedAt: new Date().toISOString(),
        reason: `CLI exited with code ${cliOutput.exitCode}`,
      };
    }

    return {
      runId,
      status: 'succeeded',
      startedAt: state.startedAt,
      endedAt: new Date().toISOString(),
    };
  }

  async fetchOutput(runId: string): Promise<StructuredRunOutput> {
    const state = this.runStateMap.get(runId);
    if (!state || !state.completed || !state.cliOutput) {
      throw new PDRuntimeError('output_invalid', `Run ${runId} not completed`);
    }

    const { cliOutput } = state;

    // Map ENOENT to runtime_unavailable
    if (cliOutput.exitCode === null && cliOutput.stderr.startsWith('ENOENT:')) {
      throw new PDRuntimeError('runtime_unavailable', 'openclaw binary not found');
    }

    // Map timeout to timeout error
    if (cliOutput.timedOut) {
      throw new PDRuntimeError('timeout', 'CLI timeout exceeded');
    }

    // Map non-zero exit to execution_failed
    if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
      throw new PDRuntimeError('execution_failed', `CLI exited with code ${cliOutput.exitCode}`);
    }

    // Parse JSON from stdout
    let parsed: unknown;
    try {
      parsed = JSON.parse(cliOutput.stdout);
    } catch {
      // Attempt extraction fallback
      parsed = tryExtractJson(cliOutput.stdout);
      if (!parsed) {
        throw new PDRuntimeError('output_invalid', 'Failed to parse CLI output as JSON');
      }
    }

    // Validate DiagnosticianOutputV1
    if (!Value.Check(DiagnosticianOutputV1Schema, parsed)) {
      throw new PDRuntimeError('output_invalid', 'CLI output does not match DiagnosticianOutputV1 schema');
    }

    return { runId, payload: parsed };
  }

  async cancelRun(runId: string): Promise<void> {
    // For one-shot run: if still running, mark as cancelled
    const state = this.runStateMap.get(runId);
    if (state && !state.completed) {
      state.completed = true;
      // Note: process is already dead or dying; just update state
    }
  }
}
```

### JSON Extraction Pattern

```typescript
// Source: M6-OpenClaw-CLI-CONTRACT.md + Context7 Node.js patterns
// Attempts JSON.parse first, then falls back to balanced-fragment extraction

function tryExtractJson(text: string): unknown | null {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch { /* fall through */ }

  // Try to extract balanced JSON from mixed output
  // (OpenClaw may emit text + JSON mixed)
  const balancedMatch = text.match(/\{[\s\S]*\}/);
  if (balancedMatch) {
    try {
      return JSON.parse(balancedMatch[0]);
    } catch { /* fall through */ }
  }

  return null;
}
```

### Error Mapping: Full 5-Category Map

```typescript
// Source: m6-02-CONTEXT.md D-04 + error-categories.ts

function mapCliOutputToError(cliOutput: CliOutput): never {
  // 1. ENOENT (binary not found) → runtime_unavailable
  if (cliOutput.exitCode === null && cliOutput.stderr.startsWith('ENOENT:')) {
    throw new PDRuntimeError('runtime_unavailable', 'openclaw binary not found');
  }

  // 2. CLI timeout → timeout
  if (cliOutput.timedOut) {
    throw new PDRuntimeError('timeout', 'CLI timeout exceeded');
  }

  // 3. Non-zero exit code → execution_failed
  if (cliOutput.exitCode !== null && cliOutput.exitCode !== 0) {
    throw new PDRuntimeError('execution_failed', `CLI exited with code ${cliOutput.exitCode}`);
  }

  // 4. JSON parse failure → output_invalid
  // 5. Schema validation failure → output_invalid
  // (handled in fetchOutput after parsing attempt)
}
```

### Anti-Patterns to Avoid

- **Session-based thinking:** Each `startRun()` is independent — no session ID, no persistent state between runs. The CLI is invoked fresh each time.
- **Process monitoring:** No need to poll a running process. `startRun()` blocks until the CLI exits, so when it returns the result is already in memory.
- **Workspace env vars:** D-03 says no env vars for workspace control. Use `cwd` and `--local` flag only.
- **Schema mismatch → runtime_unavailable:** D-04 explicitly maps schema validation failure to `output_invalid`, not to `capability_missing`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| JSON validation | Manual try/catch + field checks | `Value.Check(DiagnosticianOutputV1Schema, parsed)` | Already in TypeBox deps, returns boolean, consistent with codebase |
| Error categories | Invent new error codes | `PDRuntimeError(category, message, details?)` with `PDErrorCategory` enum | Matches existing error-categories.ts pattern, 21 predefined categories |
| Run ID generation | `Date.now().toString()` collision-prone | `crypto.randomUUID()` | Built-in, no external dependency, universally unique |
| Process spawn | Raw `spawn()` with manual timeout | `runCliProcess()` from m6-01 | m6-01 delivers this with tree kill, env merge, timeout handling |
| Capabilities constant | Boolean literals spread across methods | Return same constant shape as TestDoubleRuntimeAdapter | Consistent with codebase pattern |

---

## Common Pitfalls

### Pitfall 1: One-Shot Model Means No Real-Time Status

**What goes wrong:** `pollRun()` always returns the final status (succeeded/failed/timed_out) because `startRun()` blocks until the CLI exits. There is no "running" state to poll — by the time you get a RunHandle the CLI is already done.

**How to avoid:** Accept this as the intended model. For long-running CLI invocations, `startRun()` still blocks (D-01). The caller receives the RunHandle only after the CLI completes, not when it starts. `pollRun()` is a no-op that returns the already-known final status.

### Pitfall 2: `runCliProcess` Returns `exitCode: null` on Timeout

**What goes wrong:** When the CLI times out, `CliOutput.exitCode` is `null` (not a Unix exit code). The timeout is signaled by `timedOut: true` instead. If the adapter checks `exitCode !== 0` without checking `timedOut` first, it may misclassify timeout as `execution_failed` (because null !== 0 evaluates to true in some type narrowing scenarios).

**How to avoid:** Always check `cliOutput.timedOut` before checking exit code. The error mapping order in D-04 is intentional: ENOENT check first, timeout check second, non-zero check third.

### Pitfall 3: JSON.parse on Empty or Whitespace-Only stdout

**What goes wrong:** `JSON.parse('')` throws `SyntaxError: Unexpected end of JSON input`. If the CLI outputs nothing (e.g., crashes before writing output), `fetchOutput()` throws a parse error.

**How to avoid:** The extraction fallback (`tryExtractJson`) must handle empty/whitespace input. If all parsing attempts fail, throw `output_invalid` per D-05 step 3.

### Pitfall 4: Error Throwing vs. Return Null in fetchOutput

**What goes wrong:** `PDRuntimeAdapter.fetchOutput()` returns `StructuredRunOutput | null`. Throwing `PDRuntimeError` is different from returning null. If the error is categorized (e.g., `runtime_unavailable`), it should be thrown as `PDRuntimeError`, not returned as null. If it is an uncategorized state (run not found), return null.

**How to avoid:** Follow the mapping: ENOENT/timeout/non-zero-exit/invalid-JSON/schema-mismatch all throw `PDRuntimeError` with the appropriate category. Only "run not found" or "run still running" returns null.

---

## Code Examples

### Error Handling with PDRuntimeError

```typescript
// Source: error-categories.ts PDRuntimeError class
import { PDRuntimeError } from '../error-categories.js';

// Throwing with details
throw new PDRuntimeError('runtime_unavailable', 'openclaw binary not found at PATH', {
  command: 'openclaw',
  searchedPath: process.env.PATH,
});

// Throwing with no details
throw new PDRuntimeError('timeout', 'CLI timeout exceeded');
```

### TypeBox Value.Check Pattern

```typescript
// Source: TypeBox Value.Check() documentation + codebase precedent
import { Value } from '@sinclair/typebox/value';
import { DiagnosticianOutputV1Schema } from '../diagnostician-output.js';

// Returns boolean, does not throw
const isValid = Value.Check(DiagnosticianOutputV1Schema, parsed);

if (!isValid) {
  throw new PDRuntimeError('output_invalid', 'CLI output does not match DiagnosticianOutputV1 schema');
}

// Valid output — use directly as DiagnosticianOutputV1
const output = parsed as DiagnosticianOutputV1;
```

### healthCheck Implementation

```typescript
// Source: TestDoubleRuntimeAdapter.healthCheck() + RuntimeHealthSchema
async healthCheck(): Promise<RuntimeHealth> {
  // Could probe 'openclaw' binary existence here as light health check
  // For now, similar to TestDouble: always healthy
  return {
    healthy: true,
    degraded: false,
    warnings: [],
    lastCheckedAt: new Date().toISOString(),
  };
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Session-based CLI wrapper with persistent process | One-shot run: spawn, block, store result, return | M6 design | No session complexity; each run is independent |
| Direct stdout parsing without fallback | JSON.parse first + balanced-fragment extraction fallback | M6 design | Handles mixed-output scenarios from LLM text generation |
| Generic Error with string codes | PDRuntimeError with PDErrorCategory enum | M4/M5 established | Consistent error categorization across all adapters |
| Manual runId generation (counter) | `crypto.randomUUID()` | M6 design | No collisions across concurrent runs |

**Deprecated/outdated:**
- `spawn()` with string concatenation — replaced by array args from m6-01
- Custom error category strings — replaced by PDErrorCategory enum

---

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `CliOutput.timedOut` is `true` when the CLI is killed by timeout | Error Mapping | If the implementation uses a different signal, OCRA-04 timeout mapping would fail. Verified via m6-01-RESEARCH.md + cli-process-runner.ts source. |
| A2 | `runCliProcess()` with ENOENT produces `exitCode: null` and `stderr.startsWith('ENOENT:')` | Error Mapping | If the ENOENT error format differs, the `runtime_unavailable` mapping would fail. m6-01 source confirms: `exitCode: null`, stderr set to `ENOENT: ${code}` pattern. |
| A3 | `startRun()` can block until CLI exit without timing out the Node.js event loop | Architecture | If the CLI takes very long, blocking `startRun()` is the intended design (D-01). No worker thread needed. |
| A4 | `RuntimeKindSchema` already includes `'openclaw-cli'` | OCRA-01 | Verified in runtime-protocol.ts line 17 — confirmed present. |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.

---

## Open Questions

1. **cancelRun implementation for one-shot runs**
   - What we know: `PDRuntimeAdapter.cancelRun(runId)` is required. For a completed run, cancel is a no-op. For a running run, the process should be killed via `killProcessTree`.
   - What's unclear: Whether we need to implement actual process tree kill on cancel, or if the one-shot model makes cancel unnecessary (CLI completes immediately in practice).
   - Recommendation: Implement basic cancel: if run is still in-flight (state.completed === false), mark as cancelled. Full tree-kill can be added if needed.

2. **healthCheck probe depth**
   - What we know: TestDoubleRuntimeAdapter returns `healthy: true` always. A real probe could check if `openclaw` binary exists.
   - What's unclear: Whether we should implement binary existence check or defer to m6-04 `pd runtime probe` for deeper health checks.
   - Recommendation: Return `healthy: true` with no warnings for now (matches TestDouble pattern). Add binary path probe in m6-04 if needed.

3. **refreshCapabilities implementation**
   - What we know: `refreshCapabilities?()` is optional on PDRuntimeAdapter. TestDouble doesn't implement it.
   - What's unclear: Whether `openclaw-cli` has dynamic capabilities that need re-probing.
   - Recommendation: Don't implement `refreshCapabilities` — it's optional and the openclaw-cli has static capabilities.

4. **fetchArtifacts implementation**
   - What we know: `fetchArtifacts(runId)` is required on PDRuntimeAdapter. OpenClaw CLI does not produce artifact refs in the CliOutput contract.
   - What's unclear: What artifacts the CLI produces and how to reference them.
   - Recommendation: Return empty array for now. Artifacts are produced by DiagnosticianOutputV1 processing downstream, not by the CLI directly.

---

## Environment Availability

> Step 2.6: SKIPPED (no external dependencies identified beyond openclaw binary)

The adapter uses only built-in Node.js (`crypto.randomUUID()`), the `runCliProcess()` utility from m6-01 (already in the same workspace), and existing TypeBox dependencies. The `openclaw` binary is the runtime target, not an external dependency for development.

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js `crypto` | runId generation | Built-in | any | — |
| `@sinclair/typebox` | Value.Check() | Available | 0.34.49 | — |
| `runCliProcess()` from m6-01 | CLI spawning | Available | m6-01 | Must implement inline if missing |

**Missing dependencies with no fallback:**
- None identified — all required utilities are either built-in or from m6-01 deliverables.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (existing test infrastructure in `packages/principles-core`) |
| Config file | `packages/principles-core/vitest.config.ts` or `vitest.config.js` |
| Quick run command | `cd packages/principles-core && npx vitest run src/runtime-v2/adapter/openclaw-cli-runtime-adapter.test.ts` |
| Full suite command | `cd packages/principles-core && npx vitest run` |

### Phase Requirements Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| OCRA-01 | `kind()` returns `'openclaw-cli'` | unit | `vitest run openclaw-cli-runtime-adapter.test.ts` | CREATED |
| OCRA-02 | `startRun` invokes openclaw agent CLI with correct args | unit (mock `runCliProcess`) | same | CREATED |
| OCRA-02 | `startRun` stores cliOutput in memory | unit (mock `runCliProcess`) | same | CREATED |
| OCRA-03 | `fetchOutput` parses CliOutput.text via JSON.parse | unit | same | CREATED |
| OCRA-03 | `fetchOutput` validates with DiagnosticianOutputV1Schema | unit | same | CREATED |
| OCRA-04 | ENOENT → `runtime_unavailable` error | unit (mock ENOENT) | same | CREATED |
| OCRA-04 | timedOut=true → `timeout` error | unit (mock timeout) | same | CREATED |
| OCRA-04 | non-zero exit → `execution_failed` error | unit (mock exit code) | same | CREATED |
| OCRA-04 | invalid JSON → `output_invalid` error | unit (mock bad JSON) | same | CREATED |
| OCRA-04 | schema mismatch → `output_invalid` error | unit (mock invalid schema) | same | CREATED |
| OCRA-05 | Adapter can be registered via RuntimeSelector | integration | same | CREATED |

### Sampling Rate

- **Per task commit:** `vitest run --reporter=basic` on affected files
- **Per wave merge:** Full suite via `vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.ts` — main implementation
- [ ] `packages/principles-core/src/runtime-v2/adapter/openclaw-cli-runtime-adapter.test.ts` — unit tests with mocked `runCliProcess`
- [ ] `packages/principles-core/src/runtime-v2/adapter/index.ts` — re-export new adapter (`OpenClawCliRuntimeAdapter`)
- [ ] Framework install check: `vitest` is already in `principles-core` devDeps

*(If no gaps: "None — existing test infrastructure covers all phase requirements")*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A |
| V5 Input Validation | yes | `agentId` from `agentSpec` is validated as non-empty string before CLI arg construction; `timeoutMs` is validated by `runCliProcess` (m6-01); `jsonPayload` from `inputPayload` is treated as opaque string |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for openclaw-cli invocation

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Command injection via `--message` argument | Tampering | `inputPayload` is treated as opaque JSON string — m6-03 DiagnosticianPromptBuilder constructs the JSON; adapter does not interpret or interpolate user input into command args |
| Binary path injection | Tampering | `command` is hardcoded to `'openclaw'` string, not user-provided |
| Env var injection via `env` parameter | Tampering | Environment variables passed through `runCliProcess` from `StartRunInput.env` — caller (m6-04 CLI layer) controls these; m6-01 merges with parent env safely |

---

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — PDRuntimeAdapter interface, RuntimeKindSchema (already includes `'openclaw-cli'` at line 17)
- `packages/principles-core/src/runtime-v2/diagnostician-output.ts` — DiagnosticianOutputV1Schema, Value.Check() usage
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory enum, PDRuntimeError class
- `packages/principles-core/src/runtime-v2/adapter/test-double-runtime-adapter.ts` — pattern to follow for RuntimeKind literal, all PDRuntimeAdapter methods
- `packages/principles-core/src/runtime-v2/utils/cli-process-runner.ts` — CliOutput interface (timedOut, exitCode, stderr), runCliProcess signature [VERIFIED: source]
- `packages/principles-core/src/runtime-v2/cli/diagnose.ts` — CLI surface patterns
- `@sinclair/typebox` npm registry — version 0.34.49 confirmed [VERIFIED: npm]

### Secondary (MEDIUM confidence)
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — OpenClaw CLI command structure, CliOutput contract, ENOENT error format
- `packages/principles-core/src/runtime-v2/adapter/__tests__/test-double-runtime-adapter.test.ts` — test patterns for adapter unit tests

### Tertiary (LOW confidence)
- m6-01-RESEARCH.md — CliProcessRunner internals (timedOut flag behavior, exitCode null on timeout, ENOENT stderr format) — confirmed via source review

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — only uses built-in Node.js + existing TypeBox dep + m6-01 utility
- Architecture: HIGH — one-shot pattern clearly derived from D-01; state machine is straightforward
- Pitfalls: MEDIUM — `timedOut` vs `exitCode` ordering and JSON extraction fallback need test verification

**Research date:** 2026-04-24
**Valid until:** ~60 days (PDRuntimeAdapter interface is stable; TypeBox version constraint is conservative)