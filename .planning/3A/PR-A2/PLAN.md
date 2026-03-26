---
phase: 3A
plan: 03
type: tdd
wave: 3
depends_on: ["01", "02"]
files_modified: [
  "packages/openclaw-plugin/src/service/runtime-summary-service.ts",
  "packages/openclaw-plugin/src/commands/evolution-status.ts",
  "packages/openclaw-plugin/src/service/control-ui-query-service.ts",
  "packages/openclaw-plugin/src/core/trajectory.ts",
  "packages/openclaw-plugin/src/types/runtime-summary.ts",
  "packages/openclaw-plugin/tests/service/runtime-summary-service.test.ts",
  "packages/openclaw-plugin/tests/commands/evolution-status.test.ts"
]
autonomous: true
requirements: ["A2"]
user_setup: []
must_haves:
  truths:
    - "Runtime truth drives control decisions (queue, active sessions, current trust)"
    - "Analytics truth drives historical insights (trajectory, daily stats, trends)"
    - "Phase 3 filtering explicitly defines which analytics facts are allowed as evidence"
    - "Operator can distinguish runtime vs analytics in status output"
    - "Control UI queries are clearly labeled as analytics (read models)"
  artifacts:
    - path: "packages/openclaw-plugin/src/types/runtime-summary.ts"
      provides: "Type definitions separating runtime truth from analytics"
      contains: "RuntimeTruth, AnalyticsTruth interfaces"
    - path: "packages/openclaw-plugin/src/service/runtime-summary-service.ts"
      provides: "Summary service with explicit runtime/analytics separation"
      contains: "runtimeTruth, analyticsTruth sections"
    - path: "packages/openclaw-plugin/src/core/trajectory.ts"
      provides: "Trajectory labeled as analytics source, not runtime truth"
      contains: "comment 'analytics/historical data, not runtime truth'"
  key_links:
    - from: "Phase 3 eligibility"
      to: "runtime truth"
      via: "queue and trust inputs only"
      pattern: "queue.*trust.*eligibility"
    - from: "Phase 3 supporting evidence"
      to: "analytics truth"
      via: "explicit allow-list of analytics facts"
      pattern: "allowedAnalyticsEvidence.*trajectory"
    - from: "control-ui"
      to: "analytics"
      via: "read models, aggregated data"
      pattern: "analytics.*read.*model"
---

# Plan 3A-03: Reconcile Runtime Truth vs Analytics Truth

## Context

User Request Summary:
Implement A2 requirement to establish clear boundary between runtime truth and analytics truth. Runtime truth drives control decisions (queue state, active sessions, current trust score), while analytics truth provides historical insights (trajectory.db, daily stats, trends). Phase 3 filtering must explicitly define which analytics facts are allowed as supporting evidence.

Required Outcomes:
1. Mark runtime summary as runtime truth source
2. Mark dashboard/control UI as analytics (read models) unless and until read models are unified
3. Define which analytics facts may be used as supporting evidence for Phase 3
4. Operator can tell which surface is runtime and which is analytics

Uncertainties:
None - distinction between runtime (current state) and analytics (historical data) is clear.

## Task Dependency Graph

| Task | Depends On | Reason |
|------|------------|--------|
| Task 1 | None | Starting point - define types and interfaces |
| Task 2 | Task 1 | Types required before TDD tests |
| Task 3 | Task 2 | Tests define behavior before implementation |
| Task 4 | Task 3 | Runtime summary separation is prerequisite for status command |
| Task 5 | Task 4 | Status command depends on summary structure |
| Task 6 | Task 4 | Control UI query service uses summary structure |
| Task 7 | Task 5, Task 6 | Integration test verifies end-to-end separation |

## Parallel Execution Graph

Wave 1 (Start immediately):
└── Task 1: Define RuntimeTruth and AnalyticsTruth type interfaces (no dependencies)

Wave 2 (After Wave 1 completes):
├── Task 2: Label trajectory and analytics sources (depends: Task 1)
└── Task 8: Write TDD tests for runtime/analytics separation (no dependencies, can run parallel with Task 2)

