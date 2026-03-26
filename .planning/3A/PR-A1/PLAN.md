---
phase: 3A
plan: 02
type: tdd
wave: 2
depends_on: ["01"]
files_modified: [
  "packages/openclaw-plugin/src/service/evolution-worker.ts",
  "packages/openclaw-plugin/src/service/runtime-summary-service.ts",
  "packages/openclaw-plugin/src/commands/evolution-status.ts",
  "packages/openclaw-plugin/src/hooks/prompt.ts",
  "packages/openclaw-plugin/tests/service/evolution-worker.test.ts",
  "packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts",
  "packages/openclaw-plugin/tests/commands/evolution-status.test.ts"
]
autonomous: true
requirements: ["A1"]
user_setup: []
must_haves:
  truths:
    - "evolution_directive.json is never used for Phase 3 eligibility decisions"
    - "evolution_directive.json is labeled as compatibility-only display artifact"
    - "queue remains the only execution truth source for Phase 3"
    - "missing or stale directive does not degrade clean queue eligibility"
    - "evolution-status output explicitly states directive is compatibility-only"
  artifacts:
    - path: "packages/openclaw-plugin/src/service/evolution-worker.ts"
      provides: "Evolution worker that ignores directive for eligibility"
      contains: "comment 'directive is compatibility-only, not a truth source'"
    - path: "packages/openclaw-plugin/src/service/runtime-summary-service.ts"
      provides: "Runtime summary that excludes directive from Phase 3 readiness"
      contains: "directiveCompatibilityOnly flag or comment"
    - path: "packages/openclaw-plugin/src/commands/evolution-status.ts"
      provides: "Status command that reports directive as compatibility artifact"
      contains: "Directive: compatibility-only display artifact"
  key_links:
    - from: "evaluatePhase3Inputs"
      to: "evolution_directive.json"
      via: "must NOT read directive file"
      pattern: "!evolution_directive.*read"
    - from: "evolution-status"
      to: "operator display"
      via: "explicitly label directive"
      pattern: "compatibility-only.*display.*artifact"
    - from: "phase3 eligibility"
      to: "queue truth"
      via: "only queue matters for eligibility"
      pattern: "queue.*truth.*only"
---

# Plan 3A-02: Demote EVOLUTION_DIRECTIVE To Compatibility-Only

## Context

User Request Summary:
Implement A1 requirement to demote `evolution_directive.json` from truth source to compatibility-only display artifact. Production evidence shows the directive file is stale persisted sidecar state (stopped updating on 2026-03-22) and must not be used for Phase 3 eligibility decisions.

Required Outcomes:
1. Stop using directive file in any Phase 3 eligibility or decision path
2. Keep it only as compatibility display input if still needed for legacy support
3. Make runtime summary and status explicitly state "directive is compatibility-only"
4. Queue remains the only execution truth source for Phase 3

Uncertainties:
None - production data clearly shows directive is stale and unreliable as a truth source.

## Task Dependency Graph

| Task | Depends On | Reason |
|------|------------|--------|
| Task 1 | None | Starting point - write TDD tests first |
| Task 2 | Task 1 | Tests define behavior before implementation |
| Task 3 | Task 2 | Directive removal from worker is prerequisite for summary service |
| Task 4 | Task 3 | Runtime summary must reflect worker changes |
| Task 5 | Task 4 | Status command depends on summary service |
| Task 6 | Task 5 | Prompt hook uses evolution status output |
| Task 7 | Task 5 | Integration test verifies end-to-end behavior |

## Parallel Execution Graph

Wave 1 (Start immediately):
└── Task 1: Write TDD tests for directive exclusion from eligibility (no dependencies)

Wave 2 (After Wave 1 completes):
└── Task 2: Remove directive from Phase 3 eligibility logic (depends: Task 1)

Wave 3 (After Wave 2 completes):
├── Task 3: Update evolution-worker to label directive as compatibility-only (depends: Task 2)
└── Task 8: Write TDD tests for directive status labeling (no dependencies, can run parallel with Task 2)

Wave 4 (After Wave 3 completes):
├── Task 4: Update runtime-summary-service to exclude directive (depends: Task 3, Task 8)
└── Task 9: Write TDD tests for evolution-status output (no dependencies, can run parallel with Task 3)

Wave 5 (After Wave 4 completes):
├── Task 5: Update evolution-status command to display directive as compatibility-only (depends: Task 4, Task 9)
└── Task 6: Update prompt hook if it references directive (depends: Task 5)

