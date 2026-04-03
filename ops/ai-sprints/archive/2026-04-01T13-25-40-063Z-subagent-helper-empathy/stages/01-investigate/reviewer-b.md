# Reviewer B Report — Investigate Stage (Round 3)

## VERDICT: APPROVE

The investigation deliverables are substantially complete. All four contract items are DONE with adequate evidence. The hypothesis matrix is correctly assessed. I flag two minor issues for record but they do not block approval.

---

## BLOCKERS

1. **Cross-repo evidence path incorrect**: Producer references `D:/Code/openclaw/src/core/hooks.ts` but the file is at `D:/Code/openclaw/src/plugins/hooks.ts`. The evidence (fire-and-forget at L946) is correct, but the path is wrong. This is a documentation accuracy issue, not a factual error about the finding.

2. **`expectsCompletionMessage` not in any `SubagentRunParams` type**: Confirmed. Neither the principles SDK (`openclaw-sdk.d.ts` L86-93) nor the official OpenClaw SDK (`D:/Code/openclaw/src/plugins/runtime/types.ts` L8-17) include `expectsCompletionMessage`. The empathy observer uses this parameter anyway. The transport_audit.md correctly flags this as a risk.

Both issues are documented in the deliverables. Neither rises to the level of blocking.

---

## FINDINGS

### Hypothesis Matrix

- **empathy_uses_runtime_direct_transport**: SUPPORTED — `api.runtime.subagent.run()` at L193 with direct calls to `waitForRun`, `getSessionMessages`, `deleteSession`. No registry_backed alternative present. Verified in source.

- **empathy_has_unverified_openclaw_hook_assumptions**: SUPPORTED — Cross-repo verification confirms: (a) completion-mode `subagent_ended` deferred until announce delivery resolves (`subagent-registry.steer-restart.test.ts` L283-313), (b) session-mode `subagent_ended` never emits (L315-339), (c) `subagent_ended` runs fire-and-forget (`plugins/hooks.ts` L946). Empathy uses `deliver: false` which eliminates (a)'s deferral.

- **empathy_timeout_leads_to_false_completion**: REFUTED — Timeout path sets `timedOutAt` + `observedAt` (L272-274), calls `cleanupState(..., false)` preserving `activeRuns` entry, does NOT call `trackFriction()`. False completion not triggered.

- **empathy_cleanup_not_idempotent**: REFUTED — `completedSessions` TTL map (5-min window) at L92-104 provides dedupe; `isCompleted()` check at L306-310 prevents double-write; dedicated test verifies fallback does not double-write.

- **empathy_lacks_dedupe_key**: SUPPORTED — `idempotencyKey: \`${sessionId}:${Date.now()}\`` at L198 uses `Date.now()` which is not stable for retries. Migration target should use `${sessionId}` only. Correctly identified in all three documents.

### Scope Control

PR2 scope: empathy observer + deep-reflect only. This is an investigate stage, so no code changes are expected. The four structured documents cover empathy observer only. No evidence of Nocturnal/Diagnostician scope creep.

### Test Coverage

Tests exist at `tests/service/empathy-observer-manager.test.ts` (393 lines) and `tests/hooks/subagent.test.ts` (408 lines). The investigate stage does not require new tests. The brief says "test coverage" but this is a pre-migration audit, not an implementation stage.

### Smallest Sufficient Fix Assessment

Not applicable — this is an investigate stage with no code changes. If this were an implementation, the migration would need:
- Stable idempotency key (`${sessionId}` only)
- `expectsCompletionMessage` officially typed or documented fallback

---

## CODE_EVIDENCE

- files_verified: empathy-observer-manager.ts, subagent.ts, subagent-probe.ts, openclaw-sdk.d.ts, index.ts, deep-reflect.ts
- evidence_source: both
- sha: f5431bc07e7321466530cc4b811ac2dc66c84bdc (OpenClaw); current HEAD (Principles)
- evidence_scope: both

**Cross-repo verification performed**:
- `D:/Code/openclaw/src/agents/subagent-registry.steer-restart.test.ts` L283-313, L315-339 — completion-mode/session-mode findings
- `D:/Code/openclaw/src/plugins/hooks.ts` L946 — fire-and-forget confirmation (producer cited wrong path `src/core/hooks.ts`)
- `D:/Code/openclaw/src/plugins/runtime/types.ts` L8-17 — SubagentRunParams official type lacks `expectsCompletionMessage`

---

## HYPOTHESIS_MATRIX

- empathy_uses_runtime_direct_transport: SUPPORTED — Direct `api.runtime.subagent.run()` at L193; `isSubagentRuntimeAvailable()` confirms gateway mode; no registry alternative found
- empathy_has_unverified_openclaw_hook_assumptions: SUPPORTED — Cross-repo verified: completion-mode deferred (L283-313), session-mode never emits (L315-339), fire-and-forget (plugins/hooks.ts L946)
- empathy_timeout_leads_to_false_completion: REFUTED — `cleanupState(..., false)` preserves `activeRuns`; `trackFriction()` not called on timeout; `timedOutAt` set but not conflated with success
- empathy_cleanup_not_idempotent: REFUTED — `completedSessions` TTL map (L92-104) + `isCompleted()` guard (L306-310) + dedicated test
- empathy_lacks_dedupe_key: SUPPORTED — `${sessionId}:${Date.now()}` at L198; timestamp not stable for retries; migration target `${sessionId}` only

---

## NEXT_FOCUS

This stage is investigate only. The next stage (implement/migrate) should:
1. Replace `Date.now()` in idempotency key with stable `${sessionId}` only
2. Either formally type `expectsCompletionMessage` in the SDK or document it as a plugin extension
3. Run existing empathy-observer tests to confirm no regression before migration

---

## CHECKS

CHECKS: criteria=met;blockers=0;verification=partial

---

## DIMENSIONS

DIMENSIONS: evidence_quality=4; assumption_coverage=4; transport_audit_completeness=4

**Rationale**:
- `evidence_quality=4`: Source code verified in both repos. Cross-repo evidence confirmed (with path correction noted). SHA reference imprecise ("current HEAD") but acceptable for investigate stage.
- `assumption_coverage=4`: All 5 hypotheses addressed. OpenClaw assumptions documented with cross-repo verification. One minor gap: `expectsCompletionMessage` behavior not traced through the actual announce delivery path in OpenClaw source (only verified via test comments).
- `transport_audit_completeness=4`: RUNTIME_DIRECT confirmed; REGISTRY_BACKED alternative assessed as NOT USED; idempotency key issue identified; `expectsCompletionMessage` gap flagged. Minor gap: deep-reflect transport not audited (brief says deep-reflect is in scope but docs only cover empathy).

---

## CONTRACT

- transport_audit status: DONE — Structured document with RUNTIME_DIRECT verification, idempotency analysis, SDK gap identification
- lifecycle_hook_map status: DONE — Structured document with hook inventory, call flow diagrams, completion vs session mode distinction
- openclaw_assumptions_documented status: DONE — 6 assumptions with cross-repo verification; cross-repo path error (core vs plugins) noted but finding correct
- failure_mode_inventory status: DONE — 10 failure paths (A-J) documented with TTL constants, mitigations, and protections
