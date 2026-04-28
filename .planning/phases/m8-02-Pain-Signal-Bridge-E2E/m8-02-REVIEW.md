---
status: issues
phase: m8-02
depth: standard
files_reviewed: 4
critical: 0
warning: 4
info: 1
total: 5
---

# Phase m8-02: Code Review Report

**Reviewed:** 2026-04-28T00:00:00Z
**Depth:** standard
**Files Reviewed:** 4
**Status:** issues_found

## Summary

Reviewed PainSignalBridge idempotent routing, autoIntakeEnabled wiring, CandidateIntakeService artifact parsing, and the E2E test suite. Core logic is sound: the 5 routing rules (succeeded NO-OP, leased SKIP, failed/retry_wait/pending reset+rerun) are correctly implemented, autoIntakeEnabled is properly set to true in production pain.ts, and artifact content parsing handles both DiagnosticianOutputV1 and {recommendation} wrapper formats. E2E coverage for E2E-01 through E2E-05 is solid. Four warnings were found: two latent reliability concerns (no lease-expiry recovery, double JSON.parse in pain.ts profile loading) and two issues in the E2E test scaffolding itself.

---

## Warnings

### WR-01: No lease-expiry recovery for crashed runner leaves task permanently leased

**File:** `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts:95-99`
**Issue:** When `existingTask.status === 'leased'`, the bridge returns `painId` immediately without checking whether the lease is still valid. If the DiagnosticianRunner process crashes after acquiring a lease but before committing results, the task remains `leased` forever. A subsequent pain_detected event for the same painId will always see `status === 'leased'` and skip — the diagnostician chain never recovers.

The runner has a `timeoutMs: 300_000` (5 minutes), but the bridge does not check for stale leases on entry; it only checks the current status label, not whether the lease has expired.

**Fix:**
```typescript
if (existingTask) {
  const { status, leasedAt } = existingTask;
  const leaseExpired = leasedAt && (Date.now() - new Date(leasedAt).getTime()) > LEASE_TTL_MS;
  if (status === 'leased' && !leaseExpired) {
    // Rule b: another run is genuinely in progress — SKIP
    return painId;
  }
  // lease expired or status is not leased — fall through to reset + re-run
}
```

---

### WR-02: Profile JSON parsed twice per failure event

**File:** `packages/openclaw-plugin/src/hooks/pain.ts:220-229` and `packages/openclaw-plugin/src/hooks/pain.ts:365-373`
**Issue:** `wctx.resolve('PROFILE')` and the subsequent `fs.existsSync` / `JSON.parse` block appear twice in `handleAfterToolCall`: once at line 221 (inside the failure path, before `isRisky` check) and again at line 365 (inside the legacy risky-write block). On every write-tool failure that is also risky, the same profile file is read and parsed twice.

**Fix:** Parse the profile once at the top of the function and reuse the result:

```typescript
let profile = normalizeProfile({});
const profilePath = wctx.resolve('PROFILE');
if (fs.existsSync(profilePath)) {
  try {
    profile = normalizeProfile(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
  } catch (e) {
    SystemLogger.log(effectiveWorkspaceDir, 'PROFILE_PARSE_WARN', `Failed to parse PROFILE.json: ${String(e)}`);
  }
}
// Remove the second parse block at line 365
```

---

### WR-03: JSON.parse of profile has no timeout guard

**File:** `packages/openclaw-plugin/src/hooks/pain.ts:225`
**Issue:** `JSON.parse(fs.readFileSync(profilePath, 'utf8'))` is a blocking synchronous call with no size or parse-time limit. A malformed or very large PROFILE.json will block the event loop. This occurs on every tool failure event.

**Fix:**
```typescript
const content = fs.readFileSync(profilePath, 'utf8');
if (content.length > 1024 * 1024) { // 1 MB guard
  SystemLogger.log(effectiveWorkspaceDir, 'PROFILE_PARSE_WARN', 'PROFILE.json exceeds 1 MB, skipping');
} else {
  profile = normalizeProfile(JSON.parse(content));
}
```

---

### WR-04: SlowStubRuntimeAdapter.setOutput is overridden to no-op but is called in E2E-05 test setup

**File:** `packages/principles-core/src/runtime-v2/runner/__tests__/m8-02-e2e.test.ts:175-177`
**Issue:** `SlowStubRuntimeAdapter` overrides `setOutput(output)` as a no-op. However, the E2E-05 test still calls `slowAdapter.setOutput(makeDiagnosticianOutputWithCandidates(painId) as Record<string, unknown>)` at line 503 before invoking the bridge. Since the override is a no-op, `this.nextOutput` is never set inside SlowStub, and `fetchOutput` would return null when the runner collects artifacts. This means E2E-05's runner may not produce candidates, making the test assertions at lines 574-575 unreliable.

Note: `fetchOutput` in `StubRuntimeAdapter` (line 129) returns `this.nextOutput` directly. If `nextOutput` was never set (due to the SlowStub no-op override), it would be null. However, the runner collects candidates via the committer which is `SqliteDiagnosticianCommitter` — not via `fetchOutput`. So the candidates are still written by the committer. The `setOutput` no-op is therefore harmless in this specific test, but it is misleading and could cause issues if the test is refactored.

**Fix:**
```typescript
// In SlowStubRuntimeAdapter, either remove the override or implement it properly:
override setOutput(output: Record<string, unknown> | null): void {
  // Delegate to parent so nextOutput is actually set
  super.setOutput(output);
}
```

---

## Info

### IN-01: bridges Map has no cleanup for removed workspaces

**File:** `packages/openclaw-plugin/src/hooks/pain.ts:50`
**Issue:** `painSignalBridges` is a module-level `Map<string, PainSignalBridge>` that persists for the lifetime of the plugin process. Workspaces that are deleted or unmounted are never removed from the map. For long-running daemon processes this is a minor memory leak.

**Fix:** This is low severity (plugin processes are typically long-lived). Consider adding a `deletePainSignalBridge(wctx: WorkspaceContext)` function called when a workspace is torn down, or using a `WeakMap` if workspace objects are managed references.

---

## Critical Issues

None found.

---

_Reviewed: 2026-04-28T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
