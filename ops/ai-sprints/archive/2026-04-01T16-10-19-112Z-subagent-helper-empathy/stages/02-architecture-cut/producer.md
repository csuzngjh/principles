# Producer Report — Stage 02-architecture-cut, Round 2

## SUMMARY

**Task**: Subagent Helper: migrate empathy observer to workflow helper  
**Stage**: architecture-cut  
**Round**: 2  
**Status**: Complete — all contract deliverables reached DONE

Round 2 addresses Reviewer B's blockers from Round 1:
1. **Blocker 1 (shadow_run_plan)**: Previously a high-level outline. Now enhanced with concrete quantitative metrics, phase thresholds, rollback triggers, and shadow result collection schema.
2. **Blocker 2 (helper_interface_draft)**: Previously prose in markdown. Now created as actual TypeScript code artifact at `packages/openclaw-plugin/src/service/subagent-workflow/types.ts`.

---

## ARCHITECTURE_DECISION

### Decision: MIGRATE empathy observer to workflow helper

**Transport**: `runtime_direct` (unchanged from Round 1)

### Rationale (from Round 1, unchanged)

1. **Design doc alignment**: Section 12.1 of `2026-03-31-subagent-workflow-helper-design.md` explicitly designates empathy observer as the first candidate for helper migration.
2. **Workflow boundaries clear**: Empathy observer has well-defined lifecycle: spawn → wait → parse → persist → cleanup.
3. **Structured JSON result**: Child result is machine-parseable, enabling consistent `parseResult` implementation.
4. **Existing issues exposed**: The current `EmpathyObserverManager` has timeout/fallback/cleanup issues that helper addresses.
5. **PR2 scope compliance**: Empathy observer + deep-reflect only. Diagnostician/Nocturnal NOT migrated in this PR.

### Architecture (from Round 1)

- Helper lives at `packages/openclaw-plugin/src/service/subagent-workflow/`
- `runtime_direct` driver handles: `subagent.run()`, `waitForRun()`, `getSessionMessages()`, `deleteSession()`
- Empathy observer becomes a `SubagentWorkflowSpec<EmpathyResult>` implementation
- Dual-path execution during shadow mode: old path primary, new path shadow

---

## OPENCLAW_ASSUMPTIONS_VERIFIED

All assumptions verified in Round 1 via cross-repo source reading in `D:/Code/openclaw`:

| Assumption | Verified | Evidence |
|------------|----------|----------|
| `subagent_ended` hook fires for `runtime_direct` with `expectsCompletionMessage: true` | YES | `subagent-registry-lifecycle.ts:521-533` |
| Hook timing is DEFERRED | YES | `subagent-registry-lifecycle.ts:137-154` |
| `runtime.subagent.run()` dispatches to gateway | YES | `server-plugins.ts:327-347` |
| Outcome mapping is correct | YES | `completion.ts:32-42` |
| Deduplication works | YES | `completion.ts:58-63` |

**evidence_scope**: both (principles + openclaw)  
**sha**: 4138178581043646365326ee42dad4eab4037899

---

## INTERFACE_DESIGN

### Round 2 Deliverable: TypeScript Code Artifact

Created `packages/openclaw-plugin/src/service/subagent-workflow/types.ts` with complete type definitions:

```typescript
// Core types
export type WorkflowTransport = 'runtime_direct' | 'registry_backed';
export type WorkflowState = 'pending' | 'active' | 'wait_result' | 'finalizing' | 'completed' | 'terminal_error' | 'cleanup_pending';

// Main interfaces
export interface SubagentWorkflowSpec<TResult> {
    workflowType: string;
    transport: WorkflowTransport;
    timeoutMs: number;
    ttlMs: number;
    shouldDeleteSessionAfterFinalize: boolean;
    parseResult: (ctx: WorkflowResultContext) => Promise<TResult | null>;
    persistResult: (ctx: WorkflowPersistContext<TResult>) => Promise<void>;
    shouldFinalizeOnWaitStatus: (status: 'ok' | 'error' | 'timeout') => boolean;
}

export interface WorkflowManager {
    startWorkflow: <TResult>(spec, options) => Promise<WorkflowHandle>;
    notifyWaitResult: (workflowId, status, error?) => Promise<void>;
    notifyLifecycleEvent: (workflowId, event, data?) => Promise<void>;
    finalizeOnce: (workflowId) => Promise<void>;
    sweepExpiredWorkflows: (maxAgeMs?) => Promise<number>;
}

// Empathy-specific
export interface EmpathyObserverWorkflowSpec extends SubagentWorkflowSpec<EmpathyResult> {
    workflowType: 'empathy-observer';
    transport: 'runtime_direct';
    timeoutMs: 30_000;
    ttlMs: 300_000; // 5 minutes
    shouldDeleteSessionAfterFinalize: true;
}
```

