# Phase 14: Nocturnal RuleImplementationArtifact Factory - Research

**Researched:** 2026-04-08
**Domain:** Nocturnal reflection extension for code-candidate generation
**Confidence:** MEDIUM

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
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

### Deferred Ideas (OUT OF SCOPE)
- Automatic promotion after replay stability
- Coverage/adherence/deprecation accounting in Phase 15
- Internalization Strategy routing (`skill` vs `code` vs `LoRA`) in Phase 15+
- Multi-candidate tournament selection for Artificer output
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| NOC-01 | nocturnal reflection can emit `RuleImplementationArtifact` candidates distinct from behavioral training artifacts | Add an Artificer stage to Trinity and a sidecar persistence branch that never reuses behavioral sample schema. |
| NOC-02 | a code implementation artifact records its originating principle, rule, snapshot, and source pain / gate-block context | Add explicit artifact and lineage contracts keyed by `principleId`, `ruleId`, `sourceSnapshotRef`, and stable pain/gate references. |
| NOC-03 | nocturnal code candidate generation reuses existing selection, snapshot extraction, and validation skeletons without conflating artifact types | Reuse target selection, snapshot extraction, stage orchestration, arbiter-style pure validation, and existing storage/ledger primitives, but keep replay classification behavioral-only. |
</phase_requirements>

## Summary

The existing nocturnal pipeline already has the right reuse points: target selection returns one principle and one session, snapshot extraction returns a structured session view, Trinity already owns stage orchestration, and `nocturnal-service.ts` already separates generation, pure validation, persistence, and dataset registration into explicit steps [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-service.ts`; `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`; `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts`]. Phase 14 should extend that pipeline instead of building a parallel factory.

The main contract gap is not generation but identity: nocturnal currently resolves `principleId + sessionId`, not `ruleId`; behavioral lineage lives in `nocturnal-dataset.ts`, where `classification` is replay-only; and implementation storage can create a directory and manifest but does not yet expose a first-class write path for generated `entry.js` or lineage-rich manifest fields [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`; `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`; `packages/openclaw-plugin/src/core/code-implementation-storage.ts`]. Phase 14 therefore needs a deterministic rule resolver, a separate code-candidate lineage track, and a pure validator that proves host compatibility before any persistence.

**Primary recommendation:** Extend Trinity with an Artificer stage in `nocturnal-trinity.ts`, but execute registration as a sidecar branch in `nocturnal-service.ts` after the behavioral artifact is approved and persisted, so Artificer failure cannot regress the existing behavioral path.

## Project Constraints (from CLAUDE.md)

No `./CLAUDE.md` file exists in the repo root [VERIFIED: repo check `./CLAUDE.md`]. No repo-local `.claude/skills/` or `.agents/skills/` directories exist in this repo [VERIFIED: repo check `./.claude/skills`; `./.agents/skills`]. The active project-specific constraints therefore come from the user-provided `AGENTS.md` instructions: strict TypeScript, ESM, Vitest, `api.resolvePath()` for compliant path resolution, no type suppression, and no direct changes to protected/risk paths outside the established gate rules [VERIFIED: user-provided `AGENTS.md` block].

## Standard Stack

### Core

| Library / Module | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `nocturnal-service.ts` | repo-local | Orchestrates selection, snapshot extraction, validation, persistence, and dataset registration [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-service.ts`] | It is the existing pipeline boundary where new artifact branches can be added without changing target selection or cooldown logic [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-service.ts`]. |
| `nocturnal-trinity.ts` | repo-local | Owns Dreamer/Philosopher/Scribe runtime contracts and stage telemetry [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`] | D-01 and D-02 explicitly require Artificer to follow the same stage contract [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`]. |
| `principle-tree-ledger.ts` | repo-local | Canonical `Implementation` relationship and lifecycle store [VERIFIED: codebase `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`] | The ledger is already the source of truth for implementation relationships and lifecycle state, while manifests are subordinate [VERIFIED: codebase `packages/openclaw-plugin/src/core/code-implementation-storage.ts`; `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`]. |
| `code-implementation-storage.ts` | repo-local | Stores `manifest.json`, `entry.js`, and replay reports under `{stateDir}/principles/implementations/{implId}/` [VERIFIED: codebase `packages/openclaw-plugin/src/core/code-implementation-storage.ts`] | Phase 14 can reuse the existing asset root instead of inventing a second code-candidate filesystem [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`; codebase `packages/openclaw-plugin/src/core/code-implementation-storage.ts`]. |
| `rule-host.ts` + `rule-host-types.ts` + `rule-host-helpers.ts` | repo-local | Define the runtime contract candidates must satisfy before replay/promotion [VERIFIED: codebase `packages/openclaw-plugin/src/core/rule-host.ts`; `packages/openclaw-plugin/src/core/rule-host-types.ts`; `packages/openclaw-plugin/src/core/rule-host-helpers.ts`] | Phase 14 validation should target the same contract instead of a looser nocturnal-only format [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`]. |

