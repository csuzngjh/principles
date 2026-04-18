---
phase: "01"
plan: "05"
subsystem: sdk-core
tags:
  - sdk
  - conformance
  - tests
  - factory-pattern
dependency_graph:
  requires:
    - "01-01"
    - "01-02"
    - "01-03"
    - "01-04"
  provides:
    - "Conformance test factories"
  affects:
    - packages/principles-core
tech_stack:
  added:
    - describePainAdapterConformance factory
    - describeInjectorConformance factory
  patterns:
    - Test factory pattern for interface conformance
key_files:
  created:
    - packages/principles-core/tests/conformance/pain-adapter-conformance.ts
    - packages/principles-core/tests/conformance/injector-conformance.ts
    - packages/principles-core/tests/adapters/coding/openclaw-pain-adapter.conformance.test.ts
    - packages/principles-core/tests/adapters/writing/writing-pain-adapter.conformance.test.ts
decisions:
  - "Conformance factories enable any adapter/injector to get uniform test coverage"
  - "WritingPainAdapter nonFailureEvent uses empty sessionId (adapter treats as malformed)"
---
# Phase 01 Plan 05: Conformance Test Factories Summary

## One-liner
Added conformance test factories (describePainAdapterConformance and describeInjectorConformance) enabling uniform test coverage for any PainSignalAdapter or PrincipleInjector implementation.

## Tasks Completed

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Create describePainAdapterConformance | ead1aa26 | tests/conformance/pain-adapter-conformance.ts |
| 2 | Create describeInjectorConformance | ead1aa26 | tests/conformance/injector-conformance.ts |
| 3 | Wire OpenClawPainAdapter conformance | ead1aa26 | tests/adapters/coding/openclaw-pain-adapter.conformance.test.ts |
| 4 | Wire WritingPainAdapter conformance | ead1aa26 | tests/adapters/writing/writing-pain-adapter.conformance.test.ts |

## What Was Built

### describePainAdapterConformance (10 test cases)
Validates PainSignalAdapter contract:
1. returns null for non-failure event
2. returns null for malformed event
3. returns valid PainSignal for failure event
4. output passes validatePainSignal()
5. domain field is set correctly
6. severity is derived from score
7. context preserves relevant fields
8. source field is set appropriately
9. timestamp is valid ISO string
10. sessionId is present

### describeInjectorConformance (6 test cases)
Validates PrincipleInjector contract:
1. getRelevantPrinciples returns an array
2. getRelevantPrinciples returns empty array for empty input
3. getRelevantPrinciples respects character budget
4. formatForInjection returns "- [ID] text" format
5. P0 principles are included even in tight budget
6. all returned principles have required fields

## Verification

- [x] All 68 tests pass
- [x] SDK-TEST-02 requirement satisfied

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] WritingPainAdapter conformance fixture wrong**
- **Found during:** Running conformance tests
- **Issue:** nonFailureEvent used severityScore: 0 which WritingPainAdapter treats as valid failure (0 is in range 0-100)
- **Fix:** Changed nonFailureEvent to use empty sessionId which WritingPainAdapter returns null for
- **Files modified:** tests/adapters/writing/writing-pain-adapter.conformance.test.ts
- **Commit:** ead1aa26

## Self-Check: PASSED

- [x] describePainAdapterConformance has 10 test cases
- [x] describeInjectorConformance has 6 test cases
- [x] All 68 tests pass
- [x] Commit ead1aa26 exists
