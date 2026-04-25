---
phase: m6-06-E2E-Verification
reviewed: 2026-04-25T00:00:00Z
depth: standard
files_reviewed: 3
files_reviewed_list:
  - packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-e2e.test.ts
  - packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-real-path.test.ts
  - packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-legacy.test.ts
findings:
  critical: 0
  warning: 2
  info: 1
  total: 3
status: issues_found
---

# Phase m6-06: Code Review Report

**Reviewed:** 2026-04-25T00:00:00Z
**Depth:** standard
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Reviewed the three E2E verification test files. No critical security vulnerabilities or logic bugs found. The test patterns are sound and follow established project conventions. Two warnings and one info item were identified, all related to test robustness.

---

## Warnings

### WR-01: E2EV-05 / E2EV-06 use early return when openclaw unavailable (test passes vacuously)

**File:** `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-real-path.test.ts:228-301` (E2EV-05), `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-real-path.test.ts:307-389` (E2EV-06)

**Issue:** Both tests return early when `openclawAvailable === false`, outputting blocked evidence to console.log and returning without a test failure. While this is intentional (per test design philosophy "never fake success"), it means the assertions in these tests are never executed in environments where openclaw is not installed. A developer running tests locally without openclaw would see all tests pass (green), not knowing they are vacuous.

**Fix:** Consider using `test.skip()` with a descriptive message so the test appears as "skipped" rather than "passed", making it clear the test did not run:

```typescript
it('E2EV-05: context build produces valid DiagnosticianContextPayload', async () => {
  if (!openclawAvailable) {
    test.skip('openclaw binary not available — E2EV-05 blocked');
    return;
  }
  // ... rest of test
});
```

Alternatively, consider marking these integration tests explicitly so they are excluded from normal `npm run test` runs and only run in CI environments where openclaw is guaranteed to be present.

---

### WR-02: E2EV-07 iterates candidates unconditionally after early-return seed

**File:** `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-real-path.test.ts:471-494`

**Issue:** The for-of loop at lines 471-479 iterates `listData.candidates` unconditionally, but the subsequent `if` block (lines 482-494) that accesses `listData.candidates[0].artifactId` is inside a separate guard. This is not a bug (the guard correctly prevents an out-of-bounds access), but the structure is confusing — the loop body validates every candidate but the artifact show command depends on a separate length check after the loop. If the loop had side effects or if a future developer added a candidate access before the guard, this would break.

**Fix:** Move the artifact show logic into the loop or under the same guard:

```typescript
if (listData.candidates.length > 0) {
  const firstCandidate = listData.candidates[0]!;
  expect(firstCandidate.candidateId).toBeDefined();
  expect(typeof firstCandidate.candidateId).toBe('string');
  expect(firstCandidate.candidateId.length).toBeGreaterThan(0);

  expect(firstCandidate.description).toBeDefined();
  expect(typeof firstCandidate.description).toBe('string');
  expect(firstCandidate.description.length).toBeGreaterThan(0);

  const showResult = await runPdCli(
    ['artifact', 'show', firstCandidate.artifactId, '--workspace', ws, '--json'],
    ws,
  );
  // ...
}
```

---

## Info

### IN-01: `testWorkspace` variable is set but never used

**File:** `packages/principles-core/src/runtime-v2/runner/__tests__/m6-06-real-path.test.ts:103`

**Issue:** At line 103, `testWorkspace` is declared as an empty string module-level variable. It is never assigned a non-empty value. All `runPdCli` calls in the test file either pass `ws` directly (the temporary workspace created per-test) or pass `testWorkspace` (which is always `''`). This is not causing incorrect behavior, but the variable is dead code and suggests an incomplete refactoring.

**Fix:** Either remove the variable, or if future tests need a shared persistent workspace, implement the intended assignment in `beforeAll` after checking openclaw availability.

---

_Reviewed: 2026-04-25T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
