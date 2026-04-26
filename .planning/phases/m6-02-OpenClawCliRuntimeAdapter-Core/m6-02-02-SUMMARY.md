---
phase: m6-02
plan: "02"
subsystem: runtime-v2/adapter
tags: [runtime-v2, adapter, test, vitest, OCRA-01, OCRA-02, OCRA-03, OCRA-04]
requires: [OCRA-01, OCRA-02, OCRA-03, OCRA-04]
provides: [openclaw-cli-runtime-adapter.test.ts]
affects: []
tech_stack:
  added: [vitest, vi.mock]
  patterns: [mock-based unit tests, 5-category error simulation]
key_files:
  created:
    - packages/principles-core/src/runtime-v2/adapter/__tests__/openclaw-cli-runtime-adapter.test.ts
  modified:
    - packages/principles-core/vitest.config.ts
key_decisions:
  - "vi.mock() mocks runCliProcess so tests run without real openclaw binary"
  - "Test located at src/runtime-v2/adapter/__tests__/ to match existing test-double test pattern"
  - "Import paths use ../../utils/ and ../../error-categories.js from __tests__/ subdirectory"
  - "vitest.config.ts include updated to 'src/runtime-v2/adapter/**/*.test.ts'"
requirements_completed: [OCRA-01, OCRA-02, OCRA-03, OCRA-04]
duration: ~
completed: "2026-04-24"
---

# Phase m6-02 Plan 02: OpenClawCliRuntimeAdapter Unit Tests

**Substantive:** 19-unit test suite for OpenClawCliRuntimeAdapter covering all OCRA requirements with mocked runCliProcess.

## What Was Built

`packages/principles-core/src/runtime-v2/adapter/__tests__/openclaw-cli-runtime-adapter.test.ts` — 351 lines, 19 test cases:

| Group | Tests | Coverage |
|-------|-------|----------|
| kind() | 1 | OCRA-01 |
| startRun() | 4 | OCRA-02 |
| fetchOutput() | 2 | OCRA-03 |
| fetchOutput() error mapping | 5 | OCRA-04 (all 5 categories) |
| pollRun() | 3 | status mapping |
| getCapabilities() | 1 | interface |
| healthCheck() | 1 | interface |
| cancelRun() | 1 | interface |
| fetchArtifacts() | 1 | interface |

## Test Cases Detail

**OCRA-01:** kind() returns 'openclaw-cli'
**OCRA-02:** startRun() calls runCliProcess with command='openclaw', args include --agent/--message/--json/--local/--timeout; default agentId='diagnostician'; timeoutMs converted to seconds
**OCRA-03:** fetchOutput() parses valid DiagnosticianOutputV1; extracts JSON from mixed text+JSON output
**OCRA-04:** runtime_unavailable (ENOENT), timeout (timedOut), execution_failed (non-zero), output_invalid (bad JSON), output_invalid (schema mismatch)

## Verification

- `npx vitest run openclaw-cli-runtime-adapter.test.ts` — 19/19 passed ✓
- `grep "runtime_unavailable" test` — ENOENT case ✓
- `grep "timeout" test` — timedOut case ✓
- `grep "execution_failed" test` — non-zero exit case ✓
- `grep "output_invalid" test` — JSON parse + schema mismatch cases ✓
- `grep "kind.*openclaw-cli" test` — kind() test ✓
- `grep "runCliProcess.*mock" test` — vi.mock() ✓

## File Placement Note

Test placed in `__tests__/` subdirectory (alongside `test-double-runtime-adapter.test.ts`) because vitest include pattern only covered `tests/**/*.test.ts` and `src/runtime-v2/{store,runner,utils}/**/*.test.ts`. Import paths corrected to `../../utils/` and `../../error-categories.js`.

## Next

Ready for m6-02-03 (export from adapter/index.ts).