Wave 6 (After Wave 5 completes):
└── Task 7: Add integration test for end-to-end directive handling (depends: Task 5, Task 6)

Critical Path: Task 1 → Task 2 → Task 3 → Task 4 → Task 5 → Task 7
Estimated Parallel Speedup: 35% faster than sequential (through test parallelism)

## Tasks

### Task 1: Write TDD Tests for Directive Exclusion from Phase 3 Eligibility

**Description**: Create comprehensive TDD tests to verify that `evolution_directive.json` is never used for Phase 3 eligibility decisions. Tests must fail initially, then pass after directive is removed from eligibility logic.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of Phase 3 eligibility, directive role, and queue truth source
- Skills: [`superpowers/test-driven-development`, `tdd`] - TDD approach is mandatory

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Essential for RED→GREEN→REFACTOR cycle
- INCLUDED `tdd`: Core TDD methodology
- OMITTED `systematic-debugging`: No debugging needed yet (tests first)
- OMITTED `writing-skills`: Not documentation

**Depends On**: None

**Acceptance Criteria**:
1. Test suite created in `packages/openclaw-plugin/tests/service/evolution-worker.test.ts`
2. Test cases cover:
   - Phase 3 eligibility with valid queue, no directive → eligible
   - Phase 3 eligibility with stale directive, valid queue → still eligible
   - Phase 3 eligibility with missing directive, valid queue → still eligible
   - Phase 3 eligibility with valid directive, invalid queue → not eligible
   - Phase 3 eligibility with empty queue → not eligible (directive irrelevant)
   - Directive file read is never called during eligibility check
3. All tests FAIL initially (RED phase)
4. Tests follow existing patterns in evolution-worker.test.ts

**Expected Test Cases**:
```typescript
describe('Phase 3 Eligibility - Directive Exclusion', () => {
  it('makes queue-only eligible when directive is missing', () => {
    const result = evolutionWorker.checkPhase3Eligibility({
      queue: [{ id: 'task-1', status: 'completed' }],
      directive: null // missing directive
    });
    expect(result.eligible).toBe(true);
    expect(result.eligibilityReason).not.toContain('directive');
  });

  it('makes queue-only eligible when directive is stale', () => {
    const result = evolutionWorker.checkPhase3Eligibility({
      queue: [{ id: 'task-1', status: 'completed' }],
      directive: { lastUpdated: '2026-03-22' } // stale (production shows stopped updating)
    });
    expect(result.eligible).toBe(true);
    expect(result.eligibilityReason).not.toContain('directive');
  });

  it('rejects empty queue regardless of directive state', () => {
    const result = evolutionWorker.checkPhase3Eligibility({
      queue: [],
      directive: { active: true, lastUpdated: '2026-03-25' }
    });
    expect(result.eligible).toBe(false);
    expect(result.eligibilityReason).toContain('empty queue');
  });

  it('rejects invalid queue regardless of directive state', () => {
    const result = evolutionWorker.checkPhase3Eligibility({
      queue: [{ id: 'task-1', status: 'invalid' }],
      directive: { active: true, lastUpdated: '2026-03-25' }
    });
    expect(result.eligible).toBe(false);
    expect(result.eligibilityReason).toContain('queue');
  });

  it('never reads directive file during eligibility check', async () => {
    const spy = vi.spyOn(fs, 'readFileSync');
    await evolutionWorker.checkPhase3Eligibility({
      queue: [{ id: 'task-1', status: 'completed' }]
    });
    expect(spy).not.toHaveBeenCalledWith(
      expect.stringContaining('evolution_directive.json'),
      expect.anything()
    );
  });
});
```

### Task 2: Remove Directive from Phase 3 Eligibility Logic

**Description**: Update `evolution-worker.ts` to remove any dependencies on `evolution_directive.json` for Phase 3 eligibility decisions. Queue becomes the only truth source.

**Delegation Recommendation**:
- Category: `deep` - Requires careful removal of directive references while preserving queue-based eligibility
- Skills: [`superpowers/test-driven-development`] - Implementation must pass TDD tests

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Implement to pass TDD tests
- INCLUDED `systematic-debugging`: May need to debug eligibility logic
- OMITTED `triage-issue`: Not diagnosing existing bugs

**Depends On**: Task 1

**Acceptance Criteria**:
1. `checkPhase3Eligibility()` function updated to ignore directive parameter
2. Queue is the only input determining eligibility
3. Any existing directive reading in eligibility path is removed
4. Comments added: "Directive is compatibility-only, not a Phase 3 truth source"
5. All TDD tests from Task 1 PASS
6. No existing functionality broken (if any, queue-based logic preserved)

