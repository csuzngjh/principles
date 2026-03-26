---
phase: 3A
plan: 01
type: tdd
wave: 1
depends_on: []
files_modified: [
  "packages/openclaw-plugin/src/service/phase3-input-filter.ts",
  "packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts",
  "packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts"
]
autonomous: true
requirements: ["A0"]
user_setup: []
must_haves:
  truths:
    - "Queue rows with legacy lifecycle values (resolved, null status) are rejected"
    - "Queue rows with invalid or non-canonical status are rejected"
    - "Queue rows with missing required lifecycle markers are rejected"
    - "Workspaces with frozen !== true are rejected from trust inputs"
    - "Task outcomes that are only 'timeout' are excluded from positive capability evidence"
  artifacts:
    - path: "packages/openclaw-plugin/src/service/phase3-input-filter.ts"
      provides: "Phase 3 input classification and rejection logic"
      contains: "rejectLegacyQueueStatuses, filterTimeoutOnlyOutcomes, validateTrustInput"
    - path: "packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts"
      provides: "TDD tests for input filtering"
      exports: ["test cases for legacy status rejection", "test cases for timeout filtering"]
  key_links:
    - from: "evaluatePhase3Inputs"
      to: "Phase 3 eligibility calculation"
      via: "queue rows and trust input validation"
      pattern: "evaluatePhase3Inputs.*queue.*trust"
    - from: "runtime-summary-service.ts"
      to: "phase3-input-filter.ts"
      via: "import and invocation"
      pattern: "evaluatePhase3Inputs"
---

# Plan 3A-01: Phase 3 Input Quarantine

## Context

User Request Summary:
Implement Phase 3A Input Quarantine (A0) to stop legacy state from contaminating Phase 3 shadow capability work. This involves:
1. Classifying inputs as authoritative, rejected, or reference-only
2. Rejecting queue rows with legacy lifecycle values (`resolved`, `null` status)
3. Rejecting trust inputs from workspaces where `frozen !== true`
4. Excluding timeout-only task outcomes from positive capability evidence

Production evidence from `D:\Code\spicy_evolver_souls` shows:
- Queue contains legacy `resolved` status rows (3 occurrences)
- Queue has `null` status rows (1 occurrence: task ID `6a7c7c48`)
- Trust schema not frozen: `frozen: false` in AGENT_SCORECARD.json
- Task outcomes dominated by `timeout` (34 of 35 outcomes are timeout)

Uncertainties:
None - production data provides clear evidence of what needs to be filtered.

## Task Dependency Graph

| Task | Depends On | Reason |
|------|------------|--------|
| Task 1 | None | Starting point - write TDD tests first |
| Task 2 | Task 1 | Tests must define behavior before implementation |
| Task 3 | Task 2 | Legacy status filtering is prerequisite for timeout filtering |
| Task 4 | Task 3 | All validation rules must be in place before trust checks |
| Task 5 | Task 4 | Filter integration task depends on all individual filters |

## Parallel Execution Graph

Wave 1 (Start immediately):
├── Task 1: Write TDD tests for legacy queue status rejection (no dependencies)
└── Task 6: Write TDD tests for trust input validation (no dependencies)

Wave 2 (After Wave 1 completes):
├── Task 2: Implement legacy queue status rejection (depends: Task 1)
└── Task 7: Implement trust input validation (depends: Task 6)

Wave 3 (After Wave 2 completes):
├── Task 3: Add timeout-only outcome filtering (depends: Task 2)
└── Task 8: Update runtime-summary-service tests (depends: Task 2, Task 7)

Wave 4 (After Wave 3 completes):
└── Task 4: Integrate all filters in evaluatePhase3Inputs (depends: Task 3, Task 8)

Wave 5 (After Wave 4 completes):
└── Task 5: Update integration tests (depends: Task 4)

Critical Path: Task 1 → Task 2 → Task 3 → Task 4 → Task 5
Estimated Parallel Speedup: 30% faster than sequential (through test parallelism)

## Tasks

