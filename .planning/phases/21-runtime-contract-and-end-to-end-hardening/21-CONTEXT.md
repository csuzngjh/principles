# Phase 21: Runtime Contract and End-to-End Hardening - Context

**Gathered:** 2026-04-11  
**Status:** Ready for planning  
**Mode:** Auto-generated from milestone requirements + production debugging + Phase 19/20 outputs

<domain>
## Phase Boundary

This phase hardens the last remaining trust gaps in the production nocturnal path:

- background runtime capability is still inferred from implementation details
- session selection can still drift away from the triggering pain/task window
- some important guarantees are only protected by unit tests, not pipeline-level tests

The phase converts those assumptions into explicit contracts and end-to-end proofs.

**Scope:**
- replace constructor-name runtime guessing with an explicit runtime contract
- distinguish runtime unavailability from downstream workflow execution failure
- time-bound nocturnal candidate/session selection to the triggering task or pain context
- add end-to-end contract tests for workspace writes and pain -> queue -> nocturnal flow

**Out of scope:**
- new nocturnal product features
- UI/dashboard work
- broader cleanup outside runtime and E2E trust boundaries
</domain>

<decisions>
## Implementation Decisions

### Runtime Contract
- **D-01:** `constructor.name === 'AsyncFunction'` is not an acceptable capability contract
- **D-02:** runtime availability should be determined by explicit callable-shape / safe probe semantics, not by JavaScript implementation trivia
- **D-03:** workflow state must preserve whether failure happened before launch (`runtime unavailable`) or after launch (`workflow/pipeline failure`)

### Time-Bounded Selection
- **D-04:** session selection for sleep reflection must not pull snapshots from after the triggering task/pain timestamp
- **D-05:** exact pain-session match remains highest priority, but fallback candidate search must be capped by trigger time
- **D-06:** if no bounded candidate exists, the worker should fail or fallback explicitly instead of silently choosing a newer session

### Test Strategy
- **D-07:** add pipeline-level tests, not just helper tests
- **D-08:** prove workspace writes happen under the active workspace `.state`, never HOME/process cwd fallback
- **D-09:** prove pain signal context survives enqueue and reaches nocturnal selection without session drift

### Delivery Shape
- **D-10:** keep Phase 21 as one execution plan so the remaining milestone work stays tight and mergeable
</decisions>

<canonical_refs>
## Canonical References

**Downstream implementation must read these first:**

- `packages/openclaw-plugin/src/utils/subagent-probe.ts`
- `packages/openclaw-plugin/src/service/evolution-worker.ts`
- `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`
- `packages/openclaw-plugin/src/service/nocturnal-service.ts`
- `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts`
- `packages/openclaw-plugin/src/commands/pd-reflect.ts`
- `packages/openclaw-plugin/src/hooks/pain.ts`

**Existing evidence for this phase:**

- `subagent-probe.ts` still documents and partially relies on `constructor.name === 'AsyncFunction'`
- debug logging in `hooks/prompt.ts` and `evolution-worker.ts` still treats constructor-name as meaningful runtime evidence
- `evolution-worker.ts` candidate fallback still picks the most recent violating session with no trigger-time bound
- milestone requirements explicitly require E2E proofs for pain context preservation, active workspace writes, and time-bounded session selection
</canonical_refs>

<code_context>
## Existing Code Insights

### Runtime Contract Gap
- `isSubagentRuntimeAvailable()` currently accepts non-async late-bound functions, but its documented contract and debug checks are still anchored to `AsyncFunction`
- this makes production reasoning noisy and invites future regressions back to constructor-name guessing

### Time Drift Gap
- the worker already knows `task.timestamp` / `enqueued_at`
- candidate lookup still uses `listRecentNocturnalCandidateSessions({ limit: 20, minToolCalls: 1 })` with no upper time bound
- this means a sleep reflection can attach itself to a newer unrelated session if the original session is missing

### Test Gap
- Phases 19 and 20 added strong unit/regression tests
- the milestone still lacks one focused E2E test set that proves:
  - correct workspace write path
  - correct pain-session preservation
  - bounded nocturnal session selection
</code_context>

<specifics>
## Specific Ideas

- Introduce a small runtime availability contract utility that answers:
  - callable present?
  - late-bound runtime permitted?
  - failure mode before launch vs during launch?
- Add bounded candidate filtering either in `NocturnalTrajectoryExtractor`, `NocturnalTargetSelector`, or the worker call site, but keep the time policy centralized
- Prefer deterministic tests over logging-heavy checks; logs can support diagnosis but should not be the contract
</specifics>

<deferred>
## Deferred Ideas

- broader command cleanup for legacy `process.cwd()` patterns outside milestone-critical paths
- more exhaustive OpenClaw compatibility test matrix
- dashboard surfacing of boundary-contract violations
</deferred>

---

*Phase: 21-runtime-contract-and-end-to-end-hardening*  
*Context gathered: 2026-04-11*
