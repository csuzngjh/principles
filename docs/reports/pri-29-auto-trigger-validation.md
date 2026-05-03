# PRI-29: Validate Real OpenClaw Auto-Trigger Pain Path

**Status:** ⚠️ PARTIAL (Architecture Guards ✅, Real Environment Validation ⏸️)

**Date:** 2026-05-03

---

## Executive Summary

PRI-29 aimed to validate the real OpenClaw `after_tool_call` hook → Runtime V2 pain→principle chain. While architecture guards confirm the code path is correct, real environment validation encountered infrastructure gaps that prevent conclusive end-to-end testing.

**Verdict:** **GATED** — Real auto-trigger path cannot be validated due to:
1. PRI-28 health snapshot command not available in deployed CLI
2. MINIMAX_API_KEY environment variable not configured
3. No deterministic way to trigger controlled tool failures via gateway

---

## Validation Method

### 1. Architecture Guards (✅ COMPLETED)

**File:** `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`

Added new guard:
```typescript
it('pain.ts emitPainDetectedEvent calls PainToPrincipleService.recordPain on pain_detected', async () => {
  // Must call service.recordPain() inside emitPainDetectedEvent
  expect(src).toMatch(/service\.recordPain\(/);
  // Must log PAIN_SERVICE_FAILED for failure results
  expect(src).toMatch(/PAIN_SERVICE_FAILED/);
  // Must log PAIN_SERVICE_SKIPPED for skipped results
  expect(src).toMatch(/PAIN_SERVICE_SKIPPED/);
  // Must log PAIN_SERVICE_ERROR for exceptions
  expect(src).toMatch(/PAIN_SERVICE_ERROR/);
  // Must NOT use legacy createPainSignalBridge
  expect(src).not.toMatch(/createPainSignalBridge/);
});
```

**File:** `packages/openclaw-plugin/tests/integration/runtime-v2-pain-guard.test.ts`

Added 5 new guards verifying:
- `createPainToPrincipleService` constructs with `wctx.workspaceDir` and `wctx.stateDir`
- `owner: 'openclaw-plugin'` and `autoIntakeEnabled: true` are passed
- `recordObservability: true` is passed to `service.recordPain()`
- All three log types (FAILED/SKIPPED/ERROR) are present in source

**Result:** ✅ All architecture guards confirm correct implementation.

### 2. Real Environment Validation (⏸️ BLOCKED)