### Supporting

| Library / Module | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `nocturnal-arbiter.ts` | repo-local | Pure deterministic validation style with structured failures [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-arbiter.ts`] | Use as the pattern for a new pure Artificer validator. |
| `nocturnal-dataset.ts` | repo-local | Behavioral sample lineage and replay classification store [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`] | Reuse only for behavioral samples or a parallel lineage registry, not for code artifact kind. |
| `replay-engine.ts` | repo-local | Offline evaluation over `pain-negative`, `success-positive`, and `principle-anchor` samples [VERIFIED: codebase `packages/openclaw-plugin/src/core/replay-engine.ts`] | Consume newly registered candidate implementations immediately after Phase 14 registration. |
| `vitest` | installed `4.1.0`, registry current `4.1.3` on 2026-04-07 [VERIFIED: `packages/openclaw-plugin/package.json`; `npm ls vitest`; npm registry] | Test framework | Use the existing repo test harness rather than adding a new test runner. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Separate Artificer pipeline | Extend `nocturnal-trinity.ts` plus a service-side registration branch | A second pipeline would duplicate runtime/session parsing and telemetry already present in Trinity [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`; `packages/openclaw-plugin/src/service/nocturnal-service.ts`]. |
| Overloading `NocturnalDatasetRecord.classification` for artifact kind | Parallel code-candidate lineage registry | `classification` is already replay-sample semantics and is read directly by `ReplayEngine` [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`; `packages/openclaw-plugin/src/core/replay-engine.ts`]. |
| Reusing behavioral artifact schema for code candidates | New `RuleImplementationArtifact` contract | The behavioral artifact contains `badDecision` / `betterDecision` / `rationale` only and has no `ruleId`, helper usage, code body, or expected host decision [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-arbiter.ts`; design docs `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md`]. |

**Installation:** No new dependency is required; the repo already has Node `v24.14.0`, npm `11.9.0`, TypeScript `6.0.2`, and Vitest `4.1.0` installed [VERIFIED: `node --version`; `npm --version`; `npm ls vitest`; `npm view typescript version`].

## Architecture Patterns

### Recommended Project Structure

```text
packages/openclaw-plugin/src/
|-- core/
|   |-- nocturnal-trinity.ts                  # Add Artificer stage contracts + telemetry
|   |-- nocturnal-artificer-validator.ts      # New pure validator for code candidates
|   |-- nocturnal-rule-selector.ts            # New deterministic principle -> rule resolver
|   |-- nocturnal-implementation-lineage.ts   # New append-only lineage registry
|   `-- code-implementation-storage.ts        # Extend with entry write + lineage-rich manifest writes
`-- service/
    `-- nocturnal-service.ts                  # Sidecar Artificer routing + handoff sequence
```

### Pattern 1: Recommended Artificer Integration Point

**What:** Extend `runTrinity()` / `runTrinityAsync()` so the Trinity result can optionally include an Artificer draft produced after Scribe, but keep persistence and failure isolation in `executeNocturnalReflection*()` [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`; `packages/openclaw-plugin/src/service/nocturnal-service.ts`].

**When to use:** Use this whenever the selected principle can be resolved to one deterministic rule and the snapshot shows enough pain/gate density to justify code generation.

**Recommendation:** Keep the behavioral path exactly as-is through arbiter, executability, `persistArtifact()`, and `registerSample()`, then branch to `maybeRunArtificer()` before `recordRunEnd(success)` so the behavioral artifact remains durable even if Artificer fails [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-service.ts`].

**Code example:**

```ts
// Source: repo recommendation based on existing service/trinity contracts
type ExtendedTrinityResult = TrinityResult & {
  artificer?: {
    attempted: boolean;
    draft?: RuleImplementationArtifactDraft;
    failures: string[];
  };
};

// In nocturnal-service.ts
const behavioral = persistApprovedBehavioralArtifact(...);
const codeCandidate = shouldRunArtificer(ruleResolution, snapshot)
  ? maybeRunArtificer({ snapshot, principleId, ruleId, scribeArtifact })
  : null;
```

### Pattern 2: Deterministic Principle -> Rule Resolution

**What:** Resolve exactly one rule from the selected principle before Artificer runs.

**Policy options:**

1. **Strict single-rule policy.** Only run Artificer if the principle has exactly one eligible rule. This is safest but will skip multi-rule principles often.
2. **Evidence-scored resolver.** Score eligible rules on snapshot evidence and accept only a unique winner. This has better recall and stays deterministic.
3. **Manual mapping table.** Add a curated `principleId -> ruleId` map. This is operationally simple but creates new config debt and duplicates ledger relationships.

**Recommended choice:** Use option 2 with an ambiguity gate. Score only non-`retired` rules under the selected principle [VERIFIED: codebase `packages/openclaw-plugin/src/types/principle-tree-schema.ts`; `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`]. Prefer the rule with the highest tuple `(gateBlockHits, failingToolHits, painAlignedHits, 100 - coverageRate, ruleId)` and skip Artificer if the best score is zero or tied [ASSUMED]. This preserves determinism while avoiding silent arbitrary selection.

**Contract mismatch:** `NocturnalTargetSelector` currently returns `selectedPrincipleId` and `selectedSessionId` only, so Phase 14 needs a new resolver step after selection and before Artificer routing [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`].

### Pattern 3: Artifact Lineage Without Polluting Replay Classification

**What:** Add a parallel append-only lineage registry for code candidates instead of mutating replay sample classification semantics.

**Recommended record shape:**

```ts
// Source: recommended extension; current dataset classification must remain replay-only
interface NocturnalImplementationLineageRecord {
  lineageId: string;
  artifactKind: 'rule-implementation';
  implementationId: string;
  principleId: string;
  ruleId: string;
  sourceSessionId: string;
  sourceSnapshotRef: string;
  sourceBehavioralArtifactId: string;
  sourcePainRefs: string[];
  sourceGateBlockRefs: string[];
  expectedDecision: 'allow' | 'block' | 'requireApproval';
  helperUsage: string[];
  createdAt: string;
}
```

**Why:** `NocturnalDatasetRecord.classification` is already the replay selector key and `ReplayEngine.loadSamples()` filters on it directly [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`; `packages/openclaw-plugin/src/core/replay-engine.ts`].

**Contract mismatch:** `NocturnalSessionSnapshot` exposes pain and gate-block events as value objects, not stable event IDs, so Phase 14 must either derive deterministic event references from `(source, reason, timestamp)` / `(toolName, reason, createdAt)` or extend the extractor to surface source IDs [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts`].

### Pattern 4: Pure Validation Before Persistence

**What:** Add a new pure validator module that mirrors arbiter/executability style but targets the Rule Host contract.

**Recommended contract:**

```ts
// Source: recommended validator aligned to existing RuleHost contract
interface RawRuleImplementationArtifact {
  principleId?: unknown;
  ruleId?: unknown;
  candidateCode?: unknown;
  helperUsage?: unknown;
  expectedDecision?: unknown;
  rationale?: unknown;
}

interface RuleImplementationValidationResult {
  passed: boolean;
  failures: Array<{ field?: string; reason: string }>;
  normalized?: {
    principleId: string;
    ruleId: string;
    candidateCode: string;
    helperUsage: string[];
    expectedDecision: 'allow' | 'block' | 'requireApproval';
    rationale: string;
    exportedMeta: RuleHostMeta;
  };
}
```

**Validation rules:** Require `principleId` and `ruleId` to match the selected target; require `expectedDecision` to be one of the three host decisions; require `helperUsage` to be a subset of the whitelist exposed by `RuleHostHelpers`; reject forbidden APIs (`eval`, `Function`, `import(`, `require`, `fetch`, `http`, `https`, `child_process`, `fs`, `process`, `net`) via static scan; normalize the candidate source and prove it compiles to `{ meta, evaluate }` using the same host loading path that `RuleHost` uses [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-arbiter.ts`; `packages/openclaw-plugin/src/core/rule-host.ts`; `packages/openclaw-plugin/src/core/rule-host-types.ts`; `packages/openclaw-plugin/src/core/rule-host-helpers.ts`].

**Important mismatch:** `rule-host.ts` can load code from storage and compile it, but there is no standalone pure "preflight compile" helper yet, and `code-implementation-storage.ts` has no `writeEntrySource()` API [VERIFIED: codebase `packages/openclaw-plugin/src/core/rule-host.ts`; `packages/openclaw-plugin/src/core/code-implementation-storage.ts`].

### Anti-Patterns to Avoid

- **Do not store code candidates in `.state/nocturnal/samples/`.** That path and schema are behavioral-sample specific [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-service.ts`; `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`].
- **Do not overload `classification` with code artifact kind.** Replay already treats it as semantic sample class [VERIFIED: codebase `packages/openclaw-plugin/src/core/replay-engine.ts`].
- **Do not make ledger creation the first irreversible step.** A dangling `Implementation` record without files is harder to reason about than staged files with no ledger reference [ASSUMED].
- **Do not auto-promote.** Phase 13 keeps promotion manual and Rule Host only loads `active` implementations [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`; codebase `packages/openclaw-plugin/src/core/rule-host.ts`; `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`].

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Stage orchestration | A second nocturnal subagent runner | Extend Trinity runtime adapter and result contracts | Trinity already encapsulates run/wait/read/parse and stage telemetry [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-trinity.ts`]. |
| Candidate lifecycle store | A new code-candidate ledger | `principle-tree-ledger.ts` `Implementation(type=code, lifecycleState='candidate')` | The ledger is already canonical for implementation relationships and lifecycle transitions [VERIFIED: codebase `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`]. |
| Replay sample categories | A new replay sample taxonomy | Existing `SampleClassification` values only | Replay logic already assumes exactly `pain-negative`, `success-positive`, and `principle-anchor` [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`; `packages/openclaw-plugin/src/core/replay-engine.ts`]. |
| Runtime compatibility check | A custom Phase 14 sandbox | Existing Rule Host compile/load contract | Host compatibility is the real runtime boundary; Phase 14 should validate against it directly [VERIFIED: codebase `packages/openclaw-plugin/src/core/rule-host.ts`; `packages/openclaw-plugin/src/core/rule-host-types.ts`]. |

**Key insight:** Reuse existing runtime, ledger, and replay systems, but add one new identity layer for rule resolution and one new lineage layer for code-candidate traceability.

## Common Pitfalls

### Pitfall 1: Selecting a principle but not a rule
**What goes wrong:** The current nocturnal selector stops at `principleId + sessionId`, so Artificer would otherwise generate "floating" code not anchored to a concrete rule [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`].
**Why it happens:** Rule resolution is not part of the current nocturnal API surface [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`].
**How to avoid:** Add an explicit deterministic resolver and skip Artificer on ambiguity.
**Warning signs:** Multiple candidate rules under one principle or zero evidence-bearing rules in the snapshot.

### Pitfall 2: Reusing behavioral dataset schema for code lineage
**What goes wrong:** `ReplayEngine` will misinterpret code-candidate metadata if artifact kind leaks into `classification` [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`; `packages/openclaw-plugin/src/core/replay-engine.ts`].
**Why it happens:** Behavioral lineage and replay selection already share one record type [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`].
**How to avoid:** Keep replay sample registry behavioral-only and add a separate code lineage registry.
**Warning signs:** Any plan that proposes new `SampleClassification` values for code artifacts.

### Pitfall 3: Treating validation as syntax-only
**What goes wrong:** A candidate may parse as JavaScript but still fail Rule Host expectations for `meta`, `evaluate`, helper usage, or decision shape [VERIFIED: codebase `packages/openclaw-plugin/src/core/rule-host.ts`; `packages/openclaw-plugin/src/core/rule-host-types.ts`].
**Why it happens:** `rule-host.ts` loads active implementations at runtime, but Phase 14 needs a pre-persistence compile/load proof [VERIFIED: codebase `packages/openclaw-plugin/src/core/rule-host.ts`].
**How to avoid:** Validate static bans and host-compatibility together in one pure function.
**Warning signs:** Candidates that pass string checks but cannot export `{ meta, evaluate }`.

### Pitfall 4: Registering ledger first
**What goes wrong:** A failed filesystem write can leave a discoverable candidate implementation with missing assets [ASSUMED].
**Why it happens:** There is no multi-file transaction across ledger, storage, and lineage [VERIFIED: codebase `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`; `packages/openclaw-plugin/src/core/code-implementation-storage.ts`; `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`].
**How to avoid:** Precompute IDs, validate, stage storage, then create the ledger record as the last discoverability step with rollback on later failure.
**Warning signs:** Candidate appears in ledger but `loadEntrySource()` returns `null`.

## Code Examples

Verified patterns from the current repo:

### Behavioral persistence seam to mirror, not replace

```ts
// Source: packages/openclaw-plugin/src/service/nocturnal-service.ts
const execResult = validateExecutability(arbiterResult.artifact);
const persistedPath = persistArtifact(workspaceDir, artifactWithBoundedAction);
registerSample(workspaceDir, arbiterResult.artifact, persistedPath, null);
```

### Ledger lifecycle state for candidates

```ts
// Source: packages/openclaw-plugin/src/core/principle-tree-ledger.ts
export type ImplementationLifecycleState =
  | 'candidate'
  | 'active'
  | 'disabled'
  | 'archived';
```

### Rule Host decision boundary the candidate must satisfy

```ts
// Source: packages/openclaw-plugin/src/core/rule-host-types.ts
export type RuleHostDecision = 'allow' | 'block' | 'requireApproval';
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Nocturnal emits only behavioral artifacts under `.state/nocturnal/samples/` [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-service.ts`] | Phase 14 must emit a second artifact kind for code candidates without changing the behavioral artifact path [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`] | Phase 14 | Dual-artifact coexistence becomes a first-class requirement. |
| Replay reads `classification` as replay semantics only [VERIFIED: codebase `packages/openclaw-plugin/src/core/replay-engine.ts`] | Phase 14 must track code artifact kind somewhere else [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`] | Phase 14 | A parallel lineage record is cleaner than a replay taxonomy change. |
| Rule Host only loads `active` implementations [VERIFIED: codebase `packages/openclaw-plugin/src/core/rule-host.ts`] | Phase 14 candidates must be created as `candidate` and consumed by replay, not runtime gate execution [VERIFIED: codebase `packages/openclaw-plugin/src/core/principle-tree-ledger.ts`; context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`] | Phase 13-14 | Candidate registration stays safe by default. |

**Deprecated/outdated:**
- Reusing `NocturnalArtifact` as the code-candidate contract is outdated for this phase because it cannot represent `ruleId`, `candidateCode`, or helper usage [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-arbiter.ts`; design docs `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md`].

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Artificer eligibility should be limited to rules that can sensibly become `Implementation(type=code)`, likely `hook`/`gate` rules first. | Architecture Patterns | Planner may scope too wide and generate unusable candidates for `skill`/`lora`/`prompt` rules. |
| A2 | Rule resolution should score evidence-bearing rules and skip on ties instead of forcing a single winner. | Architecture Patterns | Planner may need a stricter or more operator-driven selection policy. |
| A3 | Storage should be staged before ledger discoverability to reduce dangling canonical records. | Common Pitfalls | Planner may choose a different failure model and need explicit cleanup tasks. |

## Open Questions

1. **Which rule types are Artificer-eligible in Phase 14?**
   - What we know: Rule schema supports `hook`, `gate`, `skill`, `lora`, `test`, and `prompt` [VERIFIED: codebase `packages/openclaw-plugin/src/types/principle-tree-schema.ts`].
   - What's unclear: Whether Artificer should target only code-natural rule types in Phase 14.
   - Recommendation: Lock Phase 14 to `hook` and `gate` unless the planner finds an existing code-path for another rule type.

2. **Should lineage be a separate registry or an extension of the dataset registry with `artifactKind`?**
   - What we know: `classification` cannot be repurposed [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`; `packages/openclaw-plugin/src/core/replay-engine.ts`].
   - What's unclear: Whether extending the dataset record with a non-classification `artifactKind` is acceptable or whether the cleaner contract is a parallel file.
   - Recommendation: Use a separate registry to keep replay storage behavior unchanged.

3. **How should pain/gate references be stored?**
   - What we know: Snapshot events currently lack stable source IDs [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts`].
   - What's unclear: Whether to derive deterministic event fingerprints or extend the extractor to expose source IDs.
   - Recommendation: Lock this early; it affects lineage shape and tests.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | build, tests, runtime validation | yes [VERIFIED: `node --version`] | `v24.14.0` [VERIFIED: `node --version`] | none |
| npm | tests, package inspection | yes [VERIFIED: `npm --version`] | `11.9.0` [VERIFIED: `npm --version`] | none |
| Vitest | phase verification | yes [VERIFIED: `npm ls vitest --depth=0`] | installed `4.1.0` [VERIFIED: `npm ls vitest --depth=0`] | none |

**Missing dependencies with no fallback:** None [VERIFIED: environment audit].

**Missing dependencies with fallback:** None [VERIFIED: environment audit].

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest `4.1.0` installed, `4.1.3` current registry [VERIFIED: `npm ls vitest --depth=0`; npm registry] |
| Config file | `packages/openclaw-plugin/vitest.config.ts` [VERIFIED: file `packages/openclaw-plugin/vitest.config.ts`] |
| Quick run command | `cd packages/openclaw-plugin && npm test -- nocturnal-service` [ASSUMED] |
| Full suite command | `cd packages/openclaw-plugin && npm test` [VERIFIED: `packages/openclaw-plugin/package.json`] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| NOC-01 | Artificer can produce code candidates alongside behavioral artifacts | unit/integration | `cd packages/openclaw-plugin && npx vitest run tests/service/nocturnal-service.test.ts tests/core/nocturnal-trinity.test.ts` | yes, existing files [VERIFIED: repo test search] |
| NOC-02 | Candidate lineage preserves principle/rule/snapshot/pain/gate origin | unit | `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-dataset.test.ts` | partial, extend existing or add `tests/core/nocturnal-implementation-lineage.test.ts` |
| NOC-03 | Existing selection/snapshot/validation skeletons are reused without schema conflation | integration | `cd packages/openclaw-plugin && npx vitest run tests/service/nocturnal-service.test.ts tests/core/replay-engine.test.ts` | mixed; replay exists, lineage-specific service coverage does not [VERIFIED: repo test search] |

### Sampling Rate

- **Per task commit:** `cd packages/openclaw-plugin && npx vitest run tests/core/nocturnal-trinity.test.ts tests/service/nocturnal-service.test.ts`
- **Per wave merge:** `cd packages/openclaw-plugin && npm test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps

- `tests/core/nocturnal-artificer-validator.test.ts` - covers pure validation and host-compatibility parse failures.
- `tests/core/nocturnal-rule-selector.test.ts` - covers deterministic rule resolution and ambiguity skip behavior.
- `tests/core/nocturnal-implementation-lineage.test.ts` - covers lineage registration without replay classification regression.
- `tests/service/nocturnal-service-artificer.test.ts` or extension of `tests/service/nocturnal-service.test.ts` - covers behavioral-success + Artificer-failure coexistence and three-point registration rollback.
- `tests/core/code-implementation-storage.test.ts` - extend for generated `entry.js` writes and lineage-rich manifest content.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no [VERIFIED: phase scope] | none |
| V3 Session Management | no [VERIFIED: phase scope] | none |
| V4 Access Control | yes [VERIFIED: code candidates ultimately affect gate decisions and replay promotion paths] | Rule Host decision contract plus manual promotion boundary [VERIFIED: codebase `packages/openclaw-plugin/src/core/rule-host.ts`; context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`] |
| V5 Input Validation | yes [VERIFIED: phase requires pure validation before persistence] | New pure Artificer validator modeled after nocturnal arbiter [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`; codebase `packages/openclaw-plugin/src/core/nocturnal-arbiter.ts`] |
| V6 Cryptography | no [VERIFIED: phase scope] | none |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Candidate code includes forbidden runtime APIs | Elevation of Privilege | Static token bans plus host-compatibility compile/load proof before persistence [VERIFIED: context `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md`; codebase `packages/openclaw-plugin/src/core/rule-host.ts`] |
| Ambiguous rule resolution attaches code to the wrong rule | Tampering | Deterministic resolver with ambiguity skip and explicit `ruleId` cross-check in validator [ASSUMED]. |
| Dangling ledger entry points to missing assets | Integrity | Stage files first, create ledger last, rollback on later failure [ASSUMED]. |
| Replay semantics polluted by artifact kind reuse | Tampering | Keep `SampleClassification` replay-only and isolate code lineage [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-dataset.ts`; `packages/openclaw-plugin/src/core/replay-engine.ts`]. |