Wave 3 (After Wave 2 completes):
├── Task 3: Implement runtime summary service separation (depends: Task 2, Task 8)
└── Task 9: Write TDD tests for allowed analytics evidence (no dependencies, can run parallel with Task 3)

Wave 4 (After Wave 3 completes):
├── Task 4: Update evolution-status command to show runtime vs analytics (depends: Task 3, Task 9)
└── Task 5: Update control-ui-query-service to label as analytics (depends: Task 3)

Wave 5 (After Wave 4 completes):
├── Task 6: Define allowed analytics evidence for Phase 3 (depends: Task 4, Task 5)
└── Task 7: Add integration test for analytics evidence filtering (depends: Task 4, Task 5)

Critical Path: Task 1 → Task 2 → Task 3 → Task 4 → Task 6
Estimated Parallel Speedup: 40% faster than sequential (through test parallelism)

## Tasks

### Task 1: Define RuntimeTruth and AnalyticsTruth Type Interfaces

**Description**: Create type definitions in `runtime-summary.ts` to explicitly separate runtime truth from analytics truth. This provides the foundation for clear boundaries throughout the codebase.

**Delegation Recommendation**:
- Category: `unspecified-low` - Type definition task with clear requirements
- Skills: [`writing-skills`] - Ensure clear, well-documented interfaces

**Skills Evaluation**:
- INCLUDED `writing-skills`: Clear type documentation is critical
- OMITTED `tdd`: Not TDD (type definitions only)
- OMITTED `verification-before-completion`: Simple type task

**Depends On**: None

**Acceptance Criteria**:
1. File created: `packages/openclaw-plugin/src/types/runtime-summary.ts` (if not exists, add to existing)
2. Interface `RuntimeTruth` defined with fields:
   - `queueState`: Current queue entries and status
   - `activeSessions`: List of active session IDs
   - `currentTrustScore`: Current frozen trust score
   - `workspaceState`: Current workspace state (frozen/unfrozen)
3. Interface `AnalyticsTruth` defined with fields:
   - `trajectoryData`: Historical task outcomes and trust changes
   - `dailyStats`: Aggregated daily statistics
   - `trends`: Trend analysis (7-day, 30-day)
   - `sampleHistory`: Historical correction samples
4. JSDoc comments clearly label each interface
5. Exported for use across codebase

**Expected Type Definitions**:
```typescript
/**
 * Runtime truth represents the current state of the system.
 * Used for control decisions, Phase 3 eligibility, and real-time operations.
 * Sources: queue state, workspace trust scorecard, active session registry
 */
export interface RuntimeTruth {
  queueState: {
    total: number;
    pending: number;
    inProgress: number;
    completed: number;
    lastUpdated: string;
  };
  activeSessions: string[];
  currentTrustScore: number;
  workspaceState: {
    frozen: boolean;
    lastUpdated: string;
  };
}

/**
 * Analytics truth represents historical data and aggregated metrics.
 * Used for insights, trends, and supporting evidence (where explicitly allowed).
 * NOT used for control decisions or Phase 3 eligibility.
 * Sources: trajectory.db, daily-stats.json, control-ui DB
 */
export interface AnalyticsTruth {
  trajectoryData: {
    totalTasks: number;
    successRate: number;
    timeoutRate: number;
    trustChanges: number;
    lastUpdated: string;
  };
  dailyStats: {
    toolCalls: number;
    painSignals: number;
    evolutionTasks: number;
    lastUpdated: string;
  };
  trends: {
    sevenDay: TrendMetrics;
    thirtyDay: TrendMetrics;
  };
}
```

### Task 2: Label Trajectory and Analytics Sources

**Description**: Add explicit labels and comments to `trajectory.ts`, `control-ui-db.ts`, and related files to make it clear these are analytics sources, not runtime truth.

**Delegation Recommendation**:
- Category: `unspecified-low` - Documentation/commentary task
- Skills: [`writing-skills`] - Ensure clear, explicit wording

**Skills Evaluation**:
- INCLUDED `writing-skills`: Clear labeling is critical for operator understanding
- OMITTED `tdd`: Not TDD (documentation only)
- OMITTED `systematic-debugging`: No debugging needed

**Depends On**: Task 1

