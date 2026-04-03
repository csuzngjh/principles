# OpenClaw Assumptions Documentation

## Overview
This document records all OpenClaw assumptions made by the empathy observer system, their verification status, and any cross-repo validation findings.

---

## Assumption 1: `runtime.subagent.run()` Completion Guarantee

**Assumption**: `runtime.subagent.run()` will eventually complete (either OK, error, or timeout)

**Verification Status**: PARTIALLY VERIFIED

**Evidence**:
- `empathy-observer-manager.ts` L193-200: `run()` is called and returns a `runId`
- Timeout is handled via `waitForRun()` with 30-second default (`DEFAULT_WAIT_TIMEOUT_MS` L9)
- OpenClaw v2026.3.23 fix noted: timeout may be false positive (fast-finishing workers)

**Notes**: 
- `run()` itself doesn't guarantee completion - completion is signaled via `waitForRun()` polling
- The subagent may timeout, error, or succeed

---

## Assumption 2: `subagent_ended` Hook Fires for ALL Endings

**Assumption**: The `subagent_ended` hook fires for ALL subagent endings including timeout, error, killed, reset, deleted

**Verification Status**: UNVERIFIED (cross-repo findings)

**Cross-Repo Verification** (reviewer B findings):
- **D:/Code/openclaw/src/agents/subagent-registry.steer-restart.test.ts**
- L283-313: Completion-mode `subagent_ended` is **DEFERRED** until announce delivery resolves
- L315-339: Session-mode `subagent_ended` is **NEVER** emitted

**Key Insight**: The mode matters:
| Mode | `expectsCompletionMessage` | `subagent_ended` Fires? |
|------|---------------------------|--------------------------|
| Completion | `true` | YES (but deferred if announce delivery needed) |
| Session | `false` | **NEVER** |

**Empathy Observer Configuration**:
- Uses `deliver: false` + `expectsCompletionMessage: true`
- This is **Completion Mode**
- With `deliver: false`, announce delivery is NOT needed
- Therefore `subagent_ended` should fire PROMPTLY (no deferral)

**Risk**: `subagent_ended` is fire-and-forget (parallel execution, errors swallowed)
- Source: `hooks.ts` L946 (verified by reviewer B)

---

## Assumption 3: `waitForRun(timeout)` Reliability

**Assumption**: `waitForRun(timeout)` returns reliable status (ok/error/timeout)

**Verification Status**: PARTIALLY VERIFIED

**Evidence**:
- `empathy-observer-manager.ts` L251-267: `waitForRun()` result determines next action
- OpenClaw v2026.3.23 comment at `subagent.ts` L183-184: "timeout may be false positive (fast-finishing workers)"
- v2026.3.23 fix applied: fast-finishing workers are no longer incorrectly reported as timed out

**Paths**:
- `ok`: `reapBySession()` → `trackFriction()` → `deleteSession()`
- `timeout`: `cleanupState(..., false)` → preserve for fallback
- `error`: `cleanupState(..., false)` → preserve for fallback

---

## Assumption 4: `expectsCompletionMessage: true` Ensures Hook Delivery

**Assumption**: Setting `expectsCompletionMessage: true` ensures `subagent_ended` hook fires

**Verification Status**: UNVERIFIED (cross-repo findings)

**Cross-Repo Verification** (reviewer B):
- `expectsCompletionMessage: true` = **Completion Mode**
- Completion-mode `subagent_ended` fires BUT is **DEFERRED** until announce delivery resolves
- If `deliver: false`, no announce delivery needed, so deferral is minimal/none

**Empathy Observer Configuration** (`empathy-observer-manager.ts` L197-199):
```typescript
deliver: false,               // No announce delivery needed
expectsCompletionMessage: true, // Completion mode
```

**Analysis**:
- `deliver: false` + `expectsCompletionMessage: true` = Completion Mode without announce deferral
- This is the CORRECT configuration for empathy observer to receive `subagent_ended`
- If `deliver: true` (default), hook would be deferred until announce delivery

---

## Assumption 5: `deleteSession` Is Idempotent

**Assumption**: `deleteSession()` can be called multiple times safely

**Verification Status**: VERIFIED (via test)

**Evidence**:
- `empathy-observer-manager.test.ts` L286: 'fallback reap does not double-write' test passes
- `completedSessions` TTL map provides additional idempotency protection (L92-104)

---

## Assumption 6: Hook Errors Don't Break Parent Session

**Assumption**: Errors in `subagent_ended` hook handler don't propagate to parent session

**Verification Status**: VERIFIED (fire-and-forget)

**Cross-Repo Evidence**:
- `hooks.ts` L946 (verified by reviewer B): `subagent_ended` is fire-and-forget
- Errors are caught and logged, not propagated

**Empathy Observer Protection**:
- `try/catch` around `reap()` call in `handleSubagentEnded` (`subagent.ts` L175-178)
- TTL-based orphan detection in `isActive()` provides recovery

---

## Summary Table

| Assumption | Status | Notes |
|------------|--------|-------|
| `run()` eventually completes | PARTIALLY VERIFIED | Via `waitForRun()` polling |
| `subagent_ended` fires for all endings | **UNVERIFIED** | Mode-dependent; session-mode NEVER fires |
| `waitForRun()` reliable | PARTIALLY VERIFIED | v2026.3.23 fix for false positive timeouts |
| `expectsCompletionMessage` ensures hook | **UNVERIFIED** | Depends on `deliver` setting |
| `deleteSession` idempotent | VERIFIED | Via test and TTL map |
| Hook errors don't break parent | VERIFIED | Fire-and-forget |

---

## Critical Finding: Session Mode vs Completion Mode

**Session Mode** (`expectsCompletionMessage: false`):
- `subagent_ended` is **NEVER** emitted
- Used for fire-and-forget subagent invocations
- Empathy observer does NOT use this mode

**Completion Mode** (`expectsCompletionMessage: true`):
- `subagent_ended` IS emitted
- BUT deferred until announce delivery resolves (if `deliver: true`)
- Empathy observer uses `deliver: false`, so no deferral

**Empathy Observer is CORRECTLY configured**:
```typescript
deliver: false,                // No announce delivery = no deferral
expectsCompletionMessage: true, // Completion mode = hook fires
```

---

## Risks and Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| `subagent_ended` never fires | HIGH | TTL-based orphan detection (5-min) in `isActive()` |
| Hook errors swallowed | MEDIUM | TTL cleanup as backup |
| Announce delivery deferral | N/A | empathy uses `deliver: false` |
| Session-mode misconfiguration | N/A | empathy uses completion mode |

---

## Evidence

**Local Repository**:
- `packages/openclaw-plugin/src/service/empathy-observer-manager.ts`
- `packages/openclaw-plugin/src/hooks/subagent.ts`
- `packages/openclaw-plugin/src/index.ts`
- `packages/openclaw-plugin/src/openclaw-sdk.d.ts`

**Cross-Repo Verification** (reviewer B):
- `D:/Code/openclaw/src/agents/subagent-registry.steer-restart.test.ts`
  - L283-313: Completion-mode deferred finding
  - L315-339: Session-mode never emitted finding
- `D:/Code/openclaw/src/core/hooks.ts` L946: Fire-and-forget confirmation