# Phase 14: Nocturnal RuleImplementationArtifact Factory - Context

**Gathered:** 2026-04-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Extend the nocturnal reflection pipeline so it can research and emit `RuleImplementationArtifact` code implementation candidates distinct from, and alongside, existing behavioral training artifacts. Reuse existing target selection, snapshot extraction, and validation/persistence skeletons. Does NOT implement auto-promotion, coverage/adherence accounting, or internalization routing.

</domain>

<decisions>
## Implementation Decisions

### Pipeline architecture - Trinity extension
- **D-01:** Extend the Trinity chain from 3 stages to 4: Dreamer -> Philosopher -> Scribe -> **Artificer**. Artificer is a new subagent stage that receives the Scribe reflection artifact, principle context, and structured snapshot, then generates candidate code.
- **D-02:** Artificer follows the same orchestration pattern as Dreamer/Philosopher/Scribe: run subagent -> wait -> read session messages -> parse structured output.
- **D-03:** The existing 3-stage Trinity path for behavioral samples remains unchanged. Artificer is an optional 4th stage that only runs when routing conditions are met.

### Artifact trigger and routing
- **D-04:** A single nocturnal run can produce both a behavioral training artifact (from Scribe) and a code implementation candidate (from Artificer). They are not mutually exclusive.
- **D-05:** Artificer is triggered based on pain/gate data density only after the selected nocturnal Principle can be resolved to a deterministic target Rule. Phase 14 must define this `principle -> rule` selection policy. If no concrete Rule can be resolved, Artificer does not run.
- **D-06:** If Artificer fails, or routing conditions are not met, the behavioral sample from Scribe is still preserved. Artificer failure does not block the existing behavioral pipeline.

### Code validation and safety
- **D-07:** Artificer output must pass **static validation + host-compatibility parse check** before entering the candidate pool:
  1. Only uses helpers from the Phase 12 whitelist (`RuleHostHelpers`)
  2. Returns a valid decision type: `allow | block | requireApproval`
  3. Does not use forbidden APIs: `eval`, `Function`, dynamic `import`, network access, subprocess execution, filesystem access
  4. Code can be parsed and loaded by the same constrained host contract used by `RuleHost`
- **D-08:** Validation is a pure-function check, following the existing Arbiter style. It is not an LLM call.
- **D-09:** Validation failures are recorded but do not block the behavioral artifact. Failed code candidates are logged for operator review but are not persisted as `Implementation` records.

### Storage and handoff
- **D-10:** Code candidates are stored in Phase 12 implementation storage (`.state/principles/implementations/{id}/`) with `manifest.json` and `entry.js`, registered as `lifecycleState: 'candidate'`.
- **D-11:** On successful Artificer + validation: **three-point registration**:
  1. **Principle Tree Ledger**: create `Implementation(type=code, lifecycleState=candidate)` linked to the target Rule
  2. **Implementation Storage**: write `manifest.json` and `entry.js`, with manifest lineage fields populated from the nocturnal snapshot
  3. **Nocturnal Dataset / lineage registry**: register lineage for the generated candidate without overloading replay sample classification
- **D-12:** Behavioral training artifacts continue to be stored in `.state/nocturnal/samples/` as before. Phase 14 must not change existing behavioral artifact persistence.
- **D-13:** After registration, the code candidate is immediately available for Phase 13's `ReplayEngine` to evaluate. No additional handoff step is needed.
- **D-13A:** `SampleClassification` in `nocturnal-dataset.ts` remains reserved for replay sample categories only: `pain-negative`, `success-positive`, and `principle-anchor`.
- **D-13B:** If Phase 14 needs to track artifact kind, it must do so through a separate field such as `artifactKind` or a parallel lineage record, not through replay sample classification.

### Scope guards
- **D-14:** Phase 14 must NOT auto-promote code candidates to `active`. Promotion remains manual per Phase 13.
- **D-15:** Phase 14 must NOT implement coverage, adherence, or deprecation accounting. Those belong to Phase 15.
- **D-16:** Phase 14 must NOT modify the existing behavioral sample artifact schema or pipeline behavior. Scribe output is unchanged.

