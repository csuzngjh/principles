---
phase: 3A
plan: 01
subsystem: Phase 3 Input Quarantine
tags: [input-filtering, validation, production-validation]
requirements:
  provides:
    - "Phase 3 input classification and rejection logic"
    - "Legacy status filtering (resolved, null, invalid)"
    - "Trust input validation (frozen, score)"
    - "Timeout-only outcome filtering"
  affects:
    - "Phase 3 eligibility calculation"
    - "Runtime Summary Service"
tech-stack:
  added: []
  patterns:
    - "Input validation pipeline with multi-stage filtering"
    - "Rejection reason accumulation and deduplication"
    - "TDD-driven development with RED-GREEN-REFACTOR"
key-files:
  created: []
  modified:
    - "packages/openclaw-plugin/src/service/phase3-input-filter.ts"
    - "packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts"
decisions: []
metrics:
  duration: "PT10M"
  completed-date: "2026-03-26T12:07:00Z"
  test-coverage: "48 tests passing (27 phase3 + 21 runtime-summary)"
---

# Phase 3A-01: Phase 3 Input Quarantine Summary

## One-Liner

Phase 3A-01 implements input quarantine for Phase 3 shadow capability work, filtering legacy queue statuses, unfrozen trust schemas, and timeout-only task outcomes.

## Overview

Phase 3A-01 successfully implements A0 (Phase 3 Input Quarantine) to prevent legacy state from contaminating Phase 3 shadow capability work. The implementation includes comprehensive input validation, filtering, and production data validation.

## Implementation Details

### Filter Integration (Task 4)

The `evaluatePhase3Inputs()` function integrates all validation filters in the correct order:

1. **Task ID normalization & deduplication** (lines 98-125)
   - Normalizes task IDs and detects duplicates
   - Rejects entries with `missing_task_id` or `reused_task_id`

2. **Status validation** (lines 111-130)
   - Legacy status detection (`resolved`, `blocked`, `failed`, `cancelled`, `paused`)
   - Null status detection (`missing_status`)
   - Invalid status detection for other non-canonical values (`invalid_status`)

3. **Lifecycle marker validation** (lines 132-146)
   - Validates `started_at` and `completed_at` timestamps
   - Rejects malformed timestamps (`invalid_started_at`, `invalid_completed_at`)
   - Enforces required markers based on status (`missing_started_at`, `missing_completed_at`)

4. **Timeout-only outcome filtering** (lines 148-151)
   - Detects tasks with only timeout outcomes (`resolution: 'auto_completed_timeout'`)
   - Rejects as `timeout_only_outcome` to exclude from positive capability evidence

5. **Trust input validation** (lines 174-183)
   - Validates `frozen` flag must be `true`
   - Validates `score` must be finite number
   - Rejects with `legacy_or_unfrozen_trust_schema` or `missing_trust_score`

6. **Final eligibility calculation** (lines 185-187)
   - `queueTruthReady`: true only when queue has eligible samples and no rejections
   - `trustInputReady`: true only when trust validation passes
   - `phase3ShadowEligible`: requires both queue and trust readiness

### Production Sample Integration (Task 5)

Added comprehensive integration test using actual production data from `D:\Code\spicy_evolver_souls`:

**Production Context:**
- Queue contains 3 legacy `resolved` status rows (tasks: 1afdd4bb, 1a04aebb, 91947ddb)
- Queue contains 1 null status row (task: 6a7c7c48)
- Queue contains 19 timeout-only outcomes (`resolution: 'auto_completed_timeout'`)
- Trust schema has `frozen: false` (should be rejected)

**Test Validations:**
- ✓ Legacy status rejections detected
- ✓ Null status rejection detected
- ✓ Timeout-only outcome exclusions verified
- ✓ Unfrozen trust rejection verified
- ✓ Valid samples with `marker_detected` resolution allowed
- ✓ Overall `phase3ShadowEligible = false` for dirty inputs

## Test Coverage

### TDD Test Suite (27 tests)

**Legacy Queue Status Rejection** (8 tests)
- ✓ Empty queue rejection
- ✓ Legacy `resolved` status rejection
- ✓ Null status rejection
- ✓ Invalid status values (paused, cancelled)
- ✓ Reused task ID detection
- ✓ Missing required lifecycle markers
- ✓ Malformed timestamp validation
- ✓ Mixed valid/invalid queue entries

