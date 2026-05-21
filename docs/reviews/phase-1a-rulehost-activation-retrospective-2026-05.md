# Phase 1A RuleHost Activation Retrospective — 2026-05

**Date:** 2026-05-21
**Scope:** RuleHost activation / approval / auto_correct boundary audit
**Branch:** `phase-1a-rulehost-retrospective-tiv05g`

---

## 1. Completed Issues

| Issue | Title | PR | Status |
|-------|-------|-----|--------|
| PRI-146 | RuleHostWriter | #650 | Merged |
| PRI-185 | RuleHost approval context | #654 | Merged |
| PRI-174 | Host live auto_correct gate | #655 | Merged |

---

## 2. RuleHost Activation Data Flow

```text
                    ┌──────────────────────┐
                    │  Rollout Reviewer     │
                    │  (decides route)      │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │  ActivationDispatcher │
                    │  .dispatch(input)     │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼──────┐  ┌─────▼──────┐  ┌──────▼────────┐
     │ Low-Risk      │  │ Auto-      │  │ High-Risk     │
     │ (prompt,      │  │ Promote    │  │ (code_tool_   │
     │  defer_       │  │ (skill ≥   │  │  hook,        │
     │  archive)     │  │  0.95)     │  │  model_       │
     │               │  │            │  │  training)    │
     └────┬──────────┘  └─────┬──────┘  └──────┬────────┘
          │                   │                │
          ▼                   ▼                ▼
     Direct            Direct           Approval Queue
     Activation        Activation       (or refused if
     (PromptWriter /   (skill writer)   no queue store)
     DeferArchive                        │
     Writer)                             │
                                    ┌────▼────────────┐
                                    │ RuleHostWriter   │
                                    │ .canActivate()   │
                                    │ .activate()      │
                                    │ .buildApproval   │
                                    │  Context()       │
                                    └─────────────────┘
```

### Gate-level flow (gate.ts)

```text
before_tool_call event
        │
        ▼
  RuleHost.evaluate(input)
        │
        ├── decision='allow' → emit rulehost_evaluated, allow
        ├── decision='block' → emit rule_enforced + rulehost_blocked, block
        ├── decision='requireApproval' → emit rule_enforced + rulehost_requireApproval, allow
        └── decision='auto_correct' →
                │
                ├── Has correctionProposal?
                │   ├── YES: validateCorrectionProposal()
                │   │   ├── applicationMode='live' + valid →
                │   │   │   ├── Apply correctedFields from proposedParams
                │   │   │   ├── Emit rulehost_auto_correct_applied
                │   │   │   └── Return warning if notifyAgent=true
                │   │   ├── applicationMode='live' + invalid →
                │   │   │   └── No mutation, emit proposed with validationValid=false
                │   │   └── applicationMode='shadow' →
                │   │       └── No mutation, emit proposed with applicationMode='shadow'
                │   └── NO: emit proposed with validationValid=false
                │
                └── Exception → fail-open, allow with warning log
```

---

## 3. Shadow / Live / Approval / Auto_correct Behavior Matrix

| # | Scenario | Params Mutated? | Telemetry | Return | Test Coverage |
|---|----------|-----------------|-----------|--------|---------------|
| 1 | `auto_correct` + `applicationMode='shadow'` + valid proposal | **No** | `rulehost_auto_correct_proposed` (shadow, validationValid=true) | `undefined` (allow) | ✅ `gate-auto-correct-shadow.test.ts` |
| 2 | `auto_correct` + `applicationMode='live'` + valid proposal | **Yes** | `proposed` + `applied` | Warning if notifyAgent, else `undefined` | ✅ `gate-auto-correct.test.ts` |
| 3 | `auto_correct` + `applicationMode='live'` + invalid proposal | **No** | `proposed` (validationValid=false) | `undefined` | ✅ `gate-auto-correct.test.ts` |
| 4 | `auto_correct` + malformed proposal (proposedParams not object) | **No** | `proposed` (validationValid=false) | `undefined` | ✅ `gate-auto-correct.test.ts` |
| 5 | `auto_correct` without correctionProposal | **No** | `proposed` (validationValid=false, reason='no proposal') | `undefined` | ✅ `gate-auto-correct-shadow.test.ts` |
| 6 | `auto_correct` + correctedFields field missing from event.params | **No** (fail-open) | `proposed` emitted, `applied` NOT emitted | `undefined` + warn log | ✅ `gate-auto-correct.test.ts` |
| 7 | `auto_correct` + correctedFields field missing from proposedParams | **No** (fail-open) | `proposed` emitted, `applied` NOT emitted | `undefined` + warn log | ✅ `gate-auto-correct.test.ts` |
| 8 | `auto_correct` + exception during application | **No** (restore original) | `proposed` emitted, `applied` NOT emitted | `undefined` + warn log | ✅ `gate-auto-correct.test.ts` |
| 9 | `block` decision | **No** | `rulehost_blocked` + `rule_enforced` | Block result | ✅ Both test files |
| 10 | `requireApproval` decision | **No** | `rulehost_requireApproval` + `rule_enforced` | `undefined` (allow) | ✅ Both test files |
| 11 | `allow` decision | **No** | `rulehost_evaluated` | `undefined` (allow) | ✅ Both test files |
| 12 | Multiple correctedFields, all valid | **Yes** (atomic) | `applied` with all fields | Warning if notifyAgent | ✅ `gate-auto-correct.test.ts` |
| 13 | `correctedFields[].proposed` differs from `proposedParams[field]` | Uses `proposedParams` | `applied` shows `proposedParams` value | — | ✅ `gate-auto-correct.test.ts` |
| 14 | `notifyAgent=true` | As per mode | As per mode | Warning string with field details | ✅ `gate-auto-correct.test.ts` |
| 15 | `notifyAgent=false` | As per mode | As per mode | `undefined` | ✅ `gate-auto-correct.test.ts` |
| 16 | RuleHost.evaluate throws | **No** | None (degraded) | `undefined` (allow) | ✅ Implicit in gate.ts catch |
| 17 | Partial correctedFields — unlisted fields untouched | **No mutation on unlisted** | `applied` with only listed fields | — | ✅ `gate-auto-correct.test.ts` |
| 18 | Malformed correctedFields entries (non-object, null) | **No** (fail-open) | `proposed` (validationValid=false), no `applied` | `undefined` | ✅ `gate-auto-correct.test.ts` |
| 19 | Unsupported channel in dispatcher | **N/A** | `refused` (no_writer_for_channel) | — | ✅ Dispatcher tests |
| 20 | `code_tool_hook` always routes to approval queue | **N/A** | `queued_for_approval` | — | ✅ `rule-host-writer.test.ts` |

