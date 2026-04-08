# Phase 15: Coverage, Adherence, and Internalization Routing - Validation

## Validation Architecture

Phase 15 closes the v1.9.0 milestone. Validation must prove both:

1. lifecycle metrics are now computed from evidence rather than implementation existence
2. routing policy is explicit, deterministic, and recommendation-only

## Validation Layers

### Layer 1: Metric correctness

Proves:

- `Rule.coverageRate` uses replay and lifecycle evidence
- `Rule.falsePositiveRate` uses `success-positive` replay evidence
- `Principle.adherenceRate` aggregates rule coverage and repeated-error reduction
- deprecated readiness is structured and conservative

Primary tests:

- `tests/core/principle-internalization/lifecycle-metrics.test.ts`
- `tests/core/principle-internalization/deprecated-readiness.test.ts`

### Layer 2: Policy correctness

Proves:

- cheapest viable route is explicit in code
- routing can choose `skill`, `code`, or `defer`
- policy does not execute routes or mutate lifecycle automatically

Primary tests:

- `tests/core/principle-internalization/internalization-routing-policy.test.ts`

### Layer 3: Integration correctness

Proves:

- lifecycle service can recompute and expose metrics plus routing together
- WorkspaceContext can surface lifecycle outputs without breaking prior phases
- Phase 15 does not regress replay, promotion, or nocturnal candidate semantics

Primary tests:

- `tests/core/principle-internalization/principle-lifecycle-service.test.ts`
- `tests/core/replay-engine.test.ts`
- `tests/core/nocturnal-artifact-lineage.test.ts`
- `tests/service/nocturnal-service-code-candidate.test.ts`

## Phase Pass Conditions

Phase 15 is complete only when:

1. COV-01 through COV-04 are satisfied by deterministic calculations and structured assessments
2. ROUT-01 and ROUT-02 are satisfied by an explicit recommendation policy
3. no auto-promotion, auto-deprecation, LoRA execution, or fine-tune execution is introduced
4. existing replay classification and nocturnal candidate semantics remain unchanged