### Claude's Discretion
- Exact Artificer prompt design and output JSON contract
- Minimum pain/gate threshold for Artificer triggering once a target Rule is resolved
- How to represent code-candidate lineage without polluting replay sample classification
- Whether Artificer gets its own agent prompt file or shares an existing nocturnal agent prompt

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone framing
- `docs/design/2026-04-07-principle-internalization-system.md`
- `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md`
- `docs/design/2026-04-07-principle-internalization-roadmap.md`
- `docs/design/2026-04-06-dynamic-harness-evolution-engine.md`

### Existing nocturnal pipeline code (MUST reuse)
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`
- `packages/openclaw-plugin/src/core/nocturnal-arbiter.ts`
- `packages/openclaw-plugin/src/core/nocturnal-executability.ts`
- `packages/openclaw-plugin/src/service/nocturnal-service.ts`
- `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`
- `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts`
- `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts`

### Phase 12/13 integration points
- `packages/openclaw-plugin/src/core/code-implementation-storage.ts`
- `packages/openclaw-plugin/src/core/rule-host.ts`
- `packages/openclaw-plugin/src/core/rule-host-helpers.ts`
- `packages/openclaw-plugin/src/core/replay-engine.ts`
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`
- `packages/openclaw-plugin/src/types/principle-tree-schema.ts`

### GSD planning source of truth
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`

### Prior phase context
- `.planning/phases/11-principle-tree-ledger-entities/11-CONTEXT.md`
- `.planning/phases/12-runtime-rule-host-and-code-implementation-storage/12-CONTEXT.md`
- `.planning/phases/13-replay-evaluation-and-manual-promotion-loop/13-CONTEXT.md`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `nocturnal-trinity.ts`: Trinity chain execution and stage contracts. Artificer should fit this orchestration model rather than invent a second pipeline.
- `nocturnal-arbiter.ts`: Pure-function validation shape to follow for code candidate validation.
- `nocturnal-service.ts`: Main pipeline orchestrator where the Artificer stage and validation slot should be inserted.
- `nocturnal-dataset.ts`: Dataset registry with fingerprinting and review-status transitions. Extend lineage carefully without changing replay `SampleClassification` semantics.
- `code-implementation-storage.ts`: Implementation storage for candidate code assets.
- `rule-host.ts`: Constrained host loading contract. Reuse its compatibility rules for validation.
- `principle-tree-ledger.ts`: Principle/Rule/Implementation ledger where candidate `Implementation(type=code)` records will be created.

### Established Patterns
- Subagent stages use run -> wait -> parse structured output
- Validation uses pure-function `passed/failures` style results
- Persistence uses locked file writes
- Dataset registration already tracks fingerprint, artifact path, and review metadata

### Integration Points
- `nocturnal-service.ts`: insert Artificer after Scribe and before candidate persistence
- `nocturnal-trinity.ts`: extend stage execution to support the 4th stage
- `nocturnal-dataset.ts`: extend lineage or artifact-kind representation without mixing it into replay sample classification
- `code-implementation-storage.ts`: write candidate manifest and entry on successful Artificer output
- `principle-tree-ledger.ts`: create candidate `Implementation(type=code)` records

</code_context>

<specifics>
## Specific Ideas

- Artificer output should feel like “code distilled from dense evidence,” not free-form invented interception logic.
- Pain/gate density thresholds should prevent low-signal candidate spam.
- Static validation plus constrained host compatibility checks should ensure the candidate is structurally valid before replay. Replay itself remains a Phase 13 concern.
- Three-point registration (ledger + storage + lineage) keeps the candidate traceable across its lifecycle.

</specifics>

<deferred>
## Deferred Ideas

- Automatic promotion after replay stability
- Coverage/adherence/deprecation accounting in Phase 15
- Internalization Strategy routing (`skill` vs `code` vs `LoRA`) in Phase 15+
- Multi-candidate tournament selection for Artificer output

</deferred>

---

*Phase: 14-nocturnal-ruleimplementationartifact-factory*
*Context gathered: 2026-04-08*
