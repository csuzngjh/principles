# Phase 15: Coverage, Adherence, and Internalization Routing - Research

**Date:** 2026-04-08  
**Status:** Complete  
**Sources reviewed:** Phase 15 context, milestone design docs, ledger schema, replay engine, nocturnal lineage, Phase 14 verification

## Summary

Phase 15 should be split into two layers:

1. a deterministic **metrics/read-model layer** that computes rule coverage, false positives, principle adherence, and deprecated readiness from replay reports, implementation lifecycle state, and nocturnal lineage
2. a deterministic **policy layer** that recommends an internalization route such as `skill`, `code`, or `defer` according to "cheapest viable implementation first"

The phase should not try to build execution pipelines for skill or LoRA, and should not try to automate promotion. It should produce stable metrics and explicit policy outputs that later phases or operators can consume.

## Findings

### 1. Recommended metric formulas

Phase 15 does not need mathematically perfect formulas. It needs stable, explainable formulas that only depend on data already available.

#### Rule coverage

Recommended first formula:

```text
Rule.coverageRate =
  0.5 * pain_negative_hit_rate
  + 0.3 * principle_anchor_pass_rate
  + 0.2 * implementation_stability_score
```

Where:

- `pain_negative_hit_rate`
  - fraction of related `pain-negative` replay samples correctly blocked
- `principle_anchor_pass_rate`
  - fraction of related `principle-anchor` replay samples that passed
- `implementation_stability_score`
  - bounded score from lifecycle stability:
    - active impl with recent passing report -> high
    - candidate only -> lower
    - disabled/archived only -> low

Reason:

- it uses replay evidence for both defensive and forward-looking correctness
- it prevents "coverage = 100 because an implementation exists"

#### Rule false positive rate

Recommended first formula:

```text
Rule.falsePositiveRate =
  success_positive_failures / success_positive_total
```

Optional live extension for later in Phase 15 if easy:

```text
blended_false_positive_rate =
  0.8 * replay_false_positive_rate
  + 0.2 * live_misfire_rate
```

But replay should remain primary because it is currently the most structured evidence source.

#### Principle adherence rate

Recommended first formula:

```text
Principle.adherenceRate =
  0.7 * average_rule_coverage
  + 0.3 * repeated_error_reduction_score
```

Where:

- `average_rule_coverage`
  - weighted average of rules under the principle
- `repeated_error_reduction_score`
  - improvement signal derived from pain/gate recurrence over time

Reason:

- principles are more abstract than rules
- adherence should reflect both implementation performance and whether the same principle keeps getting violated

#### Deprecated readiness

Recommended output is not a boolean-only field. It should be a structured assessment:

```ts
type DeprecatedCandidateAssessment = {
  eligible: boolean;
  reasons: string[];
  evidence: {
    adherenceRate: number;
    stableRuleCount: number;
    repeatedPainTrend: 'down' | 'flat' | 'up';
  };
}
```

Eligibility rule for v1.9.0:

- all material rules under a principle have stable non-trivial coverage
- no major false-positive instability
- repeated related pain is down
- at least one active lower-layer implementation exists for the relevant rules

### 2. Where the logic should live

The current codebase does not have a single place that joins ledger state, replay reports, and nocturnal lineage. Phase 15 should add one.

Recommended modules:

```text
packages/openclaw-plugin/src/core/principle-metrics/
  principle-metrics-types.ts
  principle-evidence-reader.ts
  rule-metrics-calculator.ts
  principle-adherence-calculator.ts
  deprecated-readiness.ts
  internalization-routing-policy.ts
```

Recommended responsibilities:

- `principle-evidence-reader.ts`
  - aggregates read-only evidence from:
    - principle tree ledger
    - implementation storage / replay reports
    - nocturnal artifact lineage
- `rule-metrics-calculator.ts`
  - computes `coverageRate` and `falsePositiveRate`
- `principle-adherence-calculator.ts`
  - computes `adherenceRate`
- `deprecated-readiness.ts`
  - computes candidate readiness with reasons
- `internalization-routing-policy.ts`
  - maps evidence into `skill | code | defer`

This is preferable to stuffing all logic into `principle-tree-ledger.ts`, which should remain closer to storage and lifecycle operations.

### 3. Recommended first routing policy

Phase 15 should not route to every possible implementation form. For v1.9.0, keep it narrow and explicit.

Recommended output:

```ts
type InternalizationRoute = 'skill' | 'code' | 'defer';

type InternalizationRouteDecision = {
  route: InternalizationRoute;
  reason: string;
  evidence: string[];
}
```

Recommended policy:

- choose `code` when:
  - rule is high-risk or deterministic
  - repeated violations continue despite existing prompt/skill behavior
  - replay/lineage evidence is already rich enough
- choose `skill` when:
  - issue looks procedural or habit-like
  - no hard safety boundary is needed
  - a cheaper skill/prompt route is sufficient
- choose `defer` when:
  - evidence is too sparse
  - rule targeting is ambiguous
  - implementation surface is not mature enough

This satisfies ROUT-01 and ROUT-02 without overreaching into actual skill/LoRA execution.

### 4. Current data/contract mismatches

Phase 15 planning should account for these gaps:

1. `Principle.adherenceRate`, `Rule.coverageRate`, and `Rule.falsePositiveRate` exist in schema but are not yet being computed from evidence.
2. Replay reports live under implementation asset roots, but there is no read-model that rolls them up per rule or principle.
3. Nocturnal lineage now carries `sourcePainIds` and `sourceGateBlockIds`, but current snapshot extraction may still produce sparse or synthetic refs in some cases.
4. Live misfire evidence is weaker than replay evidence today. Planning should avoid promising a sophisticated live-telemetry model unless the code already records enough runtime data.
5. There is no explicit routing policy module yet; coverage and routing should not be merged into one opaque calculator.

### 5. Suggested plan decomposition

Recommended decomposition:

#### Plan 15-01: Evidence read model and metric calculators

Scope:

- build evidence reader joining ledger, replay reports, and lineage
- compute rule coverage and false positives
- compute principle adherence and deprecated readiness
- persist/update calculated metrics back into ledger-facing state where appropriate

Reason:

- this is the deterministic data foundation
- it should be testable without involving routing decisions

#### Plan 15-02: Internalization routing policy and phase-level integration

Scope:

- build explicit routing policy returning `skill | code | defer`
- use computed metrics/evidence instead of ad hoc heuristics
- add tests for cheapest-viable route selection
- wire any required read APIs or command/report formatting

Reason:

- policy should depend on stable metrics, not the other way around

## Risks

### Risk 1: Overpromising live telemetry

Replay data is structured; live data is not equally mature. Phase 15 should treat live evidence as optional enhancement, not the primary signal.

### Risk 2: Mixing metric calculation and routing

If coverage/adherence and route selection are merged into one opaque function, the system becomes hard to audit and tune.

### Risk 3: Treating deprecated readiness as a boolean-only field

Operators need reasons and evidence. A naked boolean will be too brittle and not explainable.

## Recommended implementation shape

Phase 15 should be a single-phase, two-plan closeout:

1. **metrics plan**
   - evidence reader
   - rule coverage and false positives
   - principle adherence and deprecated readiness
   - tests

2. **routing plan**
   - cheapest-viable route policy
   - `skill | code | defer` recommendation
   - integration tests and reporting

This keeps the final milestone bounded while still delivering all remaining v1.9.0 requirements.
