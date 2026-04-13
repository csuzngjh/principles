---
phase: 35-dreamer-enhancement
plan: 02
status: complete
started: "2026-04-13T11:00:00.000Z"
completed: "2026-04-13T11:15:00.000Z"
---

# Plan 35-02: Diversity Validation + Stub Mapping + Telemetry

## Objective
Implement diversity validation for Dreamer candidates and wire it into the Trinity pipeline with soft enforcement, plus update stub Dreamer with deterministic riskLevel/strategicPerspective mapping.

## What was built

### Task 1: validateCandidateDiversity (DIVER-03)
- Created `DiversityValidationResult` interface in `nocturnal-candidate-scoring.ts`
- Implemented `validateCandidateDiversity()` function with:
  - Risk level diversity check (>= 2 distinct levels when candidates >= 2)
  - Keyword overlap check using intersection / max(|A|, |B|) for words > 3 chars
  - Graceful degradation: empty/single candidate passes, missing riskLevel skips check
  - Never throws, always returns a result
- Created `computeKeywordOverlap()` and `extractKeywords()` helper functions
- 11 tests all passing

### Task 2: Trinity wiring + D-07 stub mapping + telemetry (DIVER-04)
- Extended `TrinityTelemetry` with optional `diversityCheckPassed` and `candidateRiskLevels` fields
- Updated all 9 stub candidates in `invokeStubDreamer` with deterministic D-07 mapping:
  - gateBlocks: `riskLevel: "low"`, `strategicPerspective: "conservative_fix"`
  - pain: `riskLevel: "medium"`, `strategicPerspective: "structural_improvement"`
  - failures: `riskLevel: "high"`, `strategicPerspective: "paradigm_shift"`
- Wired diversity validation into both `runTrinityAsync` and `runTrinityWithStubs` (after Dreamer, before Philosopher)
- Diversity check failures log warning but never block pipeline (soft enforcement)
- 8 new tests: 3 D-07 mapping + 3 diversity telemetry + 2 TrinityTelemetry type tests

## Key Decisions
- Soft enforcement: diversity failures are telemetry warnings, never hard gates
- If no candidates have riskLevel, skip risk diversity check (graceful degradation)
- Keyword overlap uses max(|A|, |B|) denominator per D-05 spec
- Only words > 3 characters contribute to keyword overlap

## Files Modified
- `packages/openclaw-plugin/src/core/nocturnal-candidate-scoring.ts` — DiversityValidationResult interface, validateCandidateDiversity, computeKeywordOverlap, extractKeywords
- `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` — TrinityTelemetry extension, D-07 stub mapping, diversity validation wiring
- `packages/openclaw-plugin/tests/core/nocturnal-candidate-scoring.test.ts` — 11 new tests
- `packages/openclaw-plugin/tests/core/nocturnal-trinity.test.ts` — 8 new tests

## Verification
- 111/111 tests pass across both test files (new + existing)
- TypeScript compilation: no new errors in modified files
- validateCandidateDiversity exported from nocturnal-candidate-scoring.ts
- TrinityTelemetry has diversityCheckPassed and candidateRiskLevels
- Both runTrinity paths call validateCandidateDiversity after Dreamer stage
- Pipeline completes even when diversity check fails (soft enforcement)

## Self-Check: PASSED
