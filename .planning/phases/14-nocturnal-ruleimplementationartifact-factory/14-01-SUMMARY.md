---
phase: 14-nocturnal-ruleimplementationartifact-factory
plan: 01
subsystem: api
tags: [typescript, vitest, nocturnal, rule-host, lineage]
requires:
  - phase: 11-principle-tree-ledger-entities
    provides: Principle to Rule to Implementation traversal helpers
  - phase: 12-runtime-rule-host-and-code-implementation-storage
    provides: RuleHost execution contract and helper whitelist
  - phase: 13-replay-evaluation-and-manual-promotion-loop
    provides: behavioral replay classification semantics that must remain unchanged
provides:
  - deterministic Artificer routing contracts for principle to rule resolution
  - pure RuleHost-compatible validation for nocturnal code candidates
  - separate artifact-kind lineage storage for behavioral samples and code candidates
affects: [phase-14-plan-02, nocturnal-service, replay-engine]
tech-stack:
  added: []
  patterns: [deterministic routing, pure validation gate, append-only lineage registry]
key-files:
  created:
    - packages/openclaw-plugin/src/core/nocturnal-artificer.ts
    - packages/openclaw-plugin/src/core/nocturnal-rule-implementation-validator.ts
    - packages/openclaw-plugin/src/core/nocturnal-artifact-lineage.ts
    - packages/openclaw-plugin/tests/core/nocturnal-artificer.test.ts
    - packages/openclaw-plugin/tests/core/nocturnal-rule-implementation-validator.test.ts
  modified:
    - packages/openclaw-plugin/src/core/nocturnal-trinity.ts
    - packages/openclaw-plugin/src/core/nocturnal-dataset.ts
key-decisions:
  - "Artificer selects a target rule only when there is exactly one eligible rule or a unique evidence-backed winner; ties skip generation."
  - "Candidate validation compiles source locally with RuleHost-style normalization and rejects forbidden APIs before any persistence."
  - "Artifact kind stays outside replay SampleClassification via a dedicated append-only lineage registry."
patterns-established:
  - "Deterministic principle to rule routing returns selected or skip and never guesses through ambiguity."
  - "Nocturnal code candidates must pass a pure local validator before any ledger or storage work."
requirements-completed: [NOC-01, NOC-03]
duration: 4min
completed: 2026-04-08
---

# Phase 14 Plan 01: Nocturnal RuleImplementationArtifact Factory Summary

**Deterministic Artificer routing, pure RuleHost-compatible code-candidate validation, and separate artifact-kind lineage for nocturnal outputs**

## Performance

- **Duration:** 4 min
- **Started:** 2026-04-08T09:23:01+08:00
- **Completed:** 2026-04-08T09:26:24.5530973+08:00
- **Tasks:** 3
- **Files modified:** 7

## Accomplishments

- Added `nocturnal-artificer.ts` with explicit code-candidate contracts, JSON parsing, deterministic principle-to-rule resolution, and skip-safe Artificer routing.
- Added `nocturnal-rule-implementation-validator.ts` to reject forbidden APIs, compile candidates locally with RuleHost-compatible semantics, and validate `meta` plus `evaluate` result shape.
- Added `nocturnal-artifact-lineage.ts` so behavioral samples and rule-implementation candidates can share provenance tracking without changing replay `SampleClassification`.

## Task Commits

Each task was committed atomically:

1. **Task 1: Define Artificer contracts and deterministic target-rule resolution** - `6b62b0d` (feat)
2. **Task 2: Build pure-function code-candidate validation** - `6147588` (feat)
3. **Task 3: Introduce artifact-kind lineage without touching replay classification** - `375e87f` (feat)

## Files Created/Modified

- `packages/openclaw-plugin/src/core/nocturnal-artificer.ts` - Artificer contracts, deterministic rule routing, and skip helper.
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` - Optional Artificer-ready context on Trinity results without changing behavioral output semantics.
- `packages/openclaw-plugin/tests/core/nocturnal-artificer.test.ts` - Single-rule, evidence-winner, ambiguity-skip, and output-contract coverage.
- `packages/openclaw-plugin/src/core/nocturnal-rule-implementation-validator.ts` - Pure validator for candidate source, helper usage, and RuleHost-compatible exports.
- `packages/openclaw-plugin/tests/core/nocturnal-rule-implementation-validator.test.ts` - Valid, forbidden API, malformed export, and invalid result-shape coverage.
- `packages/openclaw-plugin/src/core/nocturnal-artifact-lineage.ts` - Append-only artifact-kind lineage registry with explicit pain and gate arrays.
- `packages/openclaw-plugin/src/core/nocturnal-dataset.ts` - Clarified that replay `SampleClassification` remains behavioral-only.

## Decisions Made

- Used weighted deterministic evidence from gate reasons, pain reasons, tool names, and existing implementation counts to resolve rules, then skipped on ties or zero evidence.
- Kept validator execution in-process and local by compiling candidate source directly through `node:vm` semantics compatible with RuleHost rather than persisting or shelling out.
- Modeled artifact lineage with `artifactKind` in a separate registry so Phase 14 can represent code candidates without polluting replay sample semantics.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- One ambiguity test fixture initially produced a winner because the token overlap was not identical; the fixture was tightened so the resolver tie behavior is exercised directly.
- Missing `meta` originally surfaced as a compile-time reference error; validator normalization was adjusted to preserve a structured `missing-meta` failure instead.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Phase 14 Plan 02 can now wire nocturnal-service integration, candidate persistence, and three-point registration against stable routing and validation contracts.
- Replay classification semantics remain untouched, so downstream replay work can keep using existing `pain-negative`, `success-positive`, and `principle-anchor` categories.

## Self-Check: PASSED

- Verified summary and key implementation files exist on disk.
- Verified task commits `6b62b0d`, `6147588`, and `375e87f` exist in git history.

---
*Phase: 14-nocturnal-ruleimplementationartifact-factory*
*Completed: 2026-04-08*
