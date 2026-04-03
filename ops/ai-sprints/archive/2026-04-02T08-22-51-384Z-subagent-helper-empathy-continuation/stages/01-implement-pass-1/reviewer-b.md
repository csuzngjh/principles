# Reviewer B Report — implement-pass-1 round 1

## VERDICT
**REVISE**

## DIMENSIONS
- correctness: 3/5
- scope_control: 3/5
- interface_adherence: 3/5
- shadow_run_validity: 2/5

## BLOCKERS

1. **CRITICAL: No git commit** — The brief explicitly requires "DO NOT claim DONE without actual file creation and git commit." The `subagent-workflow/` directory and test file are untracked (`??` in git status). No commit was made.

2. **Shadow mode not correctly implemented** — The brief requires running shadow mode "alongside existing empathy observer path only on surfaces explicitly marked sidecar_allowed." The new `EmpathyObserverWorkflowManager` is gated behind `helper_empathy_enabled === true` (prompt.ts line 613), but:
   - The existing `empathyObserverManager.spawn()` (line 611) runs unconditionally — it is NOT shadow mode, it is the PRIMARY path.
   - No `sidecar_allowed` surface/flag exists in the code.
   - The new workflow runs ONLY when the config flag is true, not as a shadow alongside the existing path.

## FINDINGS

### What Was Actually Implemented (Positive)

| Component | Status | Evidence |
|---|---|---|
| `subagent-workflow/types.ts` | ✅ Complete | 321 lines, full state machine types, `WorkflowManager` interface, `SubagentWorkflowSpec`, empathy types |
| `subagent-workflow/workflow-store.ts` | ✅ Complete | 225 lines, SQLite schema, full CRUD + event recording, indexes |
| `subagent-workflow/runtime-direct-driver.ts` | ✅ Complete | 161 lines, `TransportDriver` interface, `RuntimeDirectDriver` implementation |
| `empathy-observer-workflow-manager.ts` | ✅ Complete | 584 lines, `EmpathyObserverWorkflowManager`, idempotent `startWorkflow/notifyWaitResult/finalizeOnce`, `empathyObserverWorkflowSpec` |
| `subagent-workflow/index.ts` | ✅ Complete | Proper re-exports |
| `prompt.ts` integration | ✅ Partial | `helper_empathy_enabled` config added, shadow manager instantiated |
| `openclaw-sdk.d.ts` update | ✅ | `expectsCompletionMessage?: boolean` added to `SubagentRunParams` line 93 |
| `utils/subagent-probe.ts` | ✅ | Exists, used by workflow manager for surface degrade |
| Build (tsc) | ✅ Pass | `npm run build` succeeds with no errors |
| Tests | ✅ Partial | `empathy-observer-workflow-manager.test.ts` passes 5/5 tests, but test file is untracked |
| Workflow test | ✅ | `npx vitest run tests/service/empathy-observer-workflow-manager.test.ts` — 5 passed, 574ms |

### Scope Issues

1. **Shadow mode is not truly shadow** — The new workflow runs as an ALTERNATIVE path (when flag is set), not alongside the existing empathy observer. Brief says "only on surfaces explicitly marked sidecar_allowed" — no such marker exists.

2. **Duplicate `extractAssistantText` and `parseEmpathyPayload`** — `empathy-observer-workflow-manager.ts` defines these as both instance methods (lines 356-395) AND module-level functions (lines 436-471). The instance methods are unused (spec uses module-level functions). This is dead code.

3. **`subagent_ended` lifecycle handling is stub-level** — `notifyLifecycleEvent()` only forwards to `notifyWaitResult` if `event === 'subagent_ended'`. This is correct per the "fallback/observation only" constraint, but there is no actual shadow run comparison evidence.

### Correctness Issues

1. **State machine: `notifyWaitResult` does state transition to `wait_result` before checking `shouldFinalize`** — If `finalizeOnce()` throws (line 285), the state is already `wait_result` but workflow is not terminal. However, the catch re-throws and sets `terminal_error` — so correctness holds.

2. **Idempotency: `isCompleted()` uses 5-minute TTL** — This is reasonable but not documented. `completedWorkflows` Map is in-memory only (lost on restart).

3. **No actual shadow run evidence** — The brief requires "shadow_run_evidence" as a deliverable. The code shows the integration but there is no runtime evidence of the shadow path being exercised.

### Interface Compliance

