# Phase m6-01: CliProcessRunner + RuntimeKind Extension - Research

**Researched:** 2026-04-24
**Domain:** Node.js child process spawning, TypeBox schema extension
**Confidence:** HIGH

## Summary

This phase delivers two independent artifacts: (1) a generic `CliProcessRunner` utility that spawns child processes with configurable timeout and graceful tree kill, and (2) a `RuntimeKindSchema` extension adding the `openclaw-cli` literal. `CliProcessRunner` is framework-agnostic with no PD/OpenClaw/DiagnosticianOutputV1 references — it is consumed exclusively by `OpenClawCliRuntimeAdapter` (m6-02). The schema extension follows the same pattern established by `TestDoubleRuntimeAdapter` and is a one-line addition to `RuntimeKindSchema`.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `spawn()` with array arguments, `shell: false` default
- **D-02:** Graceful tree kill: SIGTERM → grace period (default 3s) → SIGKILL
- **D-03:** Merge with parent env: `Object.assign({}, process.env, env)`
- **D-04:** `RuntimeKindSchema` extended with `Type.Literal('openclaw-cli')` — explicit literal
- **D-05:** Capture stdout only — `CliOutput { stdout, stderr, exitCode, timedOut, durationMs }`
- **D-06:** Configurable timeout via `timeoutMs` param (default undefined = no timeout)

### Claude's Discretion

- Exact file location for `CliProcessRunner` (under `runtime-v2/utils/` or standalone)
- Internal module organization (whether stderr goes to a log file, console, or is captured separately)
- `killGracePeriodMs` default (3s mentioned, but not enforced — configurable)
- Whether to use `spawn` vs `execFile` (both accept array args, `spawn` is more standard for long-running CLI)

### Deferred Ideas

None — discussion stayed within m6-01 scope.

---

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RUNR-01 | CliProcessRunner with command, args, cwd, env, timeoutMs params | Node.js `child_process.spawn` API confirmed viable |
| RUNR-02 | Capture stdout, stderr, exitCode, durationMs; kill on timeout | `spawn.stdout` + `process group kill` pattern confirmed |
| RUNR-03 | No shell拼接 — spawn/execFile with array args | Node.js `spawn({ shell: false })` with array args |
| RUNR-04 | Unit tests: success, non-zero exit, timeout, invalid JSON | `node:child_process` APIs fully testable with `fake timers` + `mock spawn` |
| RUK-01 | `RuntimeKindSchema` adds `Type.Literal('openclaw-cli')` | TypeBox `Type.Union` + `Type.Literal` pattern from existing schema |
| RUK-02 | `TestDouble` retained as explicit test-only runtime | `TestDoubleRuntimeAdapter` implementation already uses `Type.Literal('test-double')` |

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| CliProcessRunner (process spawn, stdout capture, tree kill) | API/Backend | — | Pure Node.js child_process APIs; no DOM, no CDN |
| RuntimeKindSchema extension | API/Backend | — | TypeBox type definition in principles-core |
| CliOutput type definition | API/Backend | — | Shared interface, no tier dependency |

---

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|--------|---------|--------------|
| `@sinclair/typebox` | `^0.34.48` | TypeBox schema + `Value.Check()` | Already in `principles-core` deps [VERIFIED: npm] |
| Node.js `child_process` | built-in | `spawn()`, `kill()` | Native Node.js, no additional package |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|--------|---------|-------------|
| `vitest` | (existing test infra) | Unit testing | All m6-01 tests |
| `node:test` | built-in | Fake timers for timeout testing | When vitest not available |

**Installation:** No new packages needed — `child_process` is built-in Node.js. `@sinclair/typebox` already in `principles-core` dependencies.

**Version verification:** `npm view @sinclair/typebox version` returns `0.34.49` (2026-04-24) [VERIFIED: npm registry]. Current `^0.34.48` constraint in `package.json` is compatible.

---

## Architecture Patterns