### Key Interface Methods

| Method | Purpose |
|--------|---------|
| `startWorkflow()` | Creates workflow, spawns subagent, returns handle |
| `notifyWaitResult()` | runtime_direct path: feeds wait result to state machine |
| `notifyLifecycleEvent()` | registry_backed path: feeds hook events to state machine |
| `finalizeOnce()` | Idempotent: read → parse → persist → cleanup |
| `sweepExpiredWorkflows()` | Orphan cleanup, called periodically |

### State Machine

```
PENDING → ACTIVE → WAIT_RESULT → FINALIZING → COMPLETED
                ↓              ↓
            terminal_error ←──┴── cleanup_pending
```

---

## TRADE_OFFS

### What We Gained (Round 2 improvements)

1. **Concrete shadow_run_plan**: Quantitative metrics enable objective go/no-go decisions
2. **Proper type artifact**: TypeScript types serve as living documentation
3. **Rollback triggers defined**: Clear actions when metrics violate thresholds

### Remaining Trade-offs

| Trade-off | Decision | Rationale |
|-----------|----------|-----------|
| State machine complexity vs. simplicity | Accept complexity | Unifies dual-path lifecycle under single state machine |
| Shadow mode overhead | Accept overhead | 2-week shadow period before canary |
| Helper indirection vs. direct calls | Accept indirection | Helper provides consistency, deduplication, cleanup |
| Type definitions add files | Accept new file | types.ts is necessary for API contract |

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Helper kernel instability | Phased rollout: shadow → canary → full |
| Double-write during shadow | Dedup key ensures single persistence |
| Cleanup semantics change | SweepExpiredWorkflows with TTL cleanup |
| OpenClaw upgrade breaks assumptions | Cross-repo verification done in Round 1 |

---

## CHECKS

**CHECKS**: evidence=ok;tests=not-run;scope=pd-only;prompt-isolation=confirmed;openclaw-verification=done-cross-repo;architecture-decision=migrated;types-file=created;shadow-plan=concrete-metrics

---

## CONTRACT

- architecture_decision status: DONE
- openclaw_cross_repo_verification status: DONE
- helper_interface_draft status: DONE
- shadow_run_plan status: DONE

---

## KEY_EVENTS

- [x] CP-1: Round 2 started, analyzed Round 1 reviewer feedback
- [x] CP-2: Created `types.ts` code artifact at `packages/openclaw-plugin/src/service/subagent-workflow/types.ts`
- [x] CP-3: Created `shadow_run_plan.md` with 4 phases, quantitative thresholds, rollback triggers
- [x] CP-4: Verified all 4 contract deliverables are DONE

---

## HYPOTHESIS_MATRIX

| Hypothesis | Status | Evidence |
|-----------|--------|----------|
| Migration to helper will improve empathy observer reliability | UNTESTED | Shadow mode will validate |
| State machine will correctly handle timeout/error/cleanup paths | ASSUMED | Design doc + Round 1 review |
| Helper will reduce session leaks | ASSUMED | TTL-based sweep mechanism |
| New path will produce same results as old path | UNTESTED | Shadow mode required (≥95% match threshold) |

---

## CODE_EVIDENCE

- files_checked: empathy-observer-manager.ts, subagent.ts, openclaw-sdk.d.ts, 2026-03-31-subagent-workflow-helper-design.md
- evidence_source: both
- sha: 4138178581043646365326ee42dad4eab4037899 (from Round 1 OpenClaw verification)
- branch/worktree: main
- types_file: packages/openclaw-plugin/src/service/subagent-workflow/types.ts
- shadow_plan_file: ops/ai-sprints/.../stages/02-architecture-cut/shadow_run_plan.md
