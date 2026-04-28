---
status: all_fixed
phase: m8-02
findings_in_scope: 4
fixed: 4
skipped: 0
iteration: 1
---

# Phase m8-02: Code Review Fix Report

**Fixed at:** 2026-04-28T00:00:00Z
**Source review:** .planning/phases/m8-02-Pain-Signal-Bridge-E2E/m8-02-REVIEW.md
**Iteration:** 1

**Summary:**
- Findings in scope: 4 (WR-01, WR-02, WR-03, WR-04)
- Fixed: 4
- Skipped: 0

## Fixed Issues

### WR-01: No lease-expiry recovery for crashed runner leaves task permanently leased

**Files modified:** `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts`
**Commit:** 0ec6e695
**Applied fix:** Added lease expiry check inside the `status === 'leased'` branch. When a leased task is found, the bridge now checks `leasedAt` against `LEASE_TTL_MS` (300_000 ms / 5 minutes, matching the DiagnosticianRunner timeoutMs). If the lease has expired, execution falls through to reset the task to `pending` and re-run. Only genuine in-flight leases (status=leased AND not expired) return immediately (SKIP path).

### WR-02: Profile JSON parsed twice per failure event

**Files modified:** `packages/openclaw-plugin/src/hooks/pain.ts`
**Commit:** 87941dd9
**Applied fix:** Consolidated profile loading into a single block near the top of `handleAfterToolCall` (lines 220-231), with a 1MB size guard (see WR-03). Removed the duplicate `profilePath` / `fs.existsSync` / `JSON.parse` block that previously appeared at lines 365-373 inside the legacy risky-write block.

### WR-03: JSON.parse of profile has no timeout guard

**Files modified:** `packages/openclaw-plugin/src/hooks/pain.ts`
**Commit:** 87941dd9
**Applied fix:** Added a `content.length > 1024 * 1024` guard before calling `JSON.parse`. If the PROFILE.json exceeds 1 MB, the parse is skipped and a `PROFILE_PARSE_WARN` log entry is written. The guard was integrated into the same consolidated profile loading block as WR-02.

### WR-04: SlowStubRuntimeAdapter.setOutput is overridden to no-op

**Files modified:** `packages/principles-core/src/runtime-v2/runner/__tests__/m8-02-e2e.test.ts`
**Commit:** 8c78d681
**Applied fix:** Replaced the no-op `setOutput` override in `SlowStubRuntimeAdapter` with `super.setOutput(output)`, delegating to the parent `StubRuntimeAdapter` so that `this.nextOutput` is actually set. This makes the E2E-05 test reliable if the test is refactored to depend on `fetchOutput`.

---

_Fixed: 2026-04-28T00:00:00Z_
_Fixer: Claude (gsd-code-fixer)_
_Iteration: 1_