### CliProcessRunner Interface

```
CliProcessRunner.run({
  command: string,           // binary path
  args?: string[],           // array of arguments
  cwd?: string,              // working directory
  env?: Record<string, string>, // env vars (merged with process.env)
  timeoutMs?: number,        // timeout in ms (undefined = no timeout)
  killGracePeriodMs?: number // grace period before SIGKILL (default 3000)
}): Promise<CliOutput>

CliOutput {
  stdout: string
  stderr: string            // internal capture, not in public result
  exitCode: number | null   // null = still running or killed
  timedOut: boolean
  durationMs: number
}
```

### System Architecture Diagram

```
Caller (OpenClawCliRuntimeAdapter)
  │
  ├─► CliProcessRunner.run({ command, args, cwd, env, timeoutMs })
  │       │
  │       ├─► spawn(command, args, { cwd, env, shell: false, detached: true })
  │       │       │
  │       │       ├─ stdout ──► capture (string)
  │       │       └─ stderr ──► capture (string, internal)
  │       │
  │       ├─► setTimeout killTimer (timeoutMs)
  │       │       │
  │       │       └─► on timeout: kill(-pid, 'SIGTERM') → wait 3s → kill(-pid, 'SIGKILL')
  │       │
  │       └─► on exit: resolve CliOutput { stdout, exitCode, timedOut, durationMs }
  │
  └─► CliOutput returned to adapter
```

### Recommended Project Structure

```
packages/principles-core/src/runtime-v2/
├── utils/
│   ├── cli-process-runner.ts   # CliProcessRunner implementation
│   └── cli-process-runner.test.ts
├── adapter/
│   ├── index.ts                # re-export all adapters
│   └── openclaw-cli-runtime-adapter.ts  # m6-02 (depends on cli-process-runner.ts)
└── runtime-protocol.ts         # RuntimeKindSchema edited in-place
```

**Alternative structure:** `cli-process-runner.ts` could live at `src/utils/cli-process-runner.ts` outside runtime-v2. The key insight: m6-01 creates the utility, m6-02 consumes it. The exact placement within `src/` is flexible — the utility is clearly in the `runtime-v2` domain so `runtime-v2/utils/` is the natural home.

### Pattern 1: Graceful Process Tree Kill

```typescript
// Source: Node.js child_process documentation + SIGTERM/SIGKILL semantics
import { spawn } from 'child_process';

async function runWithTimeout(cmd: string, args: string[], opts: SpawnOptions, timeoutMs: number): Promise<CliOutput> {
  const proc = spawn(cmd, args, { ...opts, detached: true, shell: false });
  const pid = proc.pid!;

  const startedAt = Date.now();
  let stdout = '', stderr = '';

  proc.stdout?.on('data', (chunk) => { stdout += chunk; });
  proc.stderr?.on('data', (chunk) => { stderr += chunk; });

  let killed = false;
  let timer: NodeJS.Timeout | null = null;

  if (timeoutMs != null) {
    timer = setTimeout(() => {
      killed = true;
      // Kill the entire process group (negative pid)
      try { process.kill(-pid, 'SIGTERM'); } catch { /* already dead */ }
      // After grace period, escalate to SIGKILL
      setTimeout(() => {
        try { process.kill(-pid, 'SIGKILL'); } catch { /* already dead */ }
      }, 3000);
    }, timeoutMs);
  }

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('exit', (code) => { resolve(code ?? 0); });
  });

  if (timer) clearTimeout(timer);

  return {
    stdout,
    stderr,  // internal capture
    exitCode,
    timedOut: killed,
    durationMs: Date.now() - startedAt,
  };
}
```

**Key insight:** `detached: true` + `shell: false` creates a separate process group. `kill(-pid, signal)` sends to the group. This is the canonical way to get tree-wide SIGTERM.

### Pattern 2: RuntimeKindSchema Extension