**Acceptance Criteria**:
1. `trajectory.ts` has module-level comment:
   ```
   // Trajectory database stores HISTORICAL and ANALYTICS data
   // NOT a runtime truth source for control decisions
   // Use for trends, insights, and Phase 3 supporting evidence (where explicitly allowed)
   ```
2. `control-ui-db.ts` has module-level comment:
   ```
   // Control UI database stores ANALYTICS READ MODELS
   // NOT a runtime truth source
   // Used for dashboard queries and historical insights
   ```
3. Functions that query trajectory/control-ui have JSDoc: `// Returns analytics data, not runtime truth`
4. No functional changes, only documentation
5. All tests still pass

**Expected Comments**:
```typescript
// trajectory.ts

/**
 * Trajectory database stores historical analytics data.
 *
 * PURPOSE: Track task outcomes, trust changes, and evolution progress over time.
 * USAGE: Insights, trends, and Phase 3 supporting evidence (where explicitly allowed).
 * NOT FOR: Control decisions, Phase 3 eligibility, or real-time operations.
 *
 * Runtime truth comes from: queue state, workspace trust scorecard, active sessions
 */
export class TrajectoryService {
  // ...
}
```

### Task 3: Implement Runtime Summary Service Separation

**Description**: Update `runtime-summary-service.ts` to explicitly separate runtime truth from analytics truth in the summary output. Use the `RuntimeTruth` and `AnalyticsTruth` types defined in Task 1.

**Delegation Recommendation**:
- Category: `deep` - Core service that drives all Phase 3 readiness calculations
- Skills: [`superpowers/test-driven-development`] - TDD approach

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Test-first development
- INCLUDED `verification-before-completion`: Verify separation is correct
- OMITTED `writing-skills`: Implementation, not documentation

**Depends On**: Task 2, Task 8

**Acceptance Criteria**:
1. `RuntimeSummaryService.getSummary()` returns object with structure:
   ```typescript
   {
     runtime: RuntimeTruth;
     analytics: AnalyticsTruth;
     phase3: Phase3Readiness;
   }
   ```
2. Runtime section contains only: queue state, active sessions, current trust, workspace state
3. Analytics section contains only: trajectory data, daily stats, trends
4. Phase 3 readiness calculated from runtime truth only
5. Analytics used only for supporting evidence (if explicitly allowed)
6. All TDD tests PASS
7. No breaking changes to existing consumers

**Implementation Details**:
- Refactor existing summary structure into runtime/analytics sections
- Move queue-related fields to `runtime`
- Move trajectory-related fields to `analytics`
- Update `getSummary()` to populate both sections correctly
- Ensure Phase 3 readiness uses only `runtime` section

### Task 4: Update Evolution Status Command to Show Runtime vs Analytics

**Description**: Update `/pd-status` command output to explicitly distinguish between runtime truth and analytics truth, making it clear to operators what drives control decisions.

**Delegation Recommendation**:
- Category: `unspecified-low` - CLI output formatting task
- Skills: [`verification-before-completion`] - Verify CLI output is clear

**Skills Evaluation**:
- INCLUDED `verification-before-completion`: Ensure CLI output is operator-friendly
- INCLUDED `writing-skills`: Clear wording for operators
- OMITTED `tdd`: Not TDD (output formatting)

**Depends On**: Task 3, Task 9

**Acceptance Criteria**:
1. CLI output has two distinct sections:
   ```
   Runtime Truth (control decisions):
     Queue: 3 pending, 1 in-progress, 5 completed
     Active Sessions: 2
     Trust Score: 85 (frozen)

   Analytics Truth (historical insights):
     Trajectory: 35 tasks total, 1 success, 34 timeouts
     Daily Stats: 120 tool calls, 15 pain signals
     7-Day Trend: +5% success rate
   ```
2. Phase 3 eligibility section explicitly states: "Calculated from runtime truth only"
3. Analytics section labeled: "For insights and trends, not control decisions"
4. No confusing mixing of runtime and analytics
5. CLI tests updated to expect new format
6. All tests PASS

