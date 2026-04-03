# Producer Report - Investigate Stage (Round 3)

## SUMMARY

The empathy observer uses **RUNTIME_DIRECT** transport with `subagent_ended` as a fallback recovery hook. Round 3 addressed reviewer B's blockers by:

1. **Documenting announce delivery dependency**: Completion-mode `subagent_ended` is deferred until announce delivery resolves, BUT empathy uses `deliver: false`, eliminating deferral
2. **Creating structured lifecycle_hook_map.md**: Documents all hooks, modes, and call flows
3. **Updating openclaw_assumptions_documented.md**: Includes cross-repo verification from reviewer B (session-mode never emits `subagent_ended`; fire-and-forget behavior)

Key finding: Empathy observer is **CORRECTLY configured** for its use case. Using `deliver: false` + `expectsCompletionMessage: true` means it operates in completion mode without announce deferral, ensuring `subagent_ended` fires promptly.

## CHANGES

### Round 3 Changes (Address Reviewer B Blockers)

1. **lifecycle_hook_map.md** (NEW - structured document)
   - Documents all lifecycle hooks used by empathy observer
   - Includes hook call flow diagrams
   - Explains completion mode vs session mode distinction

2. **openclaw_assumptions_documented.md** (UPDATED - cross-repo verification)
   - Added cross-repo findings from reviewer B
   - Session-mode `subagent_ended` never emits
   - Fire-and-forget behavior confirmed
   - Announce delivery dependency clarified

3. **transport_audit.md** (NEW - structured document)
   - Detailed transport mechanism analysis
   - Idempotency key issue documented
   - `expectsCompletionMessage` parameter analysis

4. **failure_mode_inventory.md** (NEW - expanded)
   - 10 failure paths documented
   - TTL constants catalogued
   - Mitigation strategies identified

### Key Updated Findings

**Empathy Configuration** (`empathy-observer-manager.ts` L197-199):
```typescript
deliver: false,                // No announce delivery = no deferral
expectsCompletionMessage: true, // Completion mode = hook fires
```

**This is CORRECT** - completion mode with `deliver: false` ensures `subagent_ended` fires without deferral.

**idempotencyKey Issue** (L198):
```typescript
idempotencyKey: `${sessionId}:${Date.now()}`  // Date.now() is not stable for retries
```
Migration should use stable key: `${sessionId}` only.

## EVIDENCE

### Local Repository Evidence
- `packages/openclaw-plugin/src/service/empathy-observer-manager.ts` (511 lines)
- `packages/openclaw-plugin/src/hooks/subagent.ts` (481 lines)
- `packages/openclaw-plugin/src/utils/subagent-probe.ts` (94 lines)
- `packages/openclaw-plugin/src/openclaw-sdk.d.ts` (464 lines)
- `packages/openclaw-plugin/src/index.ts` (hook registration)

### Cross-Repo Evidence (reviewer B)
- `D:/Code/openclaw/src/agents/subagent-registry.steer-restart.test.ts`
  - L283-313: Completion-mode deferred finding
  - L315-339: Session-mode never emitted finding
- `D:/Code/openclaw/src/core/hooks.ts` L946: Fire-and-forget confirmation

## CODE_EVIDENCE

- files_checked: empathy-observer-manager.ts, subagent.ts, subagent-probe.ts, openclaw-sdk.d.ts, index.ts, deep-reflect.ts, lifecycle_hook_map.md, openclaw_assumptions_documented.md, transport_audit.md, failure_mode_inventory.md
- evidence_source: both
- sha: Current HEAD
- branch/worktree: D:\Code\principles
- evidence_scope: principles|openclaw|both

## KEY_EVENTS

- RUNTIME_DIRECT transport verified: `api.runtime.subagent.run()` at L193
- `subagent_ended` hook confirmed as FALLBACK (not primary) recovery path
- Completion mode vs session mode distinction documented
- Empathy uses CORRECT configuration: `deliver: false` + `expectsCompletionMessage: true`
- Session-mode `subagent_ended` never emits (cross-repo verified by reviewer B)
- Completion-mode `subagent_ended` deferred until announce delivery (cross-repo verified)
- `deliver: false` eliminates announce deferral for empathy
- TTL-based orphan detection: 5-minute window in `isActive()`
- `idempotencyKey` uses `Date.now()` - not stable for retries
- 10 failure paths documented with mitigations

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — Direct `api.runtime.subagent.run()` at L193; `isSubagentRuntimeAvailable()` probe confirms gateway mode; no registry_backed alternative used
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — Cross-repo reviewer B findings: session-mode `subagent_ended` NEVER emits; completion-mode deferred until announce delivery; fire-and-forget (errors swallowed)
- empathy_timeout_leads_to_false_completion: REFUTED — Timeout calls `cleanupState(..., false)` preserving activeRuns entry for fallback; `timedOutAt` set but `trackFriction()` NOT called
- empathy_cleanup_not_idempotent: REFUTED — `completedSessions` TTL map (5-min window) at L92-104 provides dedupe; `isCompleted()` check at L306-310 prevents double-write
- empathy_lacks_dedupe_key: SUPPORTED — `idempotencyKey: ${sessionId}:${Date.now()}` at L198 uses timestamp; not stable for retries; new workflow helper should use stable key

## CHECKS

CHECKS: evidence=ok;tests=not-applicable;scope=empathy-only;prompt-isolation=confirmed;openclaw-verified=cross-repo;transport=runtime_direct;mode=completion;lifecycle=subagent_ended-fallback

## OPEN_RISKS

1. **subagent_ended fire-and-forget**: Hook is fire-and-forget (errors swallowed); TTL-based orphan detection (5-min) provides recovery if hook fails
2. **Announce delivery deferral**: Completion-mode deferred until announce delivery resolves; empathy uses `deliver: false` eliminating this risk
3. **Session-mode never emits**: Not a risk for empathy (uses completion mode); documented for completeness
4. **idempotencyKey instability**: `Date.now()` not stable for retries; should be `${sessionId}` only
5. **workspaceDir mismatch in fallback**: `subagent_ended` may provide different `workspaceDir`; fallback tries to find original from `activeRuns` metadata

## CONTRACT

- transport_audit status: DONE
- lifecycle_hook_map status: DONE
- openclaw_assumptions_documented status: DONE
- failure_mode_inventory status: DONE

---

**Round 3 Producer Report - Investigate Stage Complete**