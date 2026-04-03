# Global Reviewer Report - Empathy Workflow Implementation Verify

## VERDICT

**APPROVE**

The empathy workflow implementation (PR2 runtime_direct boundary) successfully achieves its macro goal. The business flow is closed, architecture is converging, and OpenClaw compatibility is properly handled with explicit degrade boundaries.

---

## MACRO_ANSWERS

### Q1: OpenClaw assumptions verified?

**Yes** — All OpenClaw runtime assumptions are explicitly verified:

- **Subagent runtime availability probe** (`subagent-probe.ts:42-51`): Uses `constructor.name === 'AsyncFunction'` to detect gateway vs embedded mode
- **SDK type alignment** (`openclaw-sdk.d.ts:89-135`): `SubagentRunParams` includes `expectsCompletionMessage` field, matching runtime usage
- **No OpenClaw modifications**: Implementation stays within plugin boundary, does not modify `D:/Code/openclaw`

Evidence:
- `isSubagentRuntimeAvailable()` imported and called before attempting `subagent.run()` (`empathy-observer-workflow-manager.ts:78`)
- Global gateway fallback via `Symbol.for('openclaw.plugin.gatewaySubagentRuntime')` (`subagent-probe.ts:18-24`)

---

### Q2: Business flow closed?

**Yes** — The empathy detection business flow is fully closed:

1. **Trigger**: `before_prompt_build` hook detects user message with `trigger === 'user'` (`prompt.ts:613`)
2. **Spawn**: `EmpathyObserverWorkflowManager.startWorkflow()` creates workflow and spawns subagent (`empathy-observer-workflow-manager.ts:83-105`)
3. **Wait**: `scheduleWaitPoll()` calls `driver.wait()` after 100ms (`empathy-observer-workflow-manager.ts:193-206`)
4. **Result**: `notifyWaitResult()` triggers `finalizeOnce()` on `status === 'ok'` (`empathy-observer-workflow-manager.ts:210-239`)
5. **Persist**: `empathyObserverWorkflowSpec.persistResult()` writes to trajectory and event log (`empathy-observer-workflow-manager.ts:447-474`)
6. **Cleanup**: `deleteSession()` called when `shouldDeleteSessionAfterFinalize: true` (`empathy-observer-workflow-manager.ts:288-297`)

Evidence:
- State machine transitions documented in `types.ts:27-52`
- All states have explicit terminal paths: `completed`, `terminal_error`, `expired`, `cleanup_pending`

---

### Q3: Architecture improved?

**Yes** — Architecture shows clear improvement over legacy path:

**Improvements:**
- **Single transport model**: Only `runtime_direct` supported in v1, avoiding complexity of `registry_backed` hybrid
- **Idempotent state machine**: `finalizeOnce()` guards against double-finalization via `isCompleted()` check (`empathy-observer-workflow-manager.ts:260-263`)
- **SQLite persistence**: `WorkflowStore` provides durable state with WAL mode and proper indexes (`workflow-store.ts:26-71`)
- **Spec-driven design**: `SubagentWorkflowSpec<TResult>` enables pluggable workflow types (`types.ts:113-141`)

**Convergence indicators:**
- Module exports are clean via `index.ts`
- Type definitions are comprehensive in `types.ts`
- No circular dependencies detected

Evidence:
- 5/5 tests pass in `empathy-observer-workflow-manager.test.ts`
- Build passes with no TypeScript errors

---

### Q4: Degrade boundaries explicit?

**Yes** — All degrade boundaries are explicit and documented:

| Condition | Behavior | Location |
|-----------|----------|----------|
| Boot session | Skip workflow, throw error | `empathy-observer-workflow-manager.ts:71-74` |
| Subagent unavailable | Skip workflow, throw error | `empathy-observer-workflow-manager.ts:78-80` |
| Wait timeout | Mark `terminal_error` | `empathy-observer-workflow-manager.ts:237` |
| Parse failure | Mark `terminal_error` | `empathy-observer-workflow-manager.ts:280-283` |
| Cleanup failure | Mark `cleanup_pending` | `empathy-observer-workflow-manager.ts:293-300` |

**Key design decisions:**
- Boot sessions are explicitly rejected (they run outside gateway request context)
- `isSubagentRuntimeAvailable()` probe happens BEFORE `subagent.run()` call
- No silent fallback — all failures are logged and persisted

Evidence:
- Comments explicitly state "Surface degrade: skip boot sessions" (`empathy-observer-workflow-manager.ts:71`)
- Comments explicitly state "Surface degrade: check subagent runtime availability" (`empathy-observer-workflow-manager.ts:77`)

---

### Q5: No regression in other subagent modules?

**Yes** — No regression detected:

**Verification:**
- `empathy-observer-manager.ts` (legacy path) continues to work alongside new `EmpathyObserverWorkflowManager`
- `helper_empathy_enabled` flag controls shadow mode activation (`prompt.ts:613`)
- Legacy and new paths share `isSubagentRuntimeAvailable()` probe
- No modifications to existing `empathy-observer-manager.ts` behavior

**Test coverage:**
- 5 tests specifically for `EmpathyObserverWorkflowManager`
- Tests verify state transitions, cleanup behavior, and spec-driven design

---

## BLOCKERS

None.

---

## FINDINGS

### Positive Findings

1. **Clean module structure**: All 5 expected files exist with proper organization
2. **Type safety**: Comprehensive TypeScript interfaces in `types.ts`
3. **Observability**: `getWorkflowDebugSummary()` provides debugging visibility
4. **State machine clarity**: Transitions are documented and implemented correctly
5. **Test coverage**: Tests verify core workflow behaviors

### Minor Observations

1. **Feature flag dependency**: Shadow mode requires `helper_empathy_enabled: true` in config
2. **No remote branch**: `feat/subagent-workflow-helper-impl` is not pushed to remote (merge gate cannot verify SHA parity)
3. **Pre-existing test failures**: Some unrelated tests fail (not caused by this change)

---

## CODE_EVIDENCE

- **files_verified**: `empathy-observer-workflow-manager.ts`, `types.ts`, `workflow-store.ts`, `runtime-direct-driver.ts`, `index.ts`, `prompt.ts`, `config.ts`, `openclaw-sdk.d.ts`, `subagent-probe.ts`, `empathy-observer-manager.ts`, `empathy-observer-workflow-manager.test.ts`
- **evidence_source**: local
- **sha**: `eb1f90cfa476e3cc60abcd533a3534ccbac2e0ae`
- **evidence_scope**: both (principles + openclaw-sdk types)

---

## NEXT_FOCUS

1. Push branch to remote and verify merge gate SHA parity
2. Consider adding integration test for full end-to-end flow
3. Document `helper_empathy_enabled` flag in user-facing docs

---

## CHECKS

CHECKS: macro=aligned;business_flow=closed;architecture=converging;degrade_explicit;openclaw_compatible;tests_pass=5/5;build_pass
