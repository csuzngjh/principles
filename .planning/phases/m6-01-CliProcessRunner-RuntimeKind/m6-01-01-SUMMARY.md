# m6-01-01 Summary: CliProcessRunner

## Objective

Create CliProcessRunner utility — generic child process runner with timeout, graceful tree kill, env merge, and no shell injection.

## Files Created/Modified

### packages/principles-core/src/runtime-v2/utils/cli-process-runner.ts
- **Status**: CREATED (commit 65ae46c6)
- **Lines**: ~172
- **Exports**: `CliProcessRunnerOptions`, `CliOutput`, `runCliProcess()`

### packages/principles-core/src/runtime-v2/utils/cli-process-runner.test.ts
- **Status**: CREATED (commit 004ae5d3)
- **Lines**: 89
- **7 tests**: success (exit 0), non-zero exit (42), timeout (timedOut=true, exitCode=null), ENOENT, validation (empty/whitespace/non-string command)

### packages/principles-core/vitest.config.ts
- **Status**: MODIFIED (commit 4d774cad)
- **Change**: Added `'src/runtime-v2/utils/**/*.test.ts'` to vitest include array

## Requirements Verified

| Requirement | Status | Evidence |
|-------------|--------|----------|
| RUNR-01: No shell injection | PASS | `spawn(command, args, { shell: false })` — grep line 62 |
| RUNR-02: Graceful tree kill | PASS | SIGTERM then SIGKILL after grace period; Windows uses `taskkill /PID /T /F` — grep lines 89,93,124 |
| RUNR-03: Env merge | PASS | `Object.assign({}, process.env, opts.env ?? {})` — line 52 |
| RUNR-04: CliOutput capture | PASS | `{ stdout, stderr, exitCode, timedOut, durationMs }` returned |

## Test Results

```
Test Files  1 passed (1)
     Tests  7 passed (7)
  Duration  368ms
```

## Key Implementation Details

- `detached: true` set on spawn for process group semantics (needed for `kill -pid` on Unix)
- `timedOut` flag set in timeout callback, consulted in close/error handlers to override result correctly
- `exitCode: timedOut ? null : code` — when killed by timeout, exitCode is null per CliOutput contract
- `killGracePeriodMs` defaults to 3000ms
- Input validation throws `TypeError` for empty/whitespace/non-string command

## Commits

1. `65ae46c6` — feat(runtime-v2): add CliProcessRunner utility
2. `004ae5d3` — test(runtime-v2): add CliProcessRunner unit tests
3. `4d774cad` — chore(test): include utils/**/*.test.ts in vitest include