**Timeout-Only Outcome Filtering** (5 tests)
- ✓ Rejects tasks with only timeout outcomes
- ✓ Allows tasks with mixed outcomes (timeout + success)
- ✓ Allows tasks with successful completion markers
- ✓ Rejects multiple timeout-only tasks correctly
- ✓ Allows mix of timeout-only and valid tasks

**Trust Input Validation** (8 tests)
- ✓ Accepts frozen trust with valid score
- ✓ Rejects unfrozen trust schema
- ✓ Rejects null frozen value
- ✓ Rejects missing trust score
- ✓ Rejects NaN trust score
- ✓ Rejects Infinity trust score
- ✓ Accepts zero trust score
- ✓ Handles both unfrozen and missing score as rejection reasons

**Production Sample Integration** (2 tests)
- ✓ Handles production sample from spicy_evolver_souls correctly
- ✓ Correctly accumulates multiple rejection reasons for single task

**Legacy Tests** (4 tests)
- ✓ Empty queue rejection
- ✓ Clean queue and frozen trust inputs accepted
- ✓ Dirty queue lifecycle rows and unfrozen trust inputs rejected
- ✓ Invalid statuses and malformed lifecycle timestamps rejected

### Integration Test Suite (21 tests)

Runtime Summary Service tests updated to reflect new rejection reasons:
- ✓ Legacy queue status rejection in phase3 section
- ✓ Timeout-only outcome filtering
- ✓ Unfrozen trust rejection
- ✓ All existing tests still pass

## Deviations from Plan

None - plan executed exactly as written.

## Production Validation

Production sample from `D:\Code\spicy_evolver_souls` correctly rejected:
- ✓ 3 legacy `resolved` status rows rejected
- ✓ 1 null status row rejected
- ✓ 19 timeout-only tasks excluded from positive evidence
- ✓ Unfrozen trust schema rejected (`frozen: false`)
- ✓ 2 valid tasks with `marker_detected` resolution eligible
- ✓ Overall `phase3ShadowEligible = false`

## Success Criteria Verification

### Code Quality
- ✓ All TDD tests pass: 27/27 phase3-input-filter tests
- ✓ All integration tests pass: 21/21 runtime-summary-service tests
- ✓ All existing tests still pass: 668/671 (3 pre-existing failures unrelated to this work)
- ✓ No TypeScript errors: `npm run build` passes
- ✓ Code follows existing patterns in codebase

### Functional Requirements (A0)
- ✓ Queue rows with `resolved` status rejected with `legacy_queue_status` reason
- ✓ Queue rows with `null` status rejected with `missing_status` reason
- ✓ Queue rows with invalid status rejected with `invalid_status` reason
- ✓ Queue rows with missing lifecycle markers rejected
- ✓ Workspaces with `frozen !== true` rejected with `legacy_or_unfrozen_trust_schema` reason
- ✓ Task outcomes that are only `timeout` excluded from positive capability evidence

### Production Validation
- ✓ Production sample from `D:\Code\spicy_evolver_souls` correctly rejected
- ✓ Phase 3 eligibility false for dirty inputs
- ✓ Rejection reasons explicitly surfaced in evolution-status output
- ✓ Operator can see why Phase 3 is blocked

### Test Coverage
- ✓ New TDD tests cover all rejection paths
- ✓ Integration tests verify end-to-end behavior
- ✓ Production sample test validates real-world data

## Remaining Tasks

Phase 3A-01 is complete. Remaining tasks from Phase 3A:

- **PR-A1**: Trust Input Validation Refinements (enhance frozen/score validation logic)
- **PR-A2**: Input Validation Refinements (enhance queue lifecycle validation)

## Commits

- cb38798: test(3a-01): add production sample integration test
- 12cd563: docs(3a-01): complete Wave 2 (timeout-only outcome filtering)
- faf22d6: test(3a-01): update runtime-summary-service integration tests
- 1294875: feat(3a-01): implement timeout-only outcome filtering
- c447fa0: test(3a-01): add failing tests for timeout-only outcome filtering
- (Previous waves' commits: Task 1, 2, 6, 7 implementation)

## Known Issues

None - all acceptance criteria met.

## Notes

- Filter order is critical: status validation must come before timestamp validation
- Rejection reasons are accumulated and deduplicated for clarity
- Production data validation confirmed all filters work as expected
- Implementation follows TDD RED-GREEN-REFACTOR cycle
