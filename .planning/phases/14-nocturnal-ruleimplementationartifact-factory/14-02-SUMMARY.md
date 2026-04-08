---
phase: 14-nocturnal-ruleimplementationartifact-factory
plan: 02
subsystem: api
tags: [typescript, vitest, nocturnal, lineage, implementation-storage]
requires:
  - phase: 14-nocturnal-ruleimplementationartifact-factory
    provides: deterministic Artificer routing, candidate validation, and artifact-kind lineage contracts
provides:
  - nocturnal-service sidecar persistence for rule implementation candidates
  - candidate manifest and lineage metadata with deterministic cleanup on storage failure
  - end-to-end tests for skip, dual-output, validation-failure, and cleanup paths
affects: [phase-15, replay-engine, promote-impl, nocturnal-service]
tech-stack:
  added: []
  patterns: [sidecar candidate persistence, append-only lineage, cleanup-on-partial-failure]
key-files:
  created:
    - packages/openclaw-plugin/tests/service/nocturnal-service-code-candidate.test.ts
    - packages/openclaw-plugin/tests/core/nocturnal-artifact-lineage.test.ts
  modified:
    - packages/openclaw-plugin/src/service/nocturnal-service.ts
    - packages/openclaw-plugin/src/core/code-implementation-storage.ts
    - packages/openclaw-plugin/src/core/nocturnal-artifact-lineage.ts
    - packages/openclaw-plugin/tests/core/code-implementation-storage.test.ts
key-decisions:
  - "Code-candidate persistence stays a sidecar branch after behavioral artifact persistence so Artificer failure never blocks nocturnal success."
  - "Candidate manifests carry explicit principle/rule/snapshot/pain/gate/session/artifact lineage, while replay SampleClassification remains behavioral-only."
  - "If storage fails after ledger creation, the service deletes both the asset directory and the candidate ledger entry so replay and promotion never see half-created implementations."
patterns-established:
  - "Behavioral nocturnal artifacts always persist first; code candidates are opportunistic follow-on outputs."
  - "Nocturnal candidate lineage uses a dedicated append-only registry plus manifest metadata instead of overloading replay dataset classifications."
requirements-completed: [NOC-01, NOC-02, NOC-03]
duration: 9min
completed: 2026-04-08
---

# Phase 14 Plan 02: Nocturnal RuleImplementationArtifact Factory Summary

**Nocturnal behavioral runs can now emit traceable `candidate` code implementations without changing behavioral sample persistence or replay classification semantics**

## Performance

- **Duration:** 9 min
- **Started:** 2026-04-08T09:31:00+08:00
- **Completed:** 2026-04-08T09:39:58.0805228+08:00
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments

- Wired `nocturnal-service.ts` to persist behavioral artifacts first, then optionally resolve, validate, and persist a code candidate as a sidecar output.
- Extended implementation storage and artifact lineage to carry explicit nocturnal provenance, including principle, rule, snapshot, pain refs, gate-block refs, session, and artificer artifact ID.
- Added end-to-end tests proving skip, dual-output, validation-failure, and cleanup behavior without polluting replay sample classification.

## Task Commits

Each task was committed atomically:

1. **Task 1-2: Integrate Artificer sidecar persistence and deterministic cleanup** - `9b5f917` (feat)
2. **Task 3: Add end-to-end candidate generation and lineage tests** - `6ada6d1` (test)

## Files Created/Modified

- `packages/openclaw-plugin/src/service/nocturnal-service.ts` - Adds Artificer sidecar diagnostics, candidate persistence, behavioral lineage registration, and cleanup-on-failure handling.
- `packages/openclaw-plugin/src/core/code-implementation-storage.ts` - Adds manifest lineage metadata, generated entry writes, and asset-directory cleanup helpers.
- `packages/openclaw-plugin/src/core/nocturnal-artifact-lineage.ts` - Adds a helper for appending code-candidate lineage records with explicit provenance fields.
- `packages/openclaw-plugin/tests/service/nocturnal-service-code-candidate.test.ts` - Covers Artificer skip, success, validation failure, and post-ledger storage failure cleanup.
- `packages/openclaw-plugin/tests/core/nocturnal-artifact-lineage.test.ts` - Verifies append-only code-candidate lineage preserves pain and gate refs.
- `packages/openclaw-plugin/tests/core/code-implementation-storage.test.ts` - Extends storage coverage for generated entry source, lineage metadata, and asset cleanup.

## Decisions Made

- Kept Artificer diagnostics coarse-grained as `skipped`, `validation_failed`, and `persisted_candidate`, with detailed reasons attached separately.
- Registered behavioral artifact lineage alongside the existing dataset registration so Phase 14 can trace both outputs without changing behavioral artifact schema.
- Used explicit cleanup through storage deletion plus ledger record deletion when candidate persistence fails after ledger creation.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Existing nocturnal stub artifacts in this repo did not reliably satisfy the executability gate in the new service tests, so the end-to-end tests use explicit approved behavioral artifact overrides to isolate Phase 14’s service-side contract.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- Replay and promotion commands can now discover nocturnal code candidates as ordinary `candidate` implementations with full provenance.
- Phase 15 can build on the explicit lineage metadata to compute coverage, adherence, and internalization routing without reworking nocturnal sample classification.

## Self-Check: PASSED

- Verified summary and key implementation/test files exist on disk.
- Verified task commits `9b5f917` and `6ada6d1` exist in git history.

---
*Phase: 14-nocturnal-ruleimplementationartifact-factory*
*Completed: 2026-04-08*