**Implementation Details**:
- Locate `checkPhase3Eligibility()` or similar function
- Remove any checks like `if (!directive.active) return false`
- Remove any directive freshness validation
- Add explicit comment: `// directive is compatibility-only display artifact, not a truth source for Phase 3 eligibility`
- Ensure queue validation remains intact

### Task 3: Update Evolution Worker to Label Directive as Compatibility-Only

**Description**: Add explicit labels and comments in `evolution-worker.ts` to make it clear that directive is only used for display/compatibility, not control decisions.

**Delegation Recommendation**:
- Category: `unspecified-low` - Documentation/commentary task with low complexity
- Skills: None required - straightforward labeling task

**Skills Evaluation**:
- INCLUDED `writing-skills`: Ensure clear, explicit wording
- OMITTED `tdd`: Not TDD (documentation only)
- OMITTED `verification-before-completion`: Simple labeling task

**Depends On**: Task 2

**Acceptance Criteria**:
1. Function `loadDirective()` has JSDoc: "Loads evolution_directive.json for compatibility display only. Not a truth source."
2. Any directive usage in display/rendering paths labeled: `// compatibility-only display`
3. Worker config/state object has field: `directiveCompatibilityOnly: true`
4. No new functionality, only documentation and labeling
5. All tests still pass

**Expected Comments**:
```typescript
/**
 * Loads evolution_directive.json for compatibility display only.
 * NOT a truth source for Phase 3 eligibility or decisions.
 * Queue is the only authoritative execution truth source.
 */
function loadDirective(stateDir: string): Directive | null {
  // ...
}

// compatibility-only display artifact, used for UI/backwards compatibility
// not a decision-making input
const directive = loadDirective(this.stateDir);
```

### Task 4: Update Runtime Summary Service to Exclude Directive from Phase 3 Readiness

**Description**: Modify `runtime-summary-service.ts` to ensure directive does not affect Phase 3 readiness reporting. Summary should explicitly state directive is compatibility-only.

**Delegation Recommendation**:
- Category: `deep` - Runtime summary is critical for operator visibility
- Skills: [`superpowers/test-driven-development`] - Write tests before changes

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: TDD for summary service
- INCLUDED `verification-before-completion`: Verify summary output
- OMITTED `writing-skills`: Not documentation

**Depends On**: Task 3, Task 8

**Acceptance Criteria**:
1. Runtime summary `phase3` section has field: `directiveStatus: 'compatibility-only'` or similar
2. Phase 3 readiness calculation does not check directive state
3. Phase 3 readiness depends only on queue and trust inputs
4. Runtime summary test suite updated with new test cases
5. All tests PASS

**Expected Output Structure**:
```typescript
interface Phase3Summary {
  queueTruthReady: boolean;
  trustInputReady: boolean;
  phase3ShadowEligible: boolean;
  directiveStatus: 'compatibility-only' | 'missing' | 'present';
  directiveIgnoredReason: 'queue is only truth source' | null;
}
```

### Task 5: Update Evolution Status Command to Display Directive as Compatibility-Only

**Description**: Update `/pd-status` command output to explicitly state that `evolution_directive.json` is a compatibility-only display artifact, not a truth source.

**Delegation Recommendation**:
- Category: `unspecified-low` - CLI output formatting task
- Skills: [`verification-before-completion`] - Verify CLI output

**Skills Evaluation**:
- INCLUDED `verification-before-completion`: Ensure CLI output is clear
- INCLUDED `writing-skills`: Clear wording for operator
- OMITTED `tdd`: Not TDD (output formatting)

**Depends On**: Task 4, Task 9

**Acceptance Criteria**:
1. `/pd-status` command output has section:
   ```
   Directive: compatibility-only display artifact
   Note: Directive is NOT a truth source for Phase 3 eligibility
   Queue is the only authoritative execution truth source
   ```
2. Directive status labeled in all relevant sections
3. No misleading wording like "directive active" or "directive governs eligibility"
4. CLI tests updated to expect new output format
5. All tests PASS

**Expected CLI Output**:
```
Phase 3 Status:
  Queue Truth: ✅ Ready (3 eligible samples)
  Trust Input: ❌ Rejected (unfrozen trust schema)
  Directive: 🟡 Compatibility-only (display artifact)
  Phase 3 Eligibility: ❌ Blocked by trust input

Note: evolution_directive.json is maintained for compatibility only.
Queue is the only authoritative truth source for Phase 3 decisions.
```