### Task 1: Write TDD Tests for Legacy Queue Status Rejection

**Description**: Create comprehensive TDD tests for legacy queue status rejection in phase3-input-filter.test.ts. Tests must fail initially, then pass after implementation.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of queue schema, legacy values, and filtering logic
- Skills: [`superpowers/test-driven-development`, `tdd`] - TDD approach is mandatory for this task

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Essential for RED→GREEN→REFACTOR cycle
- INCLUDED `tdd`: Core TDD methodology
- OMITTED `systematic-debugging`: No debugging needed yet (tests first)
- OMITTED `self-improvement`: Not applicable to test writing

**Depends On**: None

**Acceptance Criteria**:
1. Test suite created with 8+ test cases covering:
   - Empty queue rejection
   - Legacy `resolved` status rejection
   - `null` status rejection
   - Invalid status values (e.g., `paused`, `cancelled`)
   - Reused task ID detection
   - Missing required lifecycle markers
   - Malformed timestamp validation
   - Mixed valid/invalid queue entries
2. All tests FAIL initially (RED phase)
3. Tests are in `packages/openclaw-plugin/tests/service/phase3-input-filter.test.ts`
4. Tests follow existing patterns in the file

**Expected Test Cases**:
```typescript
it('rejects legacy resolved status from production sample', () => {
  const result = evaluatePhase3Inputs(
    [{ id: '1afdd4bb', status: 'resolved', ... }],
    { score: 85, frozen: true }
  );
  expect(result.evolution.rejected).toHaveLength(1);
  expect(result.evolution.rejected[0].reasons).toContain('legacy_queue_status');
  expect(result.queueTruthReady).toBe(false);
});

it('rejects null status rows', () => {
  const result = evaluatePhase3Inputs(
    [{ id: '6a7c7c48', status: null, ... }],
    { score: 85, frozen: true }
  );
  expect(result.evolution.rejected[0].reasons).toContain('missing_status');
});

it('rejects invalid status values like paused and cancelled', () => {
  const result = evaluatePhase3Inputs(
    [
      { id: 'task-1', status: 'paused' },
      { id: 'task-2', status: 'cancelled' }
    ],
    { score: 85, frozen: true }
  );
  expect(result.evolution.rejected.map(r => r.reasons)).toEqual(
    expect.arrayContaining([
      expect.arrayContaining(['invalid_status']),
      expect.arrayContaining(['invalid_status'])
    ])
  );
});
```

### Task 2: Implement Legacy Queue Status Rejection

**Description**: Implement the legacy queue status rejection logic in phase3-input-filter.ts to make all TDD tests pass.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of filtering logic, validation patterns
- Skills: [`superpowers/test-driven-development`] - Ensure implementation matches test expectations

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Continue TDD cycle
- OMITTED `writing-skills`: Not documentation
- OMITTED `triage-issue`: No bugs to diagnose

**Depends On**: Task 1

**Acceptance Criteria**:
1. `normalizeStatus()` function updated to reject legacy values
2. Added `LEGACY_QUEUE_STATUSES` constant with `['resolved', 'null']`
3. Added rejection reason `'legacy_queue_status'` for legacy status values
4. Added rejection reason `'missing_status'` for null status
5. All TDD tests from Task 1 PASS
6. No existing functionality broken
7. Code follows existing patterns in the file

**Implementation Details**:
- Extend `normalizeStatus()` to explicitly return `null` for legacy values
- Add early rejection check for legacy statuses in `evaluatePhase3Inputs()`
- Ensure deduplication of rejection reasons with existing `dedupe()` function
- Maintain backward compatibility with existing valid statuses (`pending`, `in_progress`, `completed`)

### Task 3: Add Timeout-Only Outcome Filtering

**Description**: Add logic to filter task outcomes that are only `timeout` (e.g., `resolution: 'auto_completed_timeout'`) so they don't count as positive capability evidence.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of task outcomes and evidence collection
- Skills: [`superpowers/test-driven-development`] - Write tests before implementation

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: TDD approach for new filtering
- INCLUDED `systematic-debugging`: May need to debug outcome validation
- OMITTED `triage-issue`: Not debugging existing code

