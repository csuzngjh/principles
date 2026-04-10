---
phase: 18
plan: "01"
subsystem: "nocturnal-validation"
tags: ["nocturnal", "validation", "operator-tooling", "phase-18"]
dependency_graph:
  requires:
    - phase: "17"
      plan: "01"
      reason: "Requires bootstrapped rules (_stub_bootstrap suffix) from Phase 17"
  provides:
    - component: "validate-live-path script"
      capability: "End-to-end nocturnal workflow validation"
      exposed_via: "npm run validate-live-path"
  affects:
    - component: "EVOLUTION_QUEUE"
      impact: "Script appends sleep_reflection tasks with proper file locking"
    - component: "subagent_workflows.db"
      impact: "Script queries workflow store for completion status"
tech_stack:
  added: []
  patterns:
    - "Standalone TypeScript script with ESM imports"
    - "File locking with acquireLockAsync/releaseLock pattern"
    - "Raw SQLite queries via better-sqlite3 (no WorkflowStore import)"
    - "Synthetic snapshot injection for hasUsableNocturnalSnapshot guard bypass"
key_files:
  created:
    - path: "packages/openclaw-plugin/scripts/validate-live-path.ts"
      lines: 356
      purpose: "Operator validation script for live nocturnal workflow path"
    - path: "packages/openclaw-plugin/tests/scripts/validate-live-path.test.ts"
      lines: 286
      purpose: "Test suite for validate-live-path script"
  modified:
    - path: "packages/openclaw-plugin/package.json"
      changes: "Added 'validate-live-path' npm script entry"
key_decisions:
  - "Script is standalone (not a module import) to avoid WorkflowStore async initialization issues"
  - "Script implements its own acquireLockAsync/releaseLock functions instead of importing from file-lock.js"
  - "Synthetic snapshot uses _dataSource='pain_context_fallback' with recentPain array to pass hasUsableNocturnalSnapshot guard"
  - "Resolution is read from EvolutionQueueItem, not from WorkflowRow (per research finding)"
  - "Workflow correlation via taskId in metadata_json links WorkflowRow to EvolutionQueueItem"
metrics:
  duration_seconds: 124
  completed_date: "2026-04-10T07:06:20Z"
  tasks_completed: 2
  files_created: 2
  files_modified: 1
  tests_created: 15
  tests_passing: 15
---

# Phase 18 Plan 01: Live Path Validation Script Summary

**One-liner:** End-to-end nocturnal workflow validation via standalone TypeScript script with file locking, raw SQLite queries, and synthetic snapshot injection.

## Deliverables

### 1. validate-live-path.ts Script
- **Location:** `packages/openclaw-plugin/scripts/validate-live-path.ts`
- **Lines:** 356
- **Purpose:** Operator tool for validating the nocturnal workflow path with bootstrapped principles

**Key Features:**
- Reads `_tree.rules` from `principle_training_state.json` filtering for `_stub_bootstrap` suffix
- Fails fast with clear error if no bootstrapped rules found
- Creates synthetic `NocturnalSessionSnapshot` with `recentPain: [{score: 50}]` to pass `hasUsableNocturnalSnapshot()` guard
- Enqueues `sleep_reflection` task using `acquireLockAsync` with `.lock` suffix (T-18-01 mitigation)
- Releases lock in `finally` block to prevent deadlock
- Queries `subagent_workflows.db` directly via `better-sqlite3` (no WorkflowStore import)
- Polls every 5 seconds for up to 5 minutes for workflow completion
- Correlates workflow to queue item via `taskId` in `metadata_json`
- Reads `resolution` from `EvolutionQueueItem` (not from `WorkflowRow`)
- Verifies `state='completed'` and explicit resolution (not `'expired'`)
- Outputs summary and exits 0 on success, non-zero on failure
- Supports `--verbose` flag for detailed output

### 2. npm Script Entry
- **Location:** `packages/openclaw-plugin/package.json`
- **Entry:** `"validate-live-path": "tsx scripts/validate-live-path.ts"`
- **Usage:** `npm run validate-live-path [--verbose]`

### 3. Test Suite
- **Location:** `packages/openclaw-plugin/tests/scripts/validate-live-path.test.ts`
- **Tests:** 15 tests covering all script functions
- **Status:** All passing

## Implementation Highlights