**Expected CLI Output**:
```
Workspace Status:

Runtime Truth (control decisions):
  Queue: ✅ 9 entries (3 pending, 1 in-progress, 5 completed)
  Active Sessions: 2
  Trust Score: 85 (frozen)
  Workspace: frozen

Analytics Truth (historical insights):
  Trajectory: 35 tasks (1 success, 34 timeouts)
  Daily Stats: 120 tool calls, 15 pain signals
  7-Day Trend: success rate +5%
  Note: Analytics used for insights and supporting evidence only

Phase 3 Readiness (calculated from runtime truth):
  Queue Truth: ✅ Ready
  Trust Input: ✅ Ready
  Phase 3 Eligibility: ✅ Eligible
```

### Task 5: Update Control UI Query Service to Label as Analytics

**Description**: Add explicit labels to `control-ui-query-service.ts` to make it clear that all queries return analytics data (read models), not runtime truth.

**Delegation Recommendation**:
- Category: `unspecified-low` - Documentation task
- Skills: [`writing-skills`] - Clear labeling

**Skills Evaluation**:
- INCLUDED `writing-skills`: Clear documentation for consumers
- OMITTED `tdd`: Not TDD
- OMITTED `systematic-debugging`: No debugging

**Depends On**: Task 3

**Acceptance Criteria**:
1. `control-ui-query-service.ts` has module-level comment:
   ```
   // Control UI Query Service returns ANALYTICS READ MODELS
   // NOT runtime truth
   // Used for dashboard visualization and historical insights
   ```
2. All query functions have JSDoc: `// Returns analytics data (read model), not runtime truth`
3. No functional changes, only documentation
4. All tests still pass

**Expected Comments**:
```typescript
/**
 * Control UI Query Service
 *
 * Provides aggregated analytics data for dashboard visualization.
 * All queries return READ MODELS (aggregated historical data).
 * NOT runtime truth - use runtime-summary-service for current state.
 */
export class ControlUIQueryService {
  /**
   * Get evolution task history.
   *
   * Returns: Analytics data (read model) aggregated from trajectory database
   * Not: Runtime truth or real-time queue state
   */
  async getEvolutionHistory(): Promise<EvolutionHistory> {
    // ...
  }
}
```

### Task 6: Define Allowed Analytics Evidence for Phase 3

**Description**: Create an explicit allow-list of which analytics facts may be used as supporting evidence for Phase 3 decisions. This prevents misuse of analytics as control truth.

**Delegation Recommendation**:
- Category: `deep` - Requires careful decision about what analytics are safe to use
- Skills: [`superpowers/test-driven-development`] - TDD for evidence filtering

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Test-first development
- INCLUDED `verification-before-completion`: Verify only allowed analytics are used
- OMITTED `brainstorming`: Not creative (clear rules defined in spec)

**Depends On**: Task 4, Task 5

**Acceptance Criteria**:
1. File created: `packages/openclaw-plugin/src/config/allowed-analytics-evidence.ts`
2. Define `ALLOWED_ANALYTICS_EVIDENCE` constant with:
   - `trajectory.successRate`: Allowed as supporting evidence for capability strength
   - `trajectory.timeoutRate`: Allowed as risk indicator (not capability evidence)
   - `trajectory.taskCount`: Allowed as sample size indicator
   - `dailyStats.toolCallVolume`: Allowed as activity indicator
   - `trends.sevenDayTrend`: Allowed as evidence of improvement/deterioration
3. Explicitly exclude:
   - `trajectory.trustChanges`: Blocked (dominated by old semantics per production data)
   - `dailyStats.painSignals`: Blocked (noisy, not capability evidence)
   - Any other analytics not in allow-list
4. Add function `isAnalyticsAllowedForPhase3(source, field)` that checks allow-list
5. TDD tests verify filtering works correctly
6. All tests PASS