**Depends On**: Task 2

**Acceptance Criteria**:
1. TDD tests written for timeout-only outcome filtering
2. Added `filterTimeoutOnlyOutcomes()` function
3. Added rejection reason `'timeout_only_outcome'`
4. Tasks with only timeout outcomes are excluded from eligible samples
5. Tasks with mixed outcomes (timeout + success) are allowed
6. All tests PASS
7. No existing functionality broken

**Expected Test Cases**:
```typescript
it('rejects tasks with only timeout outcomes', () => {
  const result = evaluatePhase3Inputs(
    [{
      id: 'e5da4f5c',
      status: 'completed',
      resolution: 'auto_completed_timeout',
      completed_at: '2026-03-24T15:29:39.710Z'
    }],
    { score: 85, frozen: true }
  );
  expect(result.evolution.rejected[0].reasons).toContain('timeout_only_outcome');
});

it('allows tasks with mixed outcomes (timeout + success)', () => {
  const result = evaluatePhase3Inputs(
    [{
      id: 'task-mixed',
      status: 'completed',
      completed_at: '2026-03-24T15:29:39.710Z'
      // No resolution field or resolution: 'marker_detected'
    }],
    { score: 85, frozen: true }
  );
  expect(result.evolution.eligible).toHaveLength(1);
});
```

### Task 4: Integrate All Filters in evaluatePhase3Inputs

**Description**: Update the main `evaluatePhase3Inputs()` function to integrate all validation filters and produce the final Phase 3 eligibility result.

**Delegation Recommendation**:
- Category: `deep` - Integration task with multiple dependencies
- Skills: [`superpowers/test-driven-development`] - Verify integration with tests

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Integration tests drive development
- INCLUDED `verification-before-completion`: Verify all filters work together
- OMITTED `writing-plans`: No planning needed

**Depends On**: Task 3, Task 8

**Acceptance Criteria**:
1. `evaluatePhase3Inputs()` calls all validation filters in correct order
2. All rejection reasons properly accumulated and deduplicated
3. `queueTruthReady` only true when queue has eligible samples and no rejections
4. `trustInputReady` only true when trust validation passes
5. `phase3ShadowEligible` requires both queue and trust readiness
6. All TDD tests PASS
7. Integration tests with production sample data PASS
8. No existing tests broken

**Filter Order**:
1. Task ID normalization and deduplication
2. Status validation (legacy, missing, invalid)
3. Lifecycle marker validation (timestamps)
4. Timeout-only outcome filtering
5. Trust input validation (frozen, score)
6. Final eligibility calculation

### Task 5: Update Integration Tests with Production Sample

**Description**: Add integration test using actual production sample from `D:\Code\spicy_evolver_souls` to verify the filter handles real-world data correctly.

**Delegation Recommendation**:
- Category: `unspecified-high` - Integration testing with real data
- Skills: [`verification-before-completion`] - Verify against production evidence

**Skills Evaluation**:
- INCLUDED `verification-before-completion`: Essential for validation
- INCLUDED `systematic-debugging`: Debug if production test fails
- OMITTED `brainstorming`: Not creative work

**Depends On**: Task 4

**Acceptance Criteria**:
1. Integration test added using `evolution_queue.json` sample data
2. Integration test added using `AGENT_SCORECARD.json` sample data
3. Test verifies:
   - Legacy `resolved` rows are rejected
   - `null` status rows are rejected
   - Timeout-only outcomes are excluded
   - Unfrozen trust input is rejected
4. Test documents expected rejection reasons
5. Test PASS
6. Test includes comments explaining production context