### File Locking (T-18-01 Mitigation)
The script implements its own `acquireLockAsync` and `releaseLock` functions to prevent TOCTOU race conditions when writing to `EVOLUTION_QUEUE`:

```typescript
let lockCtx: LockContext | null = null;
try {
  lockCtx = await acquireLockAsync(QUEUE_PATH, {
    lockSuffix: LOCK_SUFFIX,
    maxRetries: LOCK_MAX_RETRIES,
    baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
    lockStaleMs: LOCK_STALE_MS,
  });
  // ... write to queue
} finally {
  if (lockCtx) {
    releaseLock(lockCtx);
  }
}
```

### Synthetic Snapshot Injection
To bypass the `hasUsableNocturnalSnapshot()` guard (which requires non-zero stats or `recentPain.length > 0`), the script creates a synthetic snapshot:

```typescript
const snapshot = {
  sessionId: `validation-${taskId}`,
  stats: {
    totalAssistantTurns: 0,
    totalToolCalls: 0,
    failureCount: 0,
    totalPainEvents: 1,
    totalGateBlocks: 0,
  },
  recentPain: [{
    source: 'live-validation',
    score: 50,
    severity: 'moderate',
    reason: 'Synthetic snapshot for live path validation',
    createdAt: new Date().toISOString(),
  }],
  _dataSource: 'pain_context_fallback',
};
```

### Workflow-to-Queue Correlation
The script correlates workflows to queue items via the `taskId` field in `metadata_json`:

1. Workflow `metadata_json.taskId` → links to `EvolutionQueueItem.id`
2. `EvolutionQueueItem.resultRef` → links back to `workflow_id`
3. Resolution is read from `EvolutionQueueItem.resolution` (not from `WorkflowRow`)

## Deviations from Plan

### None
Plan executed exactly as written. All tasks completed successfully with all tests passing.

## Threat Surface Scan

No new security-relevant surface introduced. The script is a read-only validation tool:
- Read access to `principle_training_state.json` (existing file)
- Write access to `EVOLUTION_QUEUE` with proper file locking (T-18-01 mitigated)
- Read access to `subagent_workflows.db` (existing database)

## Known Stubs

None. The script is a validation tool, not a stub implementation.

## Commits

1. **d983226** - `test(18-01): add failing test for validate-live-path script`
   - TDD RED phase: Created failing test suite
   - 286 lines, 15 tests

2. **593fb03** - `feat(18-01): implement validate-live-path script`
   - TDD GREEN phase: Implemented script to pass all tests
   - 356 lines, standalone TypeScript with ESM imports

3. **1182a12** - `feat(18-01): add validate-live-path npm script`
   - Added npm script entry to package.json
   - Usage: `npm run validate-live-path [--verbose]`

## Self-Check: PASSED

- [x] `packages/openclaw-plugin/scripts/validate-live-path.ts` exists (356 lines)
- [x] `packages/openclaw-plugin/tests/scripts/validate-live-path.test.ts` exists (286 lines)
- [x] `packages/openclaw-plugin/package.json` has npm script entry
- [x] All 15 tests passing
- [x] Commits d983226, 593fb03, 1182a12 exist
- [x] Script uses `acquireLockAsync`/`releaseLock` for file locking
- [x] Script uses `better-sqlite3` for raw SQLite queries
- [x] Script filters for `_stub_bootstrap` rules
- [x] Script has proper exit codes (0 for success, 1 for failure)
- [x] Script correlates workflow to queue via `taskId`
- [x] Script reads `resolution` from queue item, not from WorkflowRow
- [x] Script verifies explicit resolution (not 'expired')

## Requirements Satisfied

- **LIVE-01:** Script runs `sleep_reflection` end-to-end with bootstrapped principles
- **LIVE-02:** Script verifies via workflow store query with required evidence (state='completed', explicit resolution, non-empty sessionId, taskId linking)
- **LIVE-03:** Script is operator-friendly with `npm run validate-live-path` entry point

## Next Steps

Phase 18 complete. The validation script is ready for operator use:
1. Run `npm run bootstrap-rules` to create stub rules (if not already done)
2. Run `npm run validate-live-path --verbose` to validate the nocturnal workflow path
3. Script outputs summary and exits 0 on success, non-zero on failure

---

*Plan completed in 124 seconds*
*All tests passing: 15/15*