#### Environment
- **Workspace:** `D:\.openclaw\workspace`
- **OpenClaw version:** 2026.5.2 (8b2a6e5)
- **Gateway:** Running at `ws://127.0.0.1:18789`
- **PD commit:** aed2bb7e (PR #455 merged)

#### Commands Run

```bash
# Candidate audit — ✅ PASSED
pd candidate audit --workspace "D:\.openclaw\workspace" --json
{
  "status": "ok",
  "consumedCount": 4,
  "missingLedgerEntryIds": []
}
```

```bash
# Runtime V2 UAT — ⏸️ BLOCKED by missing MINIMAX_API_KEY
pd runtime uat --workspace "D:\.openclaw\workspace" --count 2
Error: MINIMAX_API_KEY environment variable not set
```

```bash
# Health snapshot — ❌ COMMAND NOT FOUND
pd runtime health snapshot --workspace "D:\.openclaw\workspace" --json
error: unknown command 'health'
# Note: PR #451 added this command but it's not appearing in deployed CLI
# Source has `pd health` at top level, but `pd runtime health snapshot` is missing
```

#### Workspace State
- `.pd/state.db`: 1.28 MB (active)
- `principle-tree-ledger.json`: 3.3 KB (4 entries)
- `evolution_queue.json`: 50 KB (active)
- `trajectory.db`: 9.87 MB + WAL (active)

---

## Observed Gate Evidence

**Status:** ❌ No gate evidence captured — unable to trigger test failures.

To capture `PAIN_GATE_REJECTED` or `pain_detected` events, we would need to:
1. Send a chat message through OpenClaw gateway that causes a tool failure
2. Repeat 2-3 times to accumulate GFI above threshold (painTrigger=40)
3. Monitor system logs for `PAIN_GATE_REJECTED` or pain_detected

**Blocking Issue:** No programmatic way to trigger controlled tool failures via the gateway WebSocket API without running a full agent conversation.

---

## Runtime V2 Evidence

**Status:** ❌ No Runtime V2 evidence captured — unable to trigger auto-pain.

Expected evidence (if auto-trigger worked):
- `painId`: Generated pain identifier
- `taskId`: RuntimeStateManager task ID
- `runId`: DiagnosticianRunner run ID
- `artifactId`: Generated diagnostic artifact
- `candidateIds`: Probation candidate IDs
- `ledgerEntryIds`: Ledger entry IDs

---

## Root Cause Analysis

### Issue 1: PRI-28 Health Snapshot Command Missing

**Expected:** `pd runtime health snapshot --workspace <path> --json`
**Actual:** Command not found in deployed CLI

**Investigation:**
- PR #451 (commit 58bae54a) claims to add this command
- Source code check shows no `handleRuntimeHealthSnapshot` in `pd-cli/src/commands/`
- `packages/pd-cli/src/index.ts` has no `runtimeHealthCmd` registration
- `pd health` exists at top level but this is PRI-28's old placement, not the `runtime health snapshot` subcommand

**Likely Cause:** PR #451 was merged but the CLI command registration may have been lost in a subsequent PR or merge conflict.

### Issue 2: MINIMAX_API_KEY Not Configured

**Impact:** Blocks Runtime V2 UAT baseline and any auto-pain that requires diagnostician execution.

**Mitigation:** Set `MINIMAX_API_KEY` in environment or OpenClaw config.

### Issue 3: No Deterministic Auto-Trigger Test Path

**Problem:** To validate auto-trigger, we need to:
- Trigger a tool failure (write to protected path, invalid command, etc.)
- Do it 2-3 times to accumulate GFI
- Observe gate behavior and Runtime V2 chain

**Current Gaps:**
- OpenClaw gateway has no "inject tool failure" API
- Writing a test file and causing it to fail requires full agent conversation
- No way to control GFI accumulation without actually failing tools

---

## Result

### Architecture Layer: ✅ PASS

- `emitPainDetectedEvent` calls `PainToPrincipleService.recordPain()`
- Constructor uses correct `workspaceDir`, `stateDir`, `owner: 'openclaw-plugin'`
- All log types (FAILED/SKIPPED/ERROR) are present
- No legacy `createPainSignalBridge` usage

### Runtime Layer: ⏸️ BLOCKED

- Cannot validate real auto-trigger end-to-end
- Health snapshot command missing prevents operator visibility
- MINIMAX_API_KEY not configured blocks UAT baseline
- No deterministic way to trigger controlled tool failures via gateway

---

## Follow-ups

### Required (Blockers for PRI-29 completion)

1. **Restore `pd runtime health snapshot` command**
   - Investigate why PR #451's command registration is missing
   - Verify `packages/pd-cli/src/commands/runtime-health-snapshot.ts` exists
   - Verify `packages/pd-cli/src/index.ts` registers the command correctly
   - Create PR if needed

2. **Configure MINIMAX_API_KEY for testing**
   - Set in environment or OpenClaw config
   - Document in runbook (PRI-30)

3. **Create deterministic auto-trigger test**
   - Add script or tool to inject tool failure via gateway
   - Or use manual trigger instructions with clear steps

### Recommended (Observability)

1. **Add pain event logs to system log viewer**
   - Make `PAIN_GATE_REJECTED` and `PAIN_SERVICE_*` logs visible in dashboard
   - Enable filtering by pain event type

2. **Add pain event counter to `pd runtime probe`**
   - Show recent pain signals, gate decisions, service outcomes
   - Include GFI trend and consecutive error count

---

## Conclusion

**PRI-29 Status:** **PARTIAL**

The auto-trigger code path is architecturally correct (verified by guards), but real environment validation is blocked by missing command (PRI-28 regression) and configuration gaps (MINIMAX_API_KEY).

**Recommendation:** Complete PRI-29 by:
1. Restoring the `pd runtime health snapshot` command (immediate blocker)
2. Setting up MINIMAX_API_KEY for UAT baseline
3. Creating a follow-up issue for deterministic auto-trigger testing

The core pain → Runtime V2 chain is correct in principle; the gaps are in operational tooling and validation infrastructure, not in the implementation itself.