**Test Example**:
```typescript
it('handles production sample from spicy_evolver_souls correctly', () => {
  const productionQueue = loadProductionQueueSample();
  const productionTrust = loadProductionTrustSample();

  const result = evaluatePhase3Inputs(productionQueue, productionTrust);

  // Verify legacy rejections
  expect(result.evolution.rejected.map(r => r.taskId)).toContain('1afdd4bb'); // resolved status
  expect(result.evolution.rejected.map(r => r.taskId)).toContain('6a7c7c48'); // null status

  // Verify trust rejection
  expect(result.trust.rejectedReasons).toContain('legacy_or_unfrozen_trust_schema');

  // Verify timeout exclusions
  const timeoutOnlyTasks = result.evolution.rejected.filter(
    r => r.reasons.includes('timeout_only_outcome')
  );
  expect(timeoutOnlyTasks.length).toBeGreaterThan(0);

  // Verify overall eligibility
  expect(result.phase3ShadowEligible).toBe(false);
});
```

### Task 6: Write TDD Tests for Trust Input Validation

**Description**: Create TDD tests for trust input validation, focusing on `frozen` flag and `score` validation.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of trust schema and validation logic
- Skills: [`superpowers/test-driven-development`] - TDD approach

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Test-first development
- INCLUDED `tdd`: TDD methodology
- OMITTED `writing-skills`: Not documentation

**Depends On**: None

**Acceptance Criteria**:
1. Test suite created with 5+ test cases covering:
   - Frozen trust with valid score → accepted
   - Unfrozen trust → rejected
   - Null frozen value → rejected
   - Missing trust score → rejected
   - Invalid trust score (NaN, infinity) → rejected
2. All tests FAIL initially
3. Tests follow existing patterns
4. Tests in existing test file

**Expected Test Cases**:
```typescript
it('accepts frozen trust with valid score', () => {
  const result = evaluatePhase3Inputs(
    [{ id: 'task-1', status: 'pending' }],
    { score: 85, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
  );
  expect(result.trust.eligible).toBe(true);
  expect(result.trust.rejectedReasons).toHaveLength(0);
});

it('rejects unfrozen trust schema', () => {
  const result = evaluatePhase3Inputs(
    [{ id: 'task-1', status: 'pending' }],
    { score: 85, frozen: false, lastUpdated: '2026-03-20T10:00:00Z' }
  );
  expect(result.trust.eligible).toBe(false);
  expect(result.trust.rejectedReasons).toContain('legacy_or_unfrozen_trust_schema');
});

it('rejects missing trust score', () => {
  const result = evaluatePhase3Inputs(
    [{ id: 'task-1', status: 'pending' }],
    { score: null, frozen: true, lastUpdated: '2026-03-20T10:00:00Z' }
  );
  expect(result.trust.eligible).toBe(false);
  expect(result.trust.rejectedReasons).toContain('missing_trust_score');
});
```

### Task 7: Implement Trust Input Validation

**Description**: Implement trust input validation logic to make TDD tests pass, ensuring only frozen trust schemas are accepted.

**Delegation Recommendation**:
- Category: `deep` - Validation logic implementation
- Skills: [`superpowers/test-driven-development`] - TDD continuation

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Implement to pass tests
- OMITTED `grill-me`: No interview needed
- OMITTED `triage-issue`: Not diagnosing bugs

**Depends On**: Task 6

**Acceptance Criteria**:
1. Trust validation logic implemented in `evaluatePhase3Inputs()`
2. Frozen flag validation: `trust.frozen !== true` → reject
3. Score validation: null/NaN/Infinity → reject
4. Rejection reasons added: `'legacy_or_unfrozen_trust_schema'`, `'missing_trust_score'`
5. All TDD tests PASS
6. No existing functionality broken
7. Logic matches production evidence (unfrozen trust rejected)

### Task 8: Update Runtime Summary Service Tests

**Description**: Update runtime-summary-service.test.ts to verify the updated phase3-input-filter is correctly integrated and produces expected results.

**Delegation Recommendation**:
- Category: `unspecified-high` - Integration test updates
- Skills: [`verification-before-completion`] - Verify integration

**Skills Evaluation**:
- INCLUDED `verification-before-completion`: Ensure tests validate behavior
- INCLUDED `systematic-debugging`: Debug if tests fail
- OMITTED `brainstorming`: Not creative

**Depends On**: Task 2, Task 7