| Interface | Compliant | Notes |
|---|---|---|
| `WorkflowManager` (types.ts) | ✅ | All 5 methods: `startWorkflow`, `notifyWaitResult`, `notifyLifecycleEvent`, `finalizeOnce`, `sweepExpiredWorkflows`, `getWorkflowDebugSummary` |
| `TransportDriver` (runtime-direct-driver.ts) | ✅ | `run`, `wait`, `getResult`, `cleanup` |
| `WorkflowStore` | ✅ | Full SQLite persistence with events |
| Shadow config | ⚠️ | `helper_empathy_enabled` is NOT `sidecar_allowed` per brief |

## CODE_EVIDENCE

- files_verified: `packages/openclaw-plugin/src/service/subagent-workflow/types.ts`, `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts`, `packages/openclaw-plugin/src/service/subagent-workflow/runtime-direct-driver.ts`, `packages/openclaw-plugin/src/service/subagent-workflow/empathy-observer-workflow-manager.ts`, `packages/openclaw-plugin/src/service/subagent-workflow/index.ts`, `packages/openclaw-plugin/src/hooks/prompt.ts`, `packages/openclaw-plugin/src/openclaw-sdk.d.ts`, `packages/openclaw-plugin/src/utils/subagent-probe.ts`, `packages/openclaw-plugin/tests/service/empathy-observer-workflow-manager.test.ts`
- evidence_source: local
- sha: `bb44012` (HEAD)
- evidence_scope: both

## CONTRACT CHECK (Producer's self-assessment)

The producer report does NOT contain a CONTRACT section. Unable to verify self-assessment against evidence.

## HYPOTHESIS_MATRIX

| Hypothesis | Likelihood | Evidence |
|---|---|---|
| Files were created in previous sprint run but lost before this session | LOW | No git history for `subagent-workflow/` directory |
| Files were created in this session but commit was forgotten | HIGH | Files exist, build passes, test passes, no git commit |
| Shadow mode is implemented differently (not as "alongside") | HIGH | Code shows alternative path (config flag), no `sidecar_allowed` marker |
| The `helper_empathy_enabled` flag IS the `sidecar_allowed` equivalent | MEDIUM | Could be argued, but brief language is specific about "surfaces marked" not config keys |

## NEXT_FOCUS

1. **Make git commit** — All deliverable files exist, build passes, tests pass. Only missing step is `git add && git commit`.

2. **Clarify shadow mode semantics** — If `helper_empathy_enabled` is the intended `sidecar_allowed` mechanism, this should be documented. If not, the integration needs to be restructured so both empathy paths run simultaneously on the same surface.

3. **Remove dead code** — The duplicate `extractAssistantText`/`parseEmpathyPayload` functions (instance vs module-level).

4. **Add shadow_run_evidence** — Brief requires "shadow run evidence" as a deliverable but no runtime evidence exists.

## CHECKS

CHECKS: criteria=partial;blockers=2;verification=build_ok_tests_ok_no_commit_no_shadow_evidence

---

## APPENDIX: Key Code Evidence

### prompt.ts shadow integration (lines 609-627)
```typescript
if (trigger === 'user' && sessionId && api && !isAgentToAgent) {
  prependContext = '### BEHAVIORAL_CONSTRAINTS\n' + empathySilenceConstraint + '\n\n' + prependContext;
  // PRIMARY path — always runs
  empathyObserverManager.spawn(api, sessionId, latestUserMessage, workspaceDir).catch((err) => api.logger.warn(String(err)));

  // SHADOW path — only when flag is true
  if (api.config?.empathy_engine?.helper_empathy_enabled === true && workspaceDir) {
    const shadowManager = new EmpathyObserverWorkflowManager({...});
    shadowManager.startWorkflow(empathyObserverWorkflowSpec, {...}).catch((err) => ...);
  }
}
```

The brief says "Run shadow mode alongside existing empathy observer path **only on surfaces explicitly marked sidecar_allowed**" — but there is no `sidecar_allowed` surface marker. The existing path is unconditional, the new path is config-gated.

### Git status (working tree)
```
?? packages/openclaw-plugin/src/service/subagent-workflow/    [UNTRACKED]
?? packages/openclaw-plugin/tests/service/empathy-observer-workflow-manager.test.ts  [UNTRACKED]
 M packages/openclaw-plugin/src/core/config.ts              [MODIFIED]
 M packages/openclaw-plugin/src/hooks/prompt.ts               [MODIFIED]
 M packages/openclaw-plugin/src/openclaw-sdk.d.ts            [MODIFIED]
```

No files in `subagent-workflow/` have any git history. This is a new directory with no commits.