## Risks, Locked Decisions Needed, and Suggested Plan Slices

### Highest Risks

- **Rule resolution ambiguity.** The existing selector stops at the principle level, so planners must lock a resolver policy before implementation starts [VERIFIED: codebase `packages/openclaw-plugin/src/service/nocturnal-target-selector.ts`].
- **Lineage identity gap.** Snapshot events do not expose stable IDs, so lineage provenance will be lossy unless the plan chooses derived fingerprints or extractor changes [VERIFIED: codebase `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts`].
- **Storage API incompleteness.** There is no explicit helper to write generated `entry.js` source or manifest lineage fields yet [VERIFIED: codebase `packages/openclaw-plugin/src/core/code-implementation-storage.ts`].
- **Replay handoff mismatch.** `ReplayEngine` accepts an evaluator object and loads behavioral samples, but there is no helper that builds a replay evaluator directly from a newly created candidate implementation [VERIFIED: codebase `packages/openclaw-plugin/src/core/replay-engine.ts`].

### Decisions to Lock in Planning

1. Lock the Artificer-eligible rule types for Phase 14.
2. Lock the deterministic rule resolver and ambiguity behavior.
3. Lock the lineage storage shape: separate registry versus dataset extension with `artifactKind`.
4. Lock the provenance reference strategy for pain/gate events.
5. Lock whether Artificer gets its own prompt file.
6. Lock the minimum density threshold for Artificer routing.