**Acceptance Criteria**:
1. Existing tests updated to expect new rejection reasons
2. New tests added for legacy queue status rejection
3. New tests added for timeout-only outcome filtering
4. New tests added for unfrozen trust rejection
5. All tests PASS
6. Tests follow existing patterns in runtime-summary-service.test.ts
7. Tests use production sample data where appropriate

**Test Updates**:
```typescript
it('reports legacy queue status as rejection reason in phase3 section', () => {
  // ... setup with resolved status ...
  const summary = RuntimeSummaryService.getSummary(workspace);
  expect(summary.phase3.evolutionRejectedReasons).toContain('legacy_queue_status');
});

it('reports unfrozen trust as rejection reason in phase3 section', () => {
  // ... setup with frozen: false ...
  const summary = RuntimeSummaryService.getSummary(workspace);
  expect(summary.phase3.trustRejectedReasons).toContain('legacy_or_unfrozen_trust_schema');
});
```

## Commit Strategy

Atomic commits following RED→GREEN→REFACTOR TDD cycle:

1. **Commit 1**: `test(3a-01): add failing tests for legacy queue status rejection`
   - Task 1: Add TDD tests (RED state)

2. **Commit 2**: `feat(3a-01): implement legacy queue status rejection`
   - Task 2: Implement filtering (GREEN state)

3. **Commit 3**: `test(3a-01): add failing tests for trust input validation`
   - Task 6: Add TDD tests (RED state)

4. **Commit 4**: `feat(3a-01): implement trust input validation`
   - Task 7: Implement validation (GREEN state)

5. **Commit 5**: `test(3a-01): add failing tests for timeout-only outcome filtering`
   - Task 3: Add TDD tests (RED state)

6. **Commit 6**: `feat(3a-01): implement timeout-only outcome filtering`
   - Task 3: Implementation (GREEN state)

7. **Commit 7**: `test(3a-01): update runtime-summary-service integration tests`
   - Task 8: Integration test updates

8. **Commit 8**: `refactor(3a-01): integrate all filters in evaluatePhase3Inputs`
   - Task 4: Integration and refactoring (REFACTOR state)

9. **Commit 9**: `test(3a-01): add production sample integration test`
   - Task 5: Production sample test

Each commit:
- Passes all tests (`npm test` in packages/openclaw-plugin)
- Follows conventional commits format
- Has single logical purpose
- Is reversible in isolation

## Success Criteria

Overall phase verification:

1. **Code Quality**:
   - [ ] All TDD tests pass: `npm test -- phase3-input-filter`
   - [ ] All integration tests pass: `npm test -- runtime-summary-service`
   - [ ] All existing tests still pass: `npm test`
   - [ ] No TypeScript errors: `npm run build`
   - [ ] Code follows existing patterns in codebase

2. **Functional Requirements (A0)**:
   - [ ] Queue rows with `resolved` status are rejected with `legacy_queue_status` reason
   - [ ] Queue rows with `null` status are rejected with `missing_status` reason
   - [ ] Queue rows with invalid status are rejected with `invalid_status` reason
   - [ ] Queue rows with missing lifecycle markers are rejected
   - [ ] Workspaces with `frozen !== true` are rejected with `legacy_or_unfrozen_trust_schema` reason
   - [ ] Task outcomes that are only `timeout` are excluded from positive capability evidence

3. **Production Validation**:
   - [ ] Production sample from `D:\Code\spicy_evolver_souls` correctly rejected
   - [ ] Phase 3 eligibility false for dirty inputs
   - [ ] Rejection reasons explicitly surfaced in evolution-status output
   - [ ] Operator can see why Phase 3 is blocked

4. **Test Coverage**:
   - [ ] New TDD tests cover all rejection paths
   - [ ] Integration tests verify end-to-end behavior
   - [ ] Production sample test validates real-world data

## Output

After completion, create `.planning/phases/3A/3A-01-SUMMARY.md` with:
- What was implemented (A0: Phase 3 Input Quarantine)
- Test coverage statistics
- Production validation results
- Remaining tasks (A1, A2)
