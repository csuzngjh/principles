# Phase 30: Runtime & Truth Contract Framing - Context

**Gathered:** 2026-04-12
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the recent post-deployment failures into an explicit contract matrix for the production path on top of `fix/bugs-231-228` / `PR #245`.

This phase is a diagnosis-freezing phase, not an implementation-heavy phase. Its job is to prevent the team from re-arguing the problem every time a new bug appears.

**Scope:**
- Define the runtime boundaries that still rely on inferred OpenClaw behavior
- Define the truth boundaries where exports/datasets/promotions may overstate facts
- Separate "must-fix before merging PR #245" from "belongs to v1.15 hardening"
- Produce concrete success criteria for Phase 31-33

**NOT in scope:**
- Large code refactors
- Rewriting nocturnal architecture
- Absorbing `PR #243` wholesale
- Replay-engine-wide redesign

</domain>

<decisions>
## Implementation Decisions

### Baseline Strategy
- **D-01:** Treat `fix/bugs-231-228` / `PR #245` as the structural baseline. New milestone work stacks on top of it rather than replacing it.

### Diagnosis
- **D-02:** The root problem is no longer framed as only "file/path boundary gaps". It is now "runtime contract gaps + truth contract gaps".

### Merge Strategy
- **D-03:** `PR #243` is a repair source, not an independent merge target. Valuable fixes may be cherry-picked or reimplemented onto the `PR #245` line.

### Evidence Rule
- **D-04:** Any artifact used for training, promotion, or principle evaluation must only assert facts backed by source metadata. Missing evidence must remain unknown.

### Claude's Discretion
- Exact format of the contract matrix
- Whether merge-gate items are tracked inside the phase docs or a dedicated checklist file
- Exact partition between Phase 31 and Phase 32 tasks

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

- `.planning/PROJECT.md`
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`
- `.planning/phases/29-integration-verification/29-VERIFICATION.md`
- `docs/handoffs/nocturnal-trinity-runEmbeddedPiAgent-debug.md`
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`
- `packages/openclaw-plugin/src/core/nocturnal-export.ts`
- `packages/openclaw-plugin/src/service/nocturnal-service.ts`
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts`

</canonical_refs>

<code_context>
## Existing Code Insights

### Stable Baseline from v1.14
- `EvolutionQueueStore`, `PainFlagDetector`, `EvolutionTaskDispatcher`, `WorkflowOrchestrator`, and `TaskContextBuilder` now exist as dedicated seams
- Fallback classification exists through `fallback-audit.ts`
- Workspace and snapshot contracts already have precedent implementations

### New Failure Layer
- Runtime semantics are still partly guessed: embedded agent execution, model/provider selection, session artifact behavior
- Export semantics can still drift from evidence: training-facing text may imply pain/failure/violation even when source evidence is absent
- Diagnostics improved, but observability is still not yet a machine-checkable invariant system

### Merge-Gate Reality
- `PR #245` is the branch baseline but still has known review defects and is not yet mergeable
- Those defects should be documented as dependencies, not folded into vague future work

</code_context>

<specifics>
## Specific Ideas

- Produce a contract matrix with columns like: boundary, source of truth, accepted inputs, rejection mode, fallback policy, emitted diagnostics, tests
- Produce a merge-gate checklist with two buckets:
  1. must fix before merging `PR #245`
  2. safe to defer into v1.15 hardening
- Name failure classes explicitly so future logs and tests can align to them

</specifics>

<deferred>
## Deferred Ideas

- Replay engine-wide contract hardening
- Broader event log schema validation
- General cleanup unrelated to production trust

</deferred>

---

*Phase: 30-runtime-and-truth-contract-framing*
*Context gathered: 2026-04-12*