---

## 4. Verified Test Inventory

### Core activation tests (`packages/principles-core/src/runtime-v2/activation/__tests__/`)

| Test File | Tests | Key Scenarios |
|-----------|-------|---------------|
| `activation-dispatcher.test.ts` | 25 | Low-risk activation, high-risk refusal, idempotency, auto-promotion, approval context fields, DB failure fail-closed |
| `approval-queue.test.ts` | — | Queue CRUD, approve/reject idempotency |
| `approval-store-extended.test.ts` | — | SQLite store, filtering, pagination |
| `memory-activation-state-store.test.ts` | — | In-memory activation state |
| `sqlite-activation-state-store.test.ts` | — | SQLite activation state |
| `sqlite-approval-store.test.ts` | — | SQLite approval store |

### RuleHostWriter tests (`packages/principles-core/src/runtime-v2/activation/writers/__tests__/`)

| Test File | Tests | Key Scenarios |
|-----------|-------|---------------|
| `rule-host-writer.test.ts` | 20 | canActivate validation, activate returns shadow, buildApprovalContext fields, dispatcher integration, malformed artifact refusal |

### Gate auto_correct tests (`packages/openclaw-plugin/tests/hooks/`)

| Test File | Tests | Key Scenarios |
|-----------|-------|---------------|
| `gate-auto-correct.test.ts` | 10 | Live mode + valid/invalid, shadow mode, notifyAgent, multiple fields, fail-open, proposedParams precedence, block precedence |
| `gate-auto-correct-shadow.test.ts` | 9 | Shadow mode, live mode (PRI-174), telemetry, invalid proposal, missing pluginConfig, no proposal |

### Architecture regression test

| Test File | Relevant Entries |
|-----------|-----------------|
| `architecture-regression.test.ts` | `activation/writers/rule-host-writer.ts`, `activation/writers/index.ts` in REQUIRED_SOURCE_FILES; `rule-host-writer.test.ts` in REQUIRED_TEST_FILES |

---

## 5. Test Gaps Identified And Closed

### GAP-1: Partial correctedFields — unlisted fields must remain untouched

**Risk:** If `Object.assign(event.params, nextParams)` somehow introduces extra keys, unlisted params could be silently modified.

**Current state:** Closed in this PR. `gate-auto-correct.test.ts` now verifies that a param NOT in `correctedFields` remains unchanged after live auto_correct.

**Resolution:** Added a test that applies live auto_correct to `content` only and verifies `file_path` and unrelated params are unchanged.

### GAP-2: Malformed correctedFields entries trigger fail-open

**Risk:** If `correctedFields` contains non-object entries (e.g., `[42, null, "string"]`), the gate.ts code should throw and trigger fail-open.

**Current state:** Closed in this PR. `gate-auto-correct.test.ts` now covers malformed `correctedFields` entries specifically.

**Resolution:** Added a test with `correctedFields: [42, null, "string"]` and verified no mutation, no `applied` event, and `validationValid=false`.

### GAP-3: auto_correct applied event content completeness

**Observation:** `RuleHostAutoCorrectAppliedEventData` contains `{ field, original, applied }[]` for correctedFields, plus `toolName`, `filePath`, `ruleId`, `principleId`, `confidence`, `reason`. It does NOT include `applicationMode` or the full proposal.