### Task 6: Update Prompt Hook to Exclude Directive from Phase 3 Injection

**Description**: Review and update `prompt.ts` (before_prompt_build hook) to ensure directive is not used for any Phase 3-related context injection into prompts.

**Delegation Recommendation**:
- Category: `deep` - Prompt hooks are critical for agent behavior
- Skills: [`superpowers/test-driven-development`] - Write tests for prompt injection

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: TDD for prompt hook
- INCLUDED `verification-before-completion`: Verify prompt output
- OMITTED `characteristic-voice`: Not TTS-related

**Depends On**: Task 5

**Acceptance Criteria**:
1. If directive was used in prompt injection for Phase 3, remove it
2. If directive is still used, add comment: `// compatibility-only display, not a truth source`
3. Prompt hook tests verify directive is not injected for Phase 3 eligibility decisions
4. All tests PASS
5. No change to non-Phase 3 prompt content (if any)

**Expected Change**:
```typescript
// Before (if present):
if (directive.active) {
  context.add(`Phase 3 directive: ${directive.status}`);
}

// After (removed or commented):
// Directive is compatibility-only, not injected into Phase 3 context
// Queue truth is used instead via runtime-summary
```

### Task 7: Add Integration Test for End-to-End Directive Handling

**Description**: Create integration test that verifies the complete flow: directive file exists but is ignored for Phase 3 eligibility, and CLI output correctly labels it as compatibility-only.

**Delegation Recommendation**:
- Category: `unspecified-high` - Integration testing across multiple components
- Skills: [`verification-before-completion`] - Verify end-to-end behavior

**Skills Evaluation**:
- INCLUDED `verification-before-completion`: Essential for integration test
- INCLUDED `systematic-debugging`: Debug if integration fails
- OMITTED `brainstorming`: Not creative

**Depends On**: Task 5, Task 6

**Acceptance Criteria**:
1. Integration test creates temporary workspace with:
   - Valid queue data
   - Stale directive file (lastUpdated: 2026-03-22)
2. Test calls `evolution-status` command
3. Test verifies:
   - Phase 3 eligibility based on queue, not directive
   - Output states directive is compatibility-only
   - Directive status does not affect eligibility
4. Test PASS
5. Test includes comments explaining production context

**Test Example**:
```typescript
it('handles stale directive correctly in production scenario', async () => {
  const workspace = await createTestWorkspace({
    queue: [{ id: 'task-1', status: 'completed' }],
    directive: { active: true, lastUpdated: '2026-03-22' }, // stale
    trust: { score: 85, frozen: true }
  });

  const result = await executeCommand('/pd-status');

  expect(result.stdout).toContain('Directive: compatibility-only');
  expect(result.stdout).toContain('Queue Truth: ✅ Ready');
  expect(result.stdout).toContain('Phase 3 Eligibility: ✅ Eligible');
  expect(result.stdout).not.toContain('directive governs');
});
```

### Task 8: Write TDD Tests for Directive Status Labeling

**Description**: Create TDD tests to verify that directive status is correctly labeled as compatibility-only in runtime summary and status output.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of summary structure and status output
- Skills: [`superpowers/test-driven-development`, `tdd`] - TDD approach

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Test-first development
- INCLUDED `tdd`: Core TDD methodology
- OMITTED `writing-skills`: Not documentation

**Depends On**: None (can run in parallel with Task 2)

**Acceptance Criteria**:
1. Test suite created in runtime-summary-service.test.ts and evolution-status.test.ts
2. Test cases cover:
   - Missing directive → status: 'missing'
   - Present directive → status: 'compatibility-only'
   - Stale directive → still labeled compatibility-only (not "stale")
   - Runtime summary has directiveStatus field
   - CLI output contains compatibility-only wording
3. All tests FAIL initially (RED phase)
4. Tests follow existing patterns

**Expected Test Cases**:
```typescript
it('labels directive as compatibility-only when present', () => {
  const summary = RuntimeSummaryService.getSummary({
    queue: [{ id: 'task-1', status: 'completed' }],
    directive: { active: true }
  });
  expect(summary.phase3.directiveStatus).toBe('compatibility-only');
});

it('reports missing directive status', () => {
  const summary = RuntimeSummaryService.getSummary({
    queue: [{ id: 'task-1', status: 'completed' }],
    directive: null
  });
  expect(summary.phase3.directiveStatus).toBe('missing');
});
```

### Task 9: Write TDD Tests for Evolution Status Output

**Description**: Create TDD tests to verify `/pd-status` command output explicitly labels directive as compatibility-only.

