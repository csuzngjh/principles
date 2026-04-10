# Phase 18: Live Replay and Operator Validation - Context

**Gathered:** 2026-04-10
**Status:** Ready for planning

<domain>
## Phase Boundary

This phase verifies that the stabilized nocturnal system (Phases 16+17) can execute one real replay/eval path end-to-end, and that operator guidance matches the actual workflow.

**Scope:**
- Run `sleep_reflection` task with bootstrapped rules (Phase 17 output) through the full workflow loop
- Verify the workflow completes with a truthful status in the workflow store (not `expired` or misleading timeout noise)
- Create operator tooling to validate the live path reproducibly

**Out of scope:**
- Writing real rule implementations (stubs only — BOOT-03)
- New UI or monitoring dashboard work
- Broad principle migration
</domain>

<decisions>
## Implementation Decisions

### LIVE-01: Live Path Scope
- **D-01:** Run `sleep_reflection` end-to-end with at least one bootstrapped principle
- **D-02:** Target entity: the principle(s) seeded by Phase 17 bootstrap (`{principleId}_stub_bootstrap` rule)
- **D-03:** Expected outcome: `NocturnalWorkflowManager.startWorkflow()` completes, workflow store record shows `state='completed'` with explicit `resolution` (e.g., `'marker_detected'`), NOT `expired` or timeout noise
- **D-04:** Stub rules return `action: 'allow (stub)'` — this is expected behavior; the point is the path runs, not that it produces novel results

### LIVE-02: Verification Method
- **D-05:** Verify via workflow store query: `subagent_workflows.db` or `WorkflowStore.listWorkflows()` filtered by `workflow_type='nocturnal'`
- **D-06:** Required evidence:
  - `state='completed'`
  - `resolution` is explicit (not `'expired'`)
  - `metadata_json.snapshot` contains a non-empty session ID
  - `metadata_json` includes `taskId` linking to the evolution queue item
- **D-07:** Do NOT rely on unit tests alone — LIVE-03 requires production-state evidence

### LIVE-03: Operator Guidance
- **D-08:** Create a new CLI script: `scripts/validate-live-path.ts` (or `npm run validate-live-path`)
- **D-09:** Script behavior:
  1. Read bootstrapped principles from `principle_training_state.json`
  2. Trigger a `sleep_reflection` task (inject test session snapshot if needed)
  3. Poll workflow store until the workflow completes (or timeout after 5 min)
  4. Output: workflow ID, state, resolution, metadata summary
  5. Exit code 0 if `state='completed'` and resolution is explicit; non-zero otherwise
- **D-10:** The script is the operator's "smoke test" — repeatable, CI-friendly

### Prior Phase Decisions (carry forward)
- **No new UI work** (Phase 16)
- **Production evidence is the source of truth** (Phase 16)
- **Bootstrap bounded to 2-3 principles** (Phase 17)
- **Stub rules are `status: 'proposed'`** (Phase 17)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Nocturnal Workflow Core
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — `sleep_reflection` task enqueuing and processing, `processEvolutionQueue()`, `NocturnalWorkflowManager.startWorkflow()` call site
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — `startWorkflow()`, `getWorkflowDebugSummary()`, `nocturnalWorkflowSpec`
- `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts` — `getNocturnalSessionSnapshot()`, source of real trajectory data

### Bootstrap and Ledger
- `packages/openclaw-plugin/src/core/bootstrap-rules.ts` — Phase 17 bootstrap: `selectPrinciplesForBootstrap()`, `bootstrapRules()`, stub rule shape
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — `createRule()`, `updatePrinciple()`, `loadLedger()`, LedgerRule and LedgerPrinciple interfaces
- `packages/openclaw-plugin/src/core/principle-training-state.ts` — `loadStore()`, evaluability and violation count data

### State and Workflow Persistence
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — `WorkflowStore`, `listWorkflows()`, `getEvents()`, workflow state machine
- `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` — `WorkflowRow` interface

### Validation Context
- `.planning/phases/17-minimal-rule-bootstrap/17-CONTEXT.md` — Phase 17 decisions (bootstrap scope, stub rule shape, idempotency)
- `.planning/phases/16-nocturnal-snapshot-and-runtime-hardening/16-CONTEXT.md` — Phase 16 decisions (empty snapshot blocking, background-safe runtime, honest failure)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `WorkflowStore` — queryable workflow persistence, already used by watchdog and evolution worker
- `NocturnalWorkflowManager` — `getWorkflowDebugSummary()` returns workflow state and recent events
- `bootstrap-rules.ts` — already selects principles deterministically, can reuse selection logic for validation target

### Established Patterns
- Workflow states: `'pending' | 'active' | 'completed' | 'terminal_error' | 'expired'`
- `resolution` field set on completion: `'marker_detected' | 'auto_completed_timeout' | 'failed_max_retries'`
- Snapshot validity check: `hasUsableNocturnalSnapshot()` in `evolution-worker.ts` already blocks empty fallbacks

### Integration Points
- `sleep_reflection` task is created by `enqueueSleepReflectionTask()` in `evolution-worker.ts`
- Task `resultRef` links back to `workflowId` in `NocturnalWorkflowManager`
- Bootstrap rules linked via `principle.suggestedRules` array in ledger

</code_context>

<specifics>
## Specific Ideas

- **Test session injection**: If no real sessions exist, the validation script may need to inject a minimal synthetic snapshot (with non-zero stats) to prove the path runs. The `hasUsableNocturnalSnapshot()` guard in `evolution-worker.ts` allows non-zero stats or `recentPain > 0`.
- **Bootstrap must run first**: `npm run bootstrap-rules` is a prerequisite — without bootstrapped principles, there's no rule to evaluate.
- **Stub rule evaluation is a no-op**: The stub's `triggerCondition: 'stub: bootstrap placeholder'` and `action: 'allow (stub)'` mean evaluation succeeds but produces no new state. This is expected — the goal is path integrity, not novel output.

</specifics>

<deferred>
## Deferred Ideas

- Real rule implementations (functional `action` returning real decisions) — future phase after Phase 18
- Non-stub rule evaluation producing candidate implementations — future phase
- Full `nocturnal-train` pipeline validation (experiment → trainer → eval → promotion) — separate validation concern

</deferred>

---

*Phase: 18-live-replay-and-operator-validation*
*Context gathered: 2026-04-10*
