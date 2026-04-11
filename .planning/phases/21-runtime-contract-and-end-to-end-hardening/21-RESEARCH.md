# Phase 21 Research - Runtime Contract and End-to-End Hardening

## Research Summary

Phase 21 is the final milestone hardening slice. The codebase already has:

- shared workspace resolution contract from Phase 19
- shared pain/snapshot schema validation from Phase 20

The remaining failures are not mainly parsing bugs anymore. They are coordination bugs between runtime availability, session selection, and test coverage.

## Key Findings

### 1. Runtime capability is still expressed indirectly

`packages/openclaw-plugin/src/utils/subagent-probe.ts` still treats `AsyncFunction` as part of the capability story.

Even though the function now returns `true` for late-bound proxies, the implementation and comments still encode the wrong model:

- gateway mode = async function
- embedded mode = regular function that throws

That is exactly the kind of implicit implementation coupling this milestone is trying to remove.

### 2. Candidate session fallback is still time-unbounded

`packages/openclaw-plugin/src/service/evolution-worker.ts` falls back to:

- exact pain session
- task id
- most recent violating session
- most recent session

But the fallback candidate list is not bounded by the triggering task timestamp. That violates `E2E-03` and can associate a reflection task with a later unrelated session.

### 3. Test coverage is still stronger at unit level than pipeline level

We now have good regression tests around:

- workspace resolution
- pain flag parsing
- snapshot ingress validation

What is still missing is one compact end-to-end protection layer proving:

- active workspace writes under `.state`
- pain context keeps the correct session identity
- bounded session selection prevents future-session drift

## Recommended Phase Split

Do not split further. One plan is enough:

1. replace runtime guessing with explicit contract
2. add bounded session filtering
3. add end-to-end contract tests

## Main Risks

- If runtime probing becomes too clever, it can recreate the same hidden-coupling problem under a new name
- If time filtering is implemented ad hoc only in the worker, selector/service paths may drift later
- Existing tests may rely on current unbounded “most recent session” behavior and need deliberate rewriting

## Planning Guidance

- Keep runtime contract small and explicit
- Prefer bounded candidate list APIs over scattered timestamp filters
- Use tests to prove causality, not just object shapes