**Delegation Recommendation**:
- Category: `deep` - CLI output testing requires understanding of command structure
- Skills: [`superpowers/test-driven-development`] - TDD for CLI tests

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Test-first for CLI
- INCLUDED `verification-before-completion`: Verify CLI output
- OMITTED `tavily`: Not web search

**Depends On**: None (can run in parallel with Task 3)

**Acceptance Criteria**:
1. Test suite created in evolution-status.test.ts
2. Test cases cover:
   - Output contains "compatibility-only" when directive exists
   - Output contains "Queue is the only authoritative truth source"
   - Output does NOT contain misleading directive authority claims
3. All tests FAIL initially (RED phase)
4. Tests follow existing CLI test patterns

**Expected Test Cases**:
```typescript
it('displays directive as compatibility-only artifact', async () => {
  const output = await executeStatusCommand({
    directive: { active: true }
  });
  expect(output).toContain('Directive: compatibility-only');
  expect(output).toContain('Queue is the only authoritative truth source');
});

it('does not claim directive governs Phase 3', async () => {
  const output = await executeStatusCommand({
    directive: { active: true }
  });
  expect(output).not.toMatch(/directive.*govern(s|ing).*Phase 3/i);
  expect(output).not.toMatch(/directive.*control(s).*eligibility/i);
});
```

## Commit Strategy

Atomic commits following RED→GREEN→REFACTOR TDD cycle:

1. **Commit 1**: `test(3a-02): add failing tests for directive exclusion from Phase 3 eligibility`
   - Task 1: Add TDD tests (RED state)

2. **Commit 2**: `feat(3a-02): remove directive from Phase 3 eligibility logic`
   - Task 2: Remove directive from eligibility (GREEN state)

3. **Commit 3**: `docs(3a-02): label directive as compatibility-only in evolution-worker`
   - Task 3: Add labels and comments

4. **Commit 4**: `test(3a-02): add failing tests for directive status labeling`
   - Task 8: Add TDD tests (RED state)

5. **Commit 5**: `test(3a-02): add failing tests for evolution-status output`
   - Task 9: Add CLI tests (RED state)

6. **Commit 6**: `feat(3a-02): update runtime-summary-service to exclude directive from Phase 3`
   - Task 4: Update summary service (GREEN state)

7. **Commit 7**: `feat(3a-02): update evolution-status command to display directive as compatibility-only`
   - Task 5: Update CLI output (GREEN state)

8. **Commit 8**: `feat(3a-02): update prompt hook to exclude directive from Phase 3 injection`
   - Task 6: Update prompt hook (GREEN state)

9. **Commit 9**: `test(3a-02): add integration test for end-to-end directive handling`
   - Task 7: Integration test

10. **Commit 10**: `refactor(3a-02): consolidate directive compatibility-only labeling`
    - Review all directive references and ensure consistent wording

Each commit:
- Passes all tests (`npm test` in packages/openclaw-plugin)
- Follows conventional commits format
- Has single logical purpose
- Is reversible in isolation

## Success Criteria

Overall phase verification:

1. **Code Quality**:
   - [ ] All TDD tests pass: `npm test -- evolution-worker`
   - [ ] All summary service tests pass: `npm test -- runtime-summary-service`
   - [ ] All CLI tests pass: `npm test -- evolution-status`
   - [ ] All existing tests still pass: `npm test`
   - [ ] No TypeScript errors: `npm run build`
   - [ ] Code follows existing patterns

2. **Functional Requirements (A1)**:
   - [ ] Directive is never read for Phase 3 eligibility decisions
   - [ ] Queue is the only authoritative truth source for Phase 3
   - [ ] Runtime summary labels directive as `compatibility-only`
   - [ ] CLI output explicitly states "Queue is the only authoritative truth source"
   - [ ] Missing or stale directive does not affect eligibility
   - [ ] Phase 3 eligibility calculation ignores directive parameter

3. **Operator Visibility**:
   - [ ] `/pd-status` output clearly shows directive status
   - [ ] Operator can see directive is compatibility-only
   - [ ] No misleading claims about directive authority

4. **Test Coverage**:
   - [ ] TDD tests cover all directive exclusion paths
   - [ ] Integration test verifies end-to-end behavior
   - [ ] CLI tests verify output format

## Output

After completion, create `.planning/phases/3A/3A-02-SUMMARY.md` with:
- What was implemented (A1: Demote directive to compatibility-only)
- Test coverage statistics
- Verification that queue is only truth source
- Remaining tasks (A2, A3, A4, A5)