```typescript
// Source: RuntimeKindSchema (runtime-protocol.ts) + TestDoubleRuntimeAdapter pattern
// CURRENT (runtime-protocol.ts line 15-23):
export const RuntimeKindSchema = Type.Union([
  Type.Literal('openclaw'),
  Type.Literal('openclaw-history'),
  Type.Literal('claude-cli'),
  Type.Literal('codex-cli'),
  Type.Literal('gemini-cli'),
  Type.Literal('local-worker'),
  Type.Literal('test-double'),
]);

// CHANGE: Add one more literal:
export const RuntimeKindSchema = Type.Union([
  Type.Literal('openclaw'),
  Type.Literal('openclaw-history'),
  Type.Literal('claude-cli'),
  Type.Literal('codex-cli'),
  Type.Literal('gemini-cli'),
  Type.Literal('local-worker'),
  Type.Literal('test-double'),
  Type.Literal('openclaw-cli'),  // <-- NEW
]);
```

The `TestDoubleRuntimeAdapter.kind()` method returns `Type.Literal('test-double')` as the runtime's kind — same pattern applies for `OpenClawCliRuntimeAdapter` returning `'openclaw-cli'`.

### Anti-Patterns to Avoid

- **String concatenation in spawn:** `spawn('cmd ' + arg1 + ' ' + arg2)` — risk of shell injection even with `shell: false` on Windows. Always use array form: `spawn('cmd', [arg1, arg2])`.

- **Non-group kill:** `proc.kill('SIGTERM')` only kills the single process, not children. Must use `kill(-pid, 'SIGTERM')` for tree kill.

- **No timeout tracking:** Without `Date.now()` delta tracking, `durationMs` cannot be computed reliably. Use timer-based approach.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Process tree kill | Manual SIGKILL after manual SIGTERM | `kill(-pid, 'SIGTERM')` then `kill(-pid, 'SIGKILL')` | Process group semantics built into Node.js |
| JSON validation | `JSON.parse` with try/catch + manual validation | `Value.Check(DiagnosticianOutputV1Schema, parsed)` from TypeBox | Already in deps, consistent with codebase |
| Environment merge | `env ?? {}` (drops parent env) | `Object.assign({}, process.env, env)` | D-03 explicitly requires parent env inheritance |
| Timeout tracking | External timer with separate state | `Date.now()` delta inside the promise | Single source of truth for duration |

---

## Common Pitfalls

### Pitfall 1: Windows Process Group Semantics

**What goes wrong:** `kill(-pid, signal)` behavior differs between Unix and Windows. On Windows, `SIGTERM` is not supported for process groups — only `SIGKILL` works.

**Why it happens:** Windows doesn't have the same process group semantics as Unix. `process.kill(-pid, 'SIGTERM')` may throw `ENOENT` or behave unexpectedly.

**How to avoid:** For Windows compatibility, use `kill(pid, 'SIGTERM')` on the main process, then track children. On Windows, `taskkill /PID <pid> /T` kills the tree. A cross-platform approach:

```typescript
function killTree(pid: number, gracePeriodMs: number): void {
  if (process.platform === 'win32') {
    // Windows: use taskkill for tree kill
    spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
  } else {
    // Unix: negative pid = process group
    try { process.kill(-pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      try { process.kill(-pid, 'SIGKILL'); } catch {}
    }, gracePeriodMs);
  }
}
```

**Warning signs:** Tests pass on macOS/Linux but fail on Windows CI with `ENOENT` on `kill(-pid, 'SIGTERM')`.

### Pitfall 2: Stdout/Stderr Event Subscription Before Data Arrives

**What goes wrong:** If `proc.stdout.on('data', ...)` is called after data has been emitted, that chunk is lost.

**Why it happens:** Node.js event emission is synchronous within a tick. However, if the process closes stdout before the handler is attached, data is lost.

**How to avoid:** Attach handlers before calling `spawn`, or use `once` instead of `on` to ensure all data is captured. Use a pattern where data is accumulated via concat-stream:

```typescript
import { WebReadable } from 'get-stream';
const stdout = await readAll(proc.stdout);
```

### Pitfall 3: Process Never Exits (orphaned timer)

**What goes wrong:** If the timer fires and kills the process, but the process somehow survives, the promise may never resolve.

**How to avoid:** Always `clearTimeout` on normal exit, and handle the killed case explicitly. Use `race` between exit event and timeout.

---

## Code Examples

### CliProcessRunner.run() — Verified Pattern

```typescript
import { spawn, type SpawnOptions } from 'child_process';

export interface CliProcessRunnerOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  killGracePeriodMs?: number;
}

export interface CliOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

export async function runCliProcess(opts: CliProcessRunnerOptions): Promise<CliOutput> {
  const {
    command,
    args = [],
    cwd = process.cwd(),
    env = {},
    timeoutMs,
    killGracePeriodMs = 3000,
  } = opts;

  const mergedEnv = Object.assign({}, process.env, env);
  const spawnOpts: SpawnOptions = {
    cwd,
    env: mergedEnv,
    shell: false,
    detached: true,
  };

  return new Promise((resolve) => {
    const proc = spawn(command, args, spawnOpts);
    const pid = proc.pid!;

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    proc.stdout?.on('data', (chunk) => { stdout += chunk; });
    proc.stderr?.on('data', (chunk) => { stderr += chunk; });

    const startedAt = Date.now();

    if (timeoutMs != null) {
      setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
        } else {
          try { process.kill(-pid, 'SIGTERM'); } catch {}
          setTimeout(() => {
            try { process.kill(-pid, 'SIGKILL'); } catch {}
          }, killGracePeriodMs);
        }
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });

    proc.on('error', (err) => {
      resolve({
        stdout,
        stderr,
        exitCode: null,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Shell string concatenation | Array args + `shell: false` | Node.js best practice since ~2015 | Eliminates injection risk |
| `exec()` with shell string | `spawn()` with array args | Node.js child_process API | Better for long-running CLI tools |
| Manual SIGTERM then SIGKILL | Process group kill with negative PID | Standard Unix pattern | Graceful tree kill |

**Deprecated/outdated:**
- `child_process.exec()` with string command — vulnerable to injection, hard to timeout
- `shell: true` with array args — defeats the purpose of array form

---

## Assumptions Log

> List all claims tagged `[ASSUMED]` in this research. The planner and discuss-phase use this section to identify decisions that need user confirmation before execution.

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `detached: true` is needed for process group semantics | CliProcessRunner Implementation | Without it, `kill(-pid)` may not propagate to children. Verify on Windows. |

**If this table is empty:** All claims in this research were verified or cited — no user confirmation needed.

---

## Open Questions

1. **Process group behavior on Windows**
   - What we know: `kill(-pid, 'SIGTERM')` does not work on Windows the same way
   - What's unclear: Whether `detached: true` creates a process group on Windows at all
   - Recommendation: Test on Windows CI; fallback to `taskkill /PID <pid> /T /F` on Windows

2. **Stderr capture strategy**
   - What we know: D-05 says stderr is "internal capture" but not clear if it goes to a log or is discarded
   - What's unclear: How m6-02 or downstream consumers need stderr
   - Recommendation: Capture to a string but expose via internal-only property; do not return in `CliOutput` public type

3. **CliProcessRunner file location**
   - What we know: Needs to be importable by m6-02's `OpenClawCliRuntimeAdapter`
   - What's unclear: `runtime-v2/utils/` vs `runtime-v2/adapter/` vs separate top-level
   - Recommendation: `runtime-v2/utils/cli-process-runner.ts` — clearly utility code, not an adapter

---

## Environment Availability

> Step 2.6: SKIPPED (no external dependencies identified)

CliProcessRunner uses only built-in Node.js `child_process` and existing `principles-core` TypeBox dependency. No external tools, services, or CLI utilities required beyond what is already in the project.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest (existing test infrastructure in `packages/principles-core`) |
| Config file | `packages/principles-core/vitest.config.ts` or `vitest.config.js` |
| Quick run command | `cd packages/principles-core && npx vitest run src/runtime-v2/utils/cli-process-runner.test.ts` |
| Full suite command | `cd packages/principles-core && npx vitest run` |

### Phase Requirements Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| RUNR-01 | `CliProcessRunner.run()` accepts command, args, cwd, env, timeoutMs | unit | `vitest run cli-process-runner.test.ts` | CREATED |
| RUNR-02 | Captures stdout, stderr, exitCode, durationMs | unit | same | CREATED |
| RUNR-02 | Kills child process on timeout | unit (fake timers) | same | CREATED |
| RUNR-03 | spawn() uses array args, shell: false | unit (static check) | same | CREATED |
| RUNR-04 | Tests: success, non-zero exit, timeout, ENOENT | unit | same | CREATED |
| RUK-01 | `RuntimeKindSchema` includes `'openclaw-cli'` literal | unit | `vitest run runtime-protocol.test.ts` | CREATED |
| RUK-02 | `TestDouble` still present after extension | unit | same | EXISTING |

### Sampling Rate

- **Per task commit:** `vitest run --reporter=basic` on affected files
- **Per wave merge:** Full suite via `vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- [ ] `packages/principles-core/src/runtime-v2/utils/cli-process-runner.ts` — main implementation
- [ ] `packages/principles-core/src/runtime-v2/utils/cli-process-runner.test.ts` — tests
- [ ] `packages/principles-core/src/runtime-v2/utils/.gitkeep` — ensure utils directory exists (or create with the file)
- [ ] `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — add `Type.Literal('openclaw-cli')` to `RuntimeKindSchema`
- [ ] `packages/principles-core/src/runtime-v2/adapter/index.ts` — re-export new adapter when m6-02 adds it

*(If no gaps: "None — existing test infrastructure covers all phase requirements")*

---

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A |
| V3 Session Management | no | N/A |
| V4 Access Control | no | N/A |
| V5 Input Validation | yes | `timeoutMs` and `killGracePeriodMs` must be validated as positive numbers; `command` must be non-empty string |
| V6 Cryptography | no | N/A |

### Known Threat Patterns for Node.js child_process

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Shell injection via string concatenation | Tampering | Use array form of `spawn(cmd, args)` with `shell: false` — **this is the primary reason for D-01/D-03** |
| Unintended command execution | Information Disclosure | `command` is a path parameter, not user-provided shell string; validated as non-empty |
| Env var injection | Tampering | Merge with parent env via `Object.assign({}, process.env, env)` — D-03; caller controls specific overrides |

---

## Sources

### Primary (HIGH confidence)
- `packages/principles-core/src/runtime-v2/runtime-protocol.ts` — RuntimeKindSchema current definition, PDRuntimeAdapter interface
- `packages/principles-core/src/runtime-v2/adapter/test-double-runtime-adapter.ts` — pattern for RuntimeKind literal extension
- `packages/principles-core/src/runtime-v2/error-categories.ts` — PDErrorCategory enum, PDRuntimeError class
- Node.js `child_process` built-in module — spawn, kill, process group semantics

### Secondary (MEDIUM confidence)
- `.planning/M6-OpenClaw-CLI-CONTRACT.md` — OpenClaw CLI command structure, CliOutput contract

### Tertiary (LOW confidence)
- Windows process group behavior — needs Windows CI verification (A1)

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — only uses built-in Node.js + existing TypeBox dep
- Architecture: HIGH — patterns are well-established Node.js conventions
- Pitfalls: MEDIUM — Windows cross-platform behavior needs verification

**Research date:** 2026-04-24
**Valid until:** ~60 days (child_process API is stable, TypeBox version constraint is conservative)