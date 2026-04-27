---
phase: m7-01-Candidate-Intake-Contract
plan: '01'
subsystem: schema
tags: [typebox, schema, ledger-adapter, candidate-intake, vitest]

# Dependency graph
requires: []
provides:
  - CandidateIntakeInputSchema (candidateId + workspaceDir)
  - CandidateIntakeOutputSchema (consumed output shape)
  - LedgerPrincipleEntrySchema (11-field probation entry contract)
  - LedgerAdapter interface (writeProbationEntry + existsForCandidate)
  - CandidateIntakeError class with INTAKE_ERROR_CODES
  - Barrel exports in runtime-v2/index.ts
affects:
  - m7-02 (LedgerAdapter implementation — openclaw-plugin)
  - m7-03 (CandidateIntakeService — uses LedgerAdapter)

# Tech tracking
tech-stack:
  added:
    - '@sinclair/typebox' (TypeBox 0.34 schema + Value.Check runtime validation)
  patterns:
    - TypeBox schema as runtime validation boundary
    - LedgerAdapter interface as DI abstraction (principles-core defines, openclaw-plugin implements)
    - Idempotency via sourceRef = `candidate://<candidateId>` (NOT artifact-based)
    - artifactRef/taskRef as traceability-only provenance fields

key-files:
  created:
    - packages/principles-core/src/runtime-v2/candidate-intake.ts
    - packages/principles-core/tests/candidate-intake.test.ts
  modified:
    - packages/principles-core/src/runtime-v2/index.ts (barrel exports)

key-decisions:
  - "Removed artifactId from CandidateIntakeInput — artifact linkage is optional, not required (D-01)"
  - "sourceRef uses candidate:// prefix as idempotency key — one artifact can produce N candidates (D-11)"
  - "artifactRef + taskRef added as traceability-only fields (not idempotency keys) (D-03)"
  - "candidate_already_consumed is NOT returned as happy-path idempotent result — reserved for data corruption detection (D-12)"
  - "existsForCandidate matches by sourceRef === 'candidate://<candidateId>' NOT by artifactId"

patterns-established:
  - "LedgerAdapter interface: defined in principles-core, implemented in openclaw-plugin"
  - "TypeBox Value.Check() as schema validation runtime"
  - "11-field LedgerPrincipleEntry with 18-field expansion in adapter (m7-02)"

requirements-completed: [D-01, D-03, D-10, D-11, D-12]

# Metrics
duration: 12min
completed: 2026-04-26
---

# Phase m7-01 Plan 01 Summary

**Candidate Intake Contract: TypeBox schemas, LedgerAdapter interface, and error class defined and exported from principles-core**

## Performance

- **Duration:** 12 min
- **Started:** 2026-04-26T00:00:00Z
- **Completed:** 2026-04-26T00:12:00Z
- **Tasks:** 2
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- Created `candidate-intake.ts` with all M7 contract definitions
- Created `candidate-intake.test.ts` with 17 passing tests (INTAKE-01 through INTAKE-04)
- Added barrel exports to `runtime-v2/index.ts`
- Resolved 4 design issues from user review before execution:
  - P1: sourceRef idempotency key collision (artifact-level → candidate-level)
  - P1: existsForCandidate JSDoc mismatch (artifact:// → candidate:// matching)
  - P2: candidate_already_consumed dual semantic fixed (happy-path → corruption detection only)
  - P2: VALIDATION.md status inconsistency corrected

## Task Commits

Each task was committed atomically:

1. **Task 1: Create candidate-intake.ts + index.ts exports + 17 tests** - `50f20799` (feat)

## Files Created/Modified
- `packages/principles-core/src/runtime-v2/candidate-intake.ts` - All M7 contract definitions
- `packages/principles-core/src/runtime-v2/index.ts` - Barrel exports added
- `packages/principles-core/tests/candidate-intake.test.ts` - 17 tests (INTAKE-01 through INTAKE-04)

## Decisions Made
- artifactId omitted from CandidateIntakeInput (D-01: not required for intake)
- sourceRef = `candidate://<candidateId>` as idempotency key — avoids one-artifact→N-candidates collision (D-11)
- artifactRef + taskRef added as provenance-only fields — NOT idempotency keys (D-03)
- candidate_already_consumed reserved for data corruption detection only; idempotent no-op returns null (D-12)
- existsForCandidate matches by sourceRef === 'candidate://<candidateId>' (D-11)

## Deviations from Plan

None - plan executed as written.

## Issues Encountered
- **VALIDATION.md missing:** File did not exist, blocking nyquist_compliant scan. Created from template.
- **Test name misleading:** "rejects extra artifactId field" → renamed to "accepts but does not recognize extra artifactId field" (TypeBox ignores extra properties by default)
- **Research RESOLVED markers:** Changed to "Open Questions (RESOLVED)", added `(RESOLVED)` suffix
- **Test path mismatch:** RESOLVED to `tests/` (vitest include pattern), not `src/runtime-v2/__tests__/`

## Next Phase Readiness
- m7-01-02 (Wave 2) next — comprehensive JSDoc + LEDGER-01 tests
- LedgerAdapter ready for m7-02 implementation in openclaw-plugin
- CandidateIntakeInputSchema ready for m7-03 CandidateIntakeService

---
*Phase: m7-01-Candidate-Intake-Contract*
*Completed: 2026-04-26*