**Assessment:** This is correct by design — the `proposed` event carries `applicationMode` and full context; the `applied` event confirms what was actually mutated. An operator can correlate the two events by `ruleId` + timestamp. No code change needed, but this should be documented for operator awareness.

### GAP-4: validateCorrectionProposal does not cross-check correctedFields against proposedParams

**Observation:** The pure validator in `correction-proposal.ts` validates `correctedFields` structure and `proposedParams` shape independently, but does not verify that each `correctedFields[].field` has a corresponding key in `proposedParams`. This cross-check happens at runtime in `gate.ts` (lines 215-221).

**Assessment:** The runtime check in gate.ts prevents unsafe mutation, but ATTACK-5 documents this as a pure-validator quality gap. A follow-up should make `validateCorrectionProposal()` reject `correctedFields` entries whose `field` is absent from `proposedParams`, so invalid agent output is rejected before the plugin gate has to fail open.

---

## 6. Remaining Risks

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| R1 | **No config gate for live auto_correct in production** — `applicationMode='live'` is solely determined by the rule implementation. There is no workspace-level or global config to disable live mode. | Medium | Phase 1B should add a `autoCorrectLiveEnabled` config flag (default: false) that gates live mode at the plugin level, independent of rule decisions. |
| R2 | **No rate limiting on auto_correct** — Multiple auto_corrects could be applied in rapid succession without throttling. | Low | Monitor via `rulehost_auto_correct_applied` event frequency. Add rate limiting in Phase 1B if needed. |
| R3 | **Bash mutation detection is heuristic** — The regex-based bash mutation detection could miss edge cases or produce false positives. | Low | Acceptable for Phase 1A. Bash auto_correct is unlikely in practice. |
| R4 | **Event data asymmetry** — `proposed` event has `correctedFields: string[]` (field names), `applied` event has `correctedFields: { field, original, applied }[]`. Operators must correlate both events for full picture. | Low | Document in operator guide. Consider unifying in Phase 1B. |
| R5 | **RuleHostWriter.activate always returns shadow action** — Even if the artifact passes all gates, the activation action is `code_tool_hook_shadow_activate`. Live activation is not yet implemented at the writer level. | By design | Phase 1B will implement live activation path in RuleHostWriter. |
| R6 | **RefinerRuleHostGate forces applicationMode='shadow'** — Even if `requestedMode='live'`, the gate forces shadow with a reason string. | By design | Phase 1B will implement live gate path with additional validation. |

---

## 7. Phase 1B Prerequisites

Before starting Phase 1B (RuleHost live rollout), the following should be in place:

1. **Config gate for live auto_correct** — Add `autoCorrectLiveEnabled` workspace config (default: false). Gate.ts should check this flag before applying live corrections, regardless of `proposal.applicationMode`.

2. **RefinerRuleHostGate live mode support** — Currently `requestedMode='live'` is rejected with a reason. Phase 1B must define what additional validation is required for live mode (e.g., higher sandbox coverage, operator pre-approval).

3. **RuleHostWriter live activation path** — Currently `activate()` always returns `code_tool_hook_shadow_activate`. Phase 1B must implement a live activation path that writes the rule to the active implementations directory.

4. **Integration test for end-to-end live auto_correct** — A test that exercises the full path: artifact creation → dispatcher → writer → gate → live correction → event logging.

5. **Operator documentation** — Document the event correlation pattern (proposed + applied), the config gate, and the approval workflow for code_tool_hook activation.

6. **Rate limiting for auto_correct** — Consider adding a per-session or per-rule rate limit to prevent rapid successive corrections.

---

## 8. FROZEN LEGACY Compliance

Confirmed: No modifications to `nocturnal-trinity.ts`, `nocturnal-arbiter.ts`, or `nocturnal-service.ts` in any Phase 1A commit.

---

## 9. Architecture Regression Test Compliance

The architecture regression test (`packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts`) includes:

- **Source files:** `activation/writers/rule-host-writer.ts`, `activation/writers/index.ts`
- **Test files:** `rule-host-writer.test.ts`

All required entries are present. No updates needed.

---

## 10. Summary

Phase 1A is **complete and safe for production shadow mode**. The key safety properties are verified:

1. ✅ Live auto_correct only occurs when `applicationMode='live'` AND `validateCorrectionProposal()` passes
2. ✅ Shadow / unsupported / malformed / partial correction all fail loud (telemetry) or fail open (no mutation)
3. ✅ Event logging is complete across all 5 RuleHost event types
4. ✅ Approval context provides sufficient information for operator risk assessment
5. ✅ FROZEN LEGACY files are untouched
6. ✅ Architecture regression tests include Phase 1A entries

GAP-1 and GAP-2 were closed in this PR. The added attack smoke tests also surfaced two follow-up bugs outside this retrospective's fix scope: PITask hydration accepts non-peer task kinds, and `validateCorrectionProposal()` does not cross-check `correctedFields` against `proposedParams`.