**Expected Code**:
```typescript
/**
 * Analytics facts explicitly allowed as supporting evidence for Phase 3.
 *
 * These are NOT control truth sources. They are supporting evidence only.
 * Phase 3 eligibility and decisions are still driven by runtime truth (queue, trust).
 */
export const ALLOWED_ANALYTICS_EVIDENCE = {
  // Trajectory analytics
  'trajectory.successRate': {
    allowed: true,
    purpose: 'supporting evidence for capability strength',
    weight: 'low',
  },
  'trajectory.timeoutRate': {
    allowed: true,
    purpose: 'risk indicator (not capability evidence)',
    weight: 'high',
  },
  'trajectory.taskCount': {
    allowed: true,
    purpose: 'sample size indicator',
    weight: 'low',
  },

  // Daily stats analytics
  'dailyStats.toolCallVolume': {
    allowed: true,
    purpose: 'activity indicator',
    weight: 'low',
  },

  // Trends
  'trends.sevenDayTrend': {
    allowed: true,
    purpose: 'evidence of improvement/deterioration',
    weight: 'medium',
  },

  // EXCLUDED analytics
  'trajectory.trustChanges': {
    allowed: false,
    reason: 'dominated by old success-inflation semantics per production data',
  },
  'dailyStats.painSignals': {
    allowed: false,
    reason: 'noisy, not reliable capability evidence',
  },
} as const;

/**
 * Check if analytics fact is allowed as Phase 3 supporting evidence.
 */
export function isAnalyticsAllowedForPhase3(source: string, field: string): boolean {
  const key = `${source}.${field}`;
  const entry = ALLOWED_ANALYTICS_EVIDENCE[key];
  return entry?.allowed ?? false;
}
```

### Task 7: Add Integration Test for Analytics Evidence Filtering

**Description**: Create integration test that verifies only allowed analytics facts are used as Phase 3 supporting evidence, and excluded analytics are correctly blocked.

**Delegation Recommendation**:
- Category: `unspecified-high` - Integration testing across analytics filtering logic
- Skills: [`verification-before-completion`] - Verify filtering works end-to-end

**Skills Evaluation**:
- INCLUDED `verification-before-completion`: Essential for integration test
- INCLUDED `systematic-debugging`: Debug if filtering fails
- OMITTED `brainstorming`: Not creative

**Depends On**: Task 4, Task 5

**Acceptance Criteria**:
1. Integration test creates workspace with:
   - Runtime truth: valid queue, frozen trust
   - Analytics: trajectory with successRate, timeoutRate, trustChanges
2. Test verifies:
   - `successRate` is used as supporting evidence
   - `timeoutRate` is used as risk indicator
   - `trustChanges` is EXCLUDED from Phase 3 evidence
   - Phase 3 eligibility still determined by runtime truth
3. Test PASS
4. Test includes comments explaining why certain analytics are excluded

**Test Example**:
```typescript
it('filters analytics evidence correctly for Phase 3', async () => {
  const workspace = await createTestWorkspace({
    runtime: {
      queue: [{ id: 'task-1', status: 'completed' }],
      trust: { score: 85, frozen: true }
    },
    analytics: {
      trajectory: {
        successRate: 0.03, // allowed
        timeoutRate: 0.97, // allowed as risk
        trustChanges: 100, // excluded (old semantics)
      }
    }
  });

  const phase3Readiness = await checkPhase3Readiness(workspace);

  // Verify runtime truth drives eligibility
  expect(phase3Readiness.eligible).toBe(true);
  expect(phase3Readiness.eligibilitySource).toBe('runtime_truth');

  // Verify allowed analytics used as supporting evidence
  expect(phase3Readiness.supportingEvidence).toContain('trajectory.successRate');
  expect(phase3Readiness.risks).toContain('high timeout rate');

  // Verify excluded analytics not used
  expect(phase3Readiness.supportingEvidence).not.toContain('trajectory.trustChanges');
});
```

### Task 8: Write TDD Tests for Runtime/Analytics Separation

**Description**: Create comprehensive TDD tests to verify that runtime summary service correctly separates runtime truth from analytics truth.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of both runtime and analytics concepts
- Skills: [`superpowers/test-driven-development`, `tdd`] - TDD approach

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Test-first development
- INCLUDED `tdd`: Core TDD methodology
- OMITTED `systematic-debugging`: No debugging yet

**Depends On**: None (can run in parallel with Task 2)