### Suggested Plan Slices

1. **Slice A: Rule resolution and Artificer contracts**
   - Add `nocturnal-rule-selector.ts`.
   - Extend Trinity contracts for `invokeArtificer`.
   - Define `RuleImplementationArtifactDraft` and telemetry/result types.

2. **Slice B: Pure validation and persistence primitives**
   - Add `nocturnal-artificer-validator.ts`.
   - Extend `code-implementation-storage.ts` with generated source writes and lineage-rich manifests.
   - Add `nocturnal-implementation-lineage.ts`.

3. **Slice C: Service orchestration and failure isolation**
   - Add `maybeRunArtificer()` branch to `nocturnal-service.ts`.
   - Preserve current behavioral success path unchanged.
   - Implement three-point registration with rollback and diagnostics.

4. **Slice D: Replay handoff and tests**
   - Add candidate-to-evaluator adapter for replay.
   - Extend replay/lineage tests and service integration tests.
   - Verify candidate remains `candidate` and never reaches Rule Host runtime execution.

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` - existing orchestration, validation, persistence, and dataset registration path.
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` - Trinity stage contracts, telemetry, and draft conversion seam.
- `packages/openclaw-plugin/src/core/nocturnal-dataset.ts` - replay classification semantics and dataset lineage behavior.
- `packages/openclaw-plugin/src/core/code-implementation-storage.ts` - current manifest/entry storage capabilities and gaps.
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` - canonical implementation lifecycle and relationship store.
- `packages/openclaw-plugin/src/core/rule-host.ts`
- `packages/openclaw-plugin/src/core/rule-host-types.ts`
- `packages/openclaw-plugin/src/core/rule-host-helpers.ts` - runtime contract candidates must satisfy.
- `packages/openclaw-plugin/src/core/replay-engine.ts` - replay consumption model and classification assumptions.
- `.planning/phases/14-nocturnal-ruleimplementationartifact-factory/14-CONTEXT.md` - locked decisions and scope guards.
- `.planning/ROADMAP.md`
- `.planning/REQUIREMENTS.md`

### Secondary (MEDIUM confidence)
- `docs/design/2026-04-07-principle-internalization-system.md` - milestone framing and intended `RuleImplementationArtifact` role.
- `docs/design/2026-04-07-principle-internalization-system-technical-appendix.md` - intended artifact and host contract.
- `docs/design/2026-04-06-dynamic-harness-evolution-engine.md` - code-implementation branch framing.
- `packages/openclaw-plugin/package.json`
- `packages/openclaw-plugin/vitest.config.ts`
- `npm view vitest version time.modified`
- `npm view typescript version time.modified`
- `npm view better-sqlite3 version time.modified`

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all recommendations reuse existing repo modules and installed toolchain.
- Architecture: MEDIUM - the reuse seams are verified, but the exact resolver and lineage shape still need locked planning decisions.
- Pitfalls: HIGH - they follow directly from existing type and storage boundaries.

**Research date:** 2026-04-08
**Valid until:** 2026-05-08
