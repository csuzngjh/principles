# Phase 15: Coverage, Adherence, and Internalization Routing - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Turn the outputs of Phases 11-14 into real lifecycle and internalization decisions.

This phase computes `Rule.coverageRate`, `Rule.falsePositiveRate`, `Principle.adherenceRate`, and deprecated-candidate readiness from replay and live behavior. It also adds the first explicit internalization routing policy so the system can represent "cheapest viable implementation first" instead of defaulting every principle failure to code.

This phase does NOT build LoRA or fine-tuning execution pipelines, does NOT auto-promote code implementations, and does NOT remove Progressive Gate.

</domain>

<decisions>
## Implementation Decisions

### Coverage and adherence accounting
- **D-01:** `Rule.coverageRate` must be computed from behavior, not implementation existence. At minimum it must incorporate replay evidence and implementation stability rather than simply checking whether a rule has an active implementation.
- **D-02:** `Rule.falsePositiveRate` must be grounded in `success-positive` replay failures and live misfire evidence where available.
- **D-03:** `Principle.adherenceRate` must aggregate rule-level coverage and repeated-error reduction. It is a lifecycle metric, not a raw ledger field manually edited by operators.
- **D-04:** `deprecated` candidacy is conservative. A principle can only become a deprecated candidate when lower-layer implementations stably absorb it and repeated violations have dropped.

### Internalization routing
- **D-05:** Phase 15 introduces the first explicit internalization routing policy, but only as a decision layer. It must not build or trigger LoRA / fine-tune pipelines.
- **D-06:** Routing must encode "cheapest viable implementation first" explicitly. For v1.9.0 this means the system can recommend or classify routes such as `skill`, `code`, or `defer`, but not execute all routes.
- **D-07:** Phase 15 must not default all principle failures to code. It must be possible for the routing policy to conclude that a cheaper skill/prompt route is more appropriate.

### Data sources and scope guards
- **D-08:** Coverage and adherence must reuse existing sources created in earlier phases:
  1. principle tree ledger (`Principle -> Rule -> Implementation`)
  2. replay evaluation reports from Phase 13
  3. nocturnal code-candidate lineage and provenance from Phase 14
  4. live implementation state and misfire evidence where already available
- **D-09:** Phase 15 should prefer deterministic calculations and structured policy over LLM judgment loops.
- **D-10:** Phase 15 must not change replay sample classification semantics and must not rewrite the nocturnal candidate factory introduced in Phase 14.

### Claude's Discretion
- Exact formula weights for `coverageRate`, `falsePositiveRate`, and `adherenceRate`
- Where routing policy lives in code: dedicated module vs principle-tree service vs lifecycle service
- Whether deprecated readiness is represented as a boolean, score, or structured candidate assessment
- How much live runtime evidence to include in v1.9.0 if current telemetry is thinner than replay evidence

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone framing
- `docs/design/2026-04-07-principle-internalization-system.md`
- `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md`
- `docs/design/2026-04-07-principle-internalization-roadmap.md`
- `docs/design/2026-04-06-dynamic-harness-evolution-engine.md`

### Prior phase outputs
- `.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md`
- `.planning/phases/12-runtime-rule-host-and-code-implementation-storage/12-CONTEXT.md`
- `.planning/phases/13-replay-evaluation-and-manual-promotion-loop/13-CONTEXT.md`
- `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`
- `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-RESEARCH.md`
- `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-VALIDATION.md`
- `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-VERIFICATION.md`

### Primary code integration points
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts`
- `packages/openclaw-plugin/src/core/replay-engine.ts`
- `packages/openclaw-plugin/src/core/code-implementation-storage.ts`
- `packages/openclaw-plugin/src/core/nocturnal-artifact-lineage.ts`
- `packages/openclaw-plugin/src/service/nocturnal-service.ts`
- `packages/openclaw-plugin/src/core/rule-host.ts`

### GSD planning source of truth
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Data already available
- `principle-tree-ledger.ts` already stores Rule and Implementation entities and lifecycle state.
- `replay-engine.ts` already emits structured replay reports with pass/fail/needs-review decisions across `pain-negative`, `success-positive`, and `principle-anchor`.
- Phase 14 now persists code-candidate lineage and provenance separately from replay dataset classification.

### Gaps Phase 15 likely needs to close
- No first-class coverage/adherence calculator exists yet.
- No explicit deprecated-candidate computation exists yet.
- No explicit internalization route policy exists in code.
- Existing state/provenance may be split across ledger, implementation storage, replay reports, and nocturnal lineage, so a unifying read model may be required.

### Established boundaries
- `Progressive Gate` remains a host hard-boundary layer in v1.9.0.
- Promotion remains manual; Phase 15 should not bypass replay or manual review.
- Replay `SampleClassification` remains behavioral-only and must not become a generic artifact taxonomy.

</code_context>

<specifics>
## Specific Ideas

- Treat Phase 15 as two layers:
  1. **metrics layer**: compute coverage, false positives, adherence, deprecated readiness
  2. **policy layer**: route principle failures toward `skill`, `code`, or `defer` using explicit strategy
- Prefer a deterministic read model or service that aggregates replay reports plus lineage into one place for lifecycle decisions.
- Deprecated readiness should likely be a structured assessment with reasons rather than a raw boolean only.

</specifics>

<deferred>
## Deferred Ideas

- Automatic route execution for skill/LoRA/fine-tune
- Auto-promotion of code implementations from replay stability
- Multi-form joint coverage accounting across real skill/code/LoRA implementations
- Dashboard-heavy analytics or operator UI

</deferred>

---

*Phase: 15-coverage-adherence-and-internalization-routing*
*Context gathered: 2026-04-08*