**Acceptance Criteria**:
1. Test suite created in runtime-summary-service.test.ts
2. Test cases cover:
   - Runtime truth section contains only queue, sessions, trust, workspace state
   - Analytics truth section contains only trajectory, daily stats, trends
   - Phase 3 readiness calculated from runtime truth only
   - Analytics section not used for eligibility
   - Summary structure matches RuntimeTruth and AnalyticsTruth interfaces
3. All tests FAIL initially (RED phase)
4. Tests follow existing patterns

**Expected Test Cases**:
```typescript
describe('Runtime vs Analytics Separation', () => {
  it('populates runtime truth section with queue, sessions, trust, workspace state', () => {
    const summary = RuntimeSummaryService.getSummary({
      queue: [{ id: 'task-1', status: 'pending' }],
      sessions: ['session-1'],
      trust: { score: 85, frozen: true },
      workspace: { frozen: true }
    });

    expect(summary.runtime.queueState.total).toBe(1);
    expect(summary.runtime.activeSessions).toEqual(['session-1']);
    expect(summary.runtime.currentTrustScore).toBe(85);
    expect(summary.runtime.workspaceState.frozen).toBe(true);
  });

  it('populates analytics truth section with trajectory, daily stats, trends', () => {
    const summary = RuntimeSummaryService.getSummary({
      trajectory: { totalTasks: 35, successRate: 0.03 },
      dailyStats: { toolCalls: 120, painSignals: 15 }
    });

    expect(summary.analytics.trajectoryData.totalTasks).toBe(35);
    expect(summary.analytics.dailyStats.toolCalls).toBe(120);
  });

  it('calculates Phase 3 readiness from runtime truth only', () => {
    const summary = RuntimeSummaryService.getSummary({
      runtime: { queueValid: true, trustValid: true },
      analytics: { trajectoryValid: false } // ignored
    });

    expect(summary.phase3.phase3ShadowEligible).toBe(true);
    expect(summary.phase3.eligibilitySource).toBe('runtime_truth');
  });

  it('does not use analytics for Phase 3 eligibility', () => {
    const summary = RuntimeSummaryService.getSummary({
      runtime: { queueValid: false, trustValid: false }, // invalid
      analytics: { trajectoryValid: true } // valid but ignored
    });

    expect(summary.phase3.phase3ShadowEligible).toBe(false);
  });
});
```

### Task 9: Write TDD Tests for Allowed Analytics Evidence

**Description**: Create TDD tests to verify that the analytics evidence allow-list correctly filters what can be used as Phase 3 supporting evidence.

**Delegation Recommendation**:
- Category: `deep` - Requires understanding of evidence filtering logic
- Skills: [`superpowers/test-driven-development`, `tdd`] - TDD approach

**Skills Evaluation**:
- INCLUDED `superpowers/test-driven-development`: Test-first development
- INCLUDED `tdd`: Core TDD methodology
- OMITTED `brainstorming`: Not creative

**Depends On**: None (can run in parallel with Task 3)

**Acceptance Criteria**:
1. Test suite created in allowed-analytics-evidence.test.ts (or similar)
2. Test cases cover:
   - `trajectory.successRate` → allowed
   - `trajectory.timeoutRate` → allowed
   - `trajectory.trustChanges` → not allowed (excluded)
   - `dailyStats.toolCallVolume` → allowed
   - `dailyStats.painSignals` → not allowed (excluded)
   - `trends.sevenDayTrend` → allowed
   - Unknown analytics → not allowed
3. All tests FAIL initially (RED phase)
4. Tests follow existing patterns

**Expected Test Cases**:
```typescript
describe('Allowed Analytics Evidence for Phase 3', () => {
  it('allows trajectory.successRate as supporting evidence', () => {
    expect(isAnalyticsAllowedForPhase3('trajectory', 'successRate')).toBe(true);
    expect(ALLOWED_ANALYTICS_EVIDENCE['trajectory.successRate'].purpose)
      .toBe('supporting evidence for capability strength');
  });

  it('allows trajectory.timeoutRate as risk indicator', () => {
    expect(isAnalyticsAllowedForPhase3('trajectory', 'timeoutRate')).toBe(true);
    expect(ALLOWED_ANALYTICS_EVIDENCE['trajectory.timeoutRate'].weight).toBe('high');
  });

  it('excludes trajectory.trustChanges (old semantics)', () => {
    expect(isAnalyticsAllowedForPhase3('trajectory', 'trustChanges')).toBe(false);
    expect(ALLOWED_ANALYTICS_EVIDENCE['trajectory.trustChanges'].reason)
      .toContain('old success-inflation semantics');
  });

  it('excludes dailyStats.painSignals (noisy)', () => {
    expect(isAnalyticsAllowedForPhase3('dailyStats', 'painSignals')).toBe(false);
    expect(ALLOWED_ANALYTICS_EVIDENCE['dailyStats.painSignals'].reason)
      .toContain('not reliable capability evidence');
  });

  it('rejects unknown analytics sources', () => {
    expect(isAnalyticsAllowedForPhase3('unknown', 'field')).toBe(false);
  });
});
```

## Commit Strategy

Atomic commits following RED→GREEN→REFACTOR TDD cycle:

1. **Commit 1**: `feat(3a-03): define RuntimeTruth and AnalyticsTruth type interfaces`
   - Task 1: Create type definitions

2. **Commit 2**: `docs(3a-03): label trajectory and analytics sources as non-runtime truth`
   - Task 2: Add labels and comments

3. **Commit 3**: `test(3a-03): add failing tests for runtime/analytics separation`
   - Task 8: Add TDD tests (RED state)

4. **Commit 4**: `test(3a-03): add failing tests for allowed analytics evidence`
   - Task 9: Add TDD tests (RED state)

5. **Commit 5**: `feat(3a-03): implement runtime summary service separation`
   - Task 3: Implement separation (GREEN state)

6. **Commit 6**: `feat(3a-03): update evolution-status command to show runtime vs analytics`
   - Task 4: Update CLI output (GREEN state)

7. **Commit 7**: `docs(3a-03): update control-ui-query-service to label as analytics`
   - Task 5: Add labels

8. **Commit 8**: `feat(3a-03): define allowed analytics evidence for Phase 3`
   - Task 6: Create allow-list and filtering logic (GREEN state)

9. **Commit 9**: `test(3a-03): add integration test for analytics evidence filtering`
   - Task 7: Integration test

10. **Commit 10**: `refactor(3a-03): consolidate runtime/analytics boundary documentation`
    - Review all references and ensure consistent wording

Each commit:
- Passes all tests (`npm test` in packages/openclaw-plugin)
- Follows conventional commits format
- Has single logical purpose
- Is reversible in isolation

## Success Criteria

Overall phase verification:

1. **Code Quality**:
   - [ ] All TDD tests pass: `npm test -- runtime-summary-service`
   - [ ] All CLI tests pass: `npm test -- evolution-status`
   - [ ] All analytics evidence tests pass
   - [ ] All existing tests still pass: `npm test`
   - [ ] No TypeScript errors: `npm run build`
   - [ ] Code follows existing patterns

2. **Functional Requirements (A2)**:
   - [ ] Runtime truth explicitly separated from analytics truth in types
   - [ ] Runtime summary has distinct `runtime` and `analytics` sections
   - [ ] Phase 3 eligibility calculated from runtime truth only
   - [ ] CLI output clearly labels runtime vs analytics sections
   - [ ] Control UI queries labeled as analytics (read models)
   - [ ] Explicit allow-list defines which analytics may be used as Phase 3 evidence
   - [ ] Excluded analytics (trustChanges, painSignals) are correctly blocked

3. **Operator Visibility**:
   - [ ] `/pd-status` output distinguishes runtime truth from analytics
   - [ ] Operator can see what drives control decisions (runtime) vs what provides insights (analytics)
   - [ ] No confusing mixing of runtime and analytics

4. **Test Coverage**:
   - [ ] TDD tests cover runtime/analytics separation
   - [ ] TDD tests cover analytics evidence filtering
   - [ ] Integration test verifies end-to-end filtering

## Output

After completion, create `.planning/phases/3A/3A-03-SUMMARY.md` with:
- What was implemented (A2: Runtime vs Analytics boundary)
- Test coverage statistics
- Verification of runtime/analytics separation
- Allowed analytics evidence list
- Remaining tasks (A3, A4, A5)
