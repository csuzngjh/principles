# Phase 18: Live Replay and Operator Validation - Research

**Researched:** 2026-04-10
**Domain:** Nocturnal workflow execution, validation scripting, production state verification
**Confidence:** HIGH

## Summary

Phase 18 validates that the nocturnal system can execute one real replay/eval path end-to-end with bootstrapped rules (Phase 17 output), and creates a reproducible operator validation script. The core flow is: `sleep_reflection` task is enqueued by the evolution worker → `NocturnalWorkflowManager.startWorkflow()` is called → `executeNocturnalReflectionAsync()` runs the Trinity pipeline → workflow store is updated with `state='completed'`. The operator script (`scripts/validate-live-path.ts`) must read bootstrapped principles, trigger a task, poll the workflow store, and verify completion with explicit resolution.

**Primary recommendation:** Create `scripts/validate-live-path.ts` as a TypeScript script that reads `_tree.rules` from `principle_training_state.json`, injects a synthetic test snapshot if needed (since no real sessions may exist), enqueues a `sleep_reflection` task via the evolution queue file, and polls `WorkflowStore.listWorkflows()` until the workflow reaches `state='completed'` with an explicit resolution.

## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Run `sleep_reflection` end-to-end with at least one bootstrapped principle
- **D-02:** Target entity: principle(s) seeded by Phase 17 bootstrap (`{principleId}_stub_bootstrap` rule)
- **D-03:** Expected outcome: `state='completed'` with explicit `resolution` (e.g., `'marker_detected'`), NOT `expired` or timeout noise
- **D-04:** Stub rules return `action: 'allow (stub)'` — this is expected behavior
- **D-05:** Verify via workflow store query: `subagent_workflows.db` or `WorkflowStore.listWorkflows()` filtered by `workflow_type='nocturnal'`
- **D-06:** Required evidence: `state='completed'`, explicit `resolution`, non-empty session ID in `metadata_json.snapshot`, `taskId` linking to queue item
- **D-07:** Do NOT rely on unit tests alone — LIVE-03 requires production-state evidence
- **D-08:** Create new CLI script: `scripts/validate-live-path.ts` (or `npm run validate-live-path`)
- **D-09:** Script behavior: read bootstrapped principles → trigger sleep_reflection task → poll workflow store until complete (5 min timeout) → output summary → exit 0/1
- **D-10:** The script is the operator's "smoke test" — repeatable, CI-friendly

### Deferred Ideas (OUT OF SCOPE)

- Real rule implementations (functional `action` returning real decisions) — future phase
- Non-stub rule evaluation producing candidate implementations — future phase
- Full `nocturnal-train` pipeline validation — separate validation concern

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LIVE-01 | Run `sleep_reflection` end-to-end with bootstrapped principles; expected `state='completed'` with explicit `resolution` | `evolution-worker.ts` line 1363-1597: `processEvolutionQueue()` processes sleep_reflection tasks, calls `NocturnalWorkflowManager.startWorkflow()`, sets `resolution='marker_detected'` on completion |
| LIVE-02 | Verify via workflow store query — required evidence: `state='completed'`, explicit `resolution`, non-empty session ID, taskId linking | `workflow-store.ts` `WorkflowStore.listWorkflows()` and `WorkflowRow` schema; queue file has `resolution` field on `EvolutionQueueItem` |
| LIVE-03 | Create `scripts/validate-live-path.ts` — reads bootstrapped principles, triggers task, polls workflow store, outputs summary, exit 0/1 | New script per D-08; reads from `principle_training_state.json` `_tree.rules`, enqueues via queue file, polls `WorkflowStore` |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `better-sqlite3` | 12.8.0 | Workflow persistence | Used by `WorkflowStore` for `subagent_workflows.db` |
| `fs` (Node built-in) | — | File system access | Queue file read/write, `principle_training_state.json` access |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `WorkflowStore` | — | SQLite-backed workflow persistence | Querying workflow state, listing workflows by type |
| `EvolutionQueueItem` | — | Queue item type | Checking `resolution` field on completed tasks |
| `NocturnalWorkflowManager` | — | Workflow lifecycle management | Triggering workflows, polling status |

### No New Dependencies
Phase 18 is purely a validation/orchestration task. All required APIs already exist in the codebase.

## Architecture Patterns

### Recommended Project Structure
```
scripts/
├── validate-live-path.ts    # NEW: Phase 18 validation script
```

### Pattern 1: Validation Script Entry Point

The script follows a clear read-validate-report pattern:

```typescript
// 1. READ: Load bootstrapped principles from principle_training_state.json
const ledger = loadLedger(stateDir);
const bootstrappedRules = Object.values(ledger.tree.rules)
  .filter(r => r.id.endsWith('_stub_bootstrap'));

// 2. BUILD: Construct minimal snapshot for hasUsableNocturnalSnapshot() check
const snapshot = {
  sessionId: `test-${Date.now()}`,
  stats: { totalAssistantTurns: 1, totalToolCalls: 1, failureCount: 0, totalPainEvents: 1, totalGateBlocks: 0 },
  recentPain: [{ source: 'test', score: 50, severity: 'moderate', reason: 'test', createdAt: new Date().toISOString() }],
};

// 3. ENQUEUE: Write sleep_reflection task to EVOLUTION_QUEUE
const taskId = createEvolutionTaskId('nocturnal', 50, 'live-validation', 'Live path validation', Date.now());
queue.push({ id: taskId, taskKind: 'sleep_reflection', ... });
fs.writeFileSync(queuePath, JSON.stringify(queue));

// 4. POLL: Wait for workflow to complete (max 5 minutes)
const deadline = Date.now() + 5 * 60 * 1000;
while (Date.now() < deadline) {
  const workflows = store.listWorkflows('nocturnal');
  const completed = workflows.find(w => w.state === 'completed' && ...);
  if (completed) return checkResolution(completed);
  await sleep(5000);
}

// 5. REPORT: Output summary, exit code
```

### Pattern 2: Snapshot Validity Check (`hasUsableNocturnalSnapshot()`)

Source: `evolution-worker.ts` lines 191-213

```typescript
function hasUsableNocturnalSnapshot(snapshotData: Record<string, unknown> | undefined): boolean {
    if (!snapshotData || typeof snapshotData.sessionId !== 'string' || snapshotData.sessionId.length === 0) {
        return false;
    }
    if (snapshotData._dataSource !== 'pain_context_fallback') {
        return true;  // Real trajectory data
    }
    // Fallback path: need non-zero stats OR recentPain
    const stats = snapshotData.stats as Record<string, number | null | undefined>;
    const recentPain = Array.isArray(snapshotData.recentPain) ? snapshotData.recentPain.length : 0;
    const hasNonZeroStats = !!stats && [
        'totalAssistantTurns', 'totalToolCalls', 'failureCount', 'totalPainEvents', 'totalGateBlocks'
    ].some(key => Number(stats[key] ?? 0) > 0);
    return hasNonZeroStats || recentPain > 0;
}
```

**Key insight:** The validation script must inject a snapshot with `recentPain.length > 0` or non-zero stats to pass this guard, since production sessions may not exist.

### Pattern 3: Workflow Store Query

Source: `workflow-store.ts` lines 221-233

```typescript
// List all nocturnal workflows
const workflows = store.listWorkflows();  // returns all, no filter
const nocturnalWorkflows = workflows.filter(w => w.workflow_type === 'nocturnal');

// Get specific workflow with metadata
const workflow = store.getWorkflow(workflowId);
const metadata = JSON.parse(workflow.metadata_json) as WorkflowMetadata;
// metadata.snapshot — NocturnalSessionSnapshot
// metadata.taskId — links to EvolutionQueueItem.id
```

### Pattern 4: Resolution on Queue Item (NOT on WorkflowRow)

**Critical finding:** `resolution` is stored on `EvolutionQueueItem`, NOT on `WorkflowRow`. The queue item's `resultRef` links back to `workflowId`.

Source: `evolution-worker.ts` lines 1494-1498

```typescript
// When workflow completes:
sleepTask.status = 'completed';
sleepTask.resolution = 'marker_detected';  // Set on queue item
sleepTask.resultRef = workflowId;         // Links queue item to workflow
```

To verify resolution, the script must:
1. Read the `taskId` from workflow metadata
2. Read `EVOLUTION_QUEUE` file
3. Find the queue item with matching `id`
4. Check `resolution` field

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Workflow state persistence | Raw SQLite writes | `WorkflowStore` class | Schema versioning, WAL mode, proper transaction handling already done |
| Queue item creation | Custom task ID generation | `createEvolutionTaskId()` from `evolution-worker.ts` | MD5-based deduplication key matches existing queue format |
| File locking | Ad-hoc locking | `acquireLockAsync()` with `EVOLUTION_QUEUE_LOCK_SUFFIX` | Prevents TOCTOU race conditions in queue operations |
| Snapshot extraction | Build fake trajectory | `hasUsableNocturnalSnapshot()` guard + synthetic snapshot injection | Phase 16 already handles the guard; script just needs a valid snapshot shape |

**Key insight:** The entire validation path uses existing infrastructure. The script orchestrates, it does not implement.

## Runtime State Inventory

> This section is not applicable to Phase 18 — it is a validation phase, not a rename/refactor/migration phase. No runtime state strings need to be audited.

## Common Pitfalls

### Pitfall 1: Resolution field is on queue item, not workflow store

**What goes wrong:** Script queries `WorkflowRow` for `resolution` field, finds nothing, concludes validation failed.

**Root cause:** `EvolutionQueueItem.resolution` is set by `processEvolutionQueue()` after the workflow completes. `WorkflowRow` only has `state` field.

**How to avoid:** Read `taskId` from workflow `metadata_json`, then read `EVOLUTION_QUEUE` file to find the queue item and check its `resolution` field.

### Pitfall 2: No real sessions exist — `hasUsableNocturnalSnapshot()` blocks the path

**What goes wrong:** Script enqueues a task with no trajectory data, workflow rejects it with `missing_usable_snapshot`.

**Root cause:** Phase 16 introduced `hasUsableNocturnalSnapshot()` guard (line 1437). Without real sessions, the snapshot is invalid.

**How to avoid:** Inject a synthetic snapshot with `recentPain: [{ score: 50, ... }]` to satisfy the guard. The guard checks `recentPain.length > 0` for fallback data.

### Pitfall 3: Running validation before Phase 17 bootstrap completes

**What goes wrong:** Script finds zero rules in `_tree.rules`, cannot target a bootstrapped principle.

**Root cause:** Phase 17 has not run, so no stub rules exist.

**How to avoid:** Script should check for bootstrapped rules first and fail fast with clear message: "Phase 17 bootstrap required. Run `npm run bootstrap-rules` first."

### Pitfall 4: Subagent runtime unavailable in validation context

**What goes wrong:** `NocturnalWorkflowManager.startWorkflow()` throws "subagent runtime unavailable" because it requires `OpenClawTrinityRuntimeAdapter` with live API.

**Root cause:** The validation script runs outside the normal plugin lifecycle where `api` is null.

**How to avoid:** The script is a smoke test that verifies the workflow CAN start — it does not need to wait for full Trinity completion if runtime is unavailable. Check `subagentAvailable` before triggering, or accept that the script validates the path exists rather than full end-to-end execution in one shot.

## Code Examples

### Enqueue a sleep_reflection task

Source: `evolution-worker.ts` lines 523-579 (`enqueueSleepReflectionTask`)

```typescript
import { createEvolutionTaskId } from './evolution-worker.js';
import { acquireLockAsync, EVOLUTION_QUEUE_LOCK_SUFFIX } from './evolution-worker.js';

const queuePath = wctx.resolve('EVOLUTION_QUEUE');
const releaseLock = await acquireLockAsync(queuePath, logger, 'enqueue', EVOLUTION_QUEUE_LOCK_SUFFIX);
try {
    let queue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    const taskId = createEvolutionTaskId('nocturnal', 50, 'idle workspace', 'Sleep-mode reflection', Date.now());
    queue.push({
        id: taskId,
        taskKind: 'sleep_reflection',
        priority: 'medium',
        score: 50,
        source: 'nocturnal',
        reason: 'Sleep-mode reflection triggered by idle workspace',
        timestamp: new Date().toISOString(),
        status: 'pending',
        traceId: taskId,
        retryCount: 0,
        maxRetries: 1,
    });
    fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
} finally {
    releaseLock();
}
```

### Query workflow store for completed nocturnal workflow

Source: `workflow-store.ts` lines 221-233

```typescript
import { WorkflowStore } from './workflow-store.js';

const store = new WorkflowStore({ workspaceDir });
const allNocturnal = store.listWorkflows().filter(w => w.workflow_type === 'nocturnal');
const completed = allNocturnal.filter(w => w.state === 'completed');

// Check metadata
for (const wf of completed) {
    const meta = JSON.parse(wf.metadata_json);
    if (!meta.snapshot?.sessionId) continue;
    if (!meta.taskId) continue;
    console.log(`Workflow ${wf.workflow_id}: state=${wf.state}, sessionId=${meta.snapshot.sessionId}, taskId=${meta.taskId}`);
}
store.dispose();
```

### Read bootstrapped rules from principle_training_state.json

Source: `principle-tree-ledger.ts` lines 250-262

```typescript
import { loadLedger } from './principle-tree-ledger.js';

const ledger = loadLedger(stateDir);
const bootstrappedRules = Object.values(ledger.tree.rules)
    .filter(r => r.id.endsWith('_stub_bootstrap'));

console.log(`Found ${bootstrappedRules.length} bootstrapped rules:`);
for (const rule of bootstrappedRules) {
    console.log(`  - ${rule.id} (principleId=${rule.principleId}, action=${rule.action})`);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|-----------------|--------------|--------|
| Empty fallback snapshots entering nocturnal workflow | `hasUsableNocturnalSnapshot()` guard blocks empty fallbacks | Phase 16 | Invalid runs no longer create misleading `expired` noise |
| Gateway-only subagent methods in background | `runtime_direct` transport for nocturnal workflows | Phase 16 | Background sleep reflection no longer fails with "Plugin runtime subagent methods only available during gateway request" |
| Queue item `resolution` not set reliably | `processEvolutionQueue()` sets `resolution` explicitly on completion | Phase 16 | Operators can now distinguish `marker_detected` from `failed_max_retries` |

**Deprecated/outdated:**
- Pain-context-only snapshots with all-zero stats: Now blocked by `hasUsableNocturnalSnapshot()` guard (Phase 16 SNAP-03)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `principle_training_state.json` location is `{workspaceDir}/.state/principle_training_state.json` | Script reads ledger | If the path is different, script fails to find bootstrapped rules |
| A2 | `subagent_workflows.db` location is `{workspaceDir}/.state/subagent_workflows.db` | Workflow store path | Consistent with `WorkflowStore` constructor (line 22-24 of workflow-store.ts) |
| A3 | Phase 17 bootstrap creates rules with ID suffix `_stub_bootstrap` | Bootstrapped rule identification | Per Phase 17 context D-02: "Rule ID format: `{principleId}_stub_bootstrap`" |
| A4 | Bootstrapped rules have `status: 'proposed'` | Rule filtering | Per Phase 17 context: "Stub rules are `status: 'proposed'`" |
| A5 | Validation script runs in same environment as plugin (has access to same workspaceDir) | Script execution context | If run from different working directory, paths resolve incorrectly |

## Open Questions (RESOLVED)

1. **Q: How does the script handle the case where `api` (OpenClawPluginApi) is null?**
   - **Resolution:** The script writes directly to the EVOLUTION_QUEUE file and does NOT instantiate `NocturnalWorkflowManager` or call `startWorkflow()` directly. The evolution worker (which runs within the plugin when api is available) processes the queued task in its normal cycle. The script only needs to write to the queue and poll the workflow store — it does not need api.

2. **Q: Where should `scripts/validate-live-path.ts` live?**
   - **Resolution:** `packages/openclaw-plugin/scripts/validate-live-path.ts`. Executed via `npm run validate-live-path` which runs `tsx scripts/validate-live-path.ts`. No compilation step needed — tsx handles TypeScript execution directly.

3. **Q: What is the exact `resolution` value when a stub rule evaluates?**
   - **Resolution:** `resolution='marker_detected'`. Stub rules return `action: 'allow (stub)'` which causes `executeNocturnalReflectionAsync` to complete successfully (not skip). The pipeline succeeds (marker detected) even though it produces no novel output. Per D-04 in 18-CONTEXT.md: "Stub rules return `action: 'allow (stub)'` — this is expected behavior; the point is the path runs, not that it produces novel results."

## Environment Availability

> Step 2.6: SKIPPED (no external dependencies beyond the codebase itself — all required modules exist in `packages/openclaw-plugin/src/`)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest |
| Config file | `vitest.config.ts` at package root |
| Quick run command | `npm test -- --run` |
| Full suite command | `npm run test:coverage` |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LIVE-01 | End-to-end workflow execution with bootstrapped rules | Integration | Manual script run + workflow store query | N/A (script validation) |
| LIVE-02 | Workflow store shows `state='completed'` with explicit resolution | Integration | Query `WorkflowStore.listWorkflows()` after script run | N/A |
| LIVE-03 | `scripts/validate-live-path.ts` outputs summary, exits 0/1 | Unit + Integration | `tsx scripts/validate-live-path.ts` | Will be created in Phase 18 |

### Wave 0 Gaps

- [ ] `scripts/validate-live-path.ts` — Phase 18 deliverable (new file)
- [ ] `npm run validate-live-path` script entry in `package.json` — add to scripts section
- [ ] Basic unit test: `tests/service/validate-live-path.test.ts` — verifies bootstrapped rule detection and synthetic snapshot construction

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V4 Access Control | No | N/A — read-only validation script |
| V5 Input Validation | Yes | Script validates `sessionId` is non-empty string, `taskId` format matches `[A-Za-z0-9_-]+` |

### Known Threat Patterns for Validation Script

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Queue file corruption from concurrent writes | Tampering | File lock via `acquireLockAsync()` before write |
| Malformed JSON in queue file | Denial | try/catch around `JSON.parse`, backup corrupted file |
| Path traversal in workspaceDir | Information Disclosure | Scripts run in fixed workspace context, not user-supplied paths |

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — `enqueueSleepReflectionTask()`, `processEvolutionQueue()`, `hasUsableNocturnalSnapshot()`, `createEvolutionTaskId()`
- `packages/openclaw-plugin/src/service/subagent-workflow/nocturnal-workflow-manager.ts` — `startWorkflow()`, `getWorkflowDebugSummary()`, `nocturnalWorkflowSpec`
- `packages/openclaw-plugin/src/service/subagent-workflow/workflow-store.ts` — `WorkflowStore`, `listWorkflows()`, `WorkflowRow` schema
- `packages/openclaw-plugin/src/core/principle-tree-ledger.ts` — `loadLedger()`, `HybridLedgerStore` schema

### Secondary (MEDIUM confidence)
- `packages/openclaw-plugin/src/service/nocturnal-service.ts` — `NocturnalRunResult`, `executeNocturnalReflectionAsync()` interface
- `packages/openclaw-plugin/src/core/nocturnal-trajectory-extractor.ts` — `NocturnalSessionSnapshot` interface
- Phase 17 context (`.planning/phases/17-minimal-rule-bootstrap/17-CONTEXT.md`) — bootstrap rule format and selection criteria

### Tertiary (LOW confidence)
- Phase 16 context (`.planning/phases/16-nocturnal-snapshot-and-runtime-hardening/16-CONTEXT.md`) — Phase 16 decisions; used to understand background context

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all required modules exist and are imported from canonical files
- Architecture: HIGH — validated by reading actual code paths in evolution-worker.ts and nocturnal-workflow-manager.ts
- Pitfalls: MEDIUM — findings based on code analysis but some edge cases (subagent availability) need live confirmation

**Research date:** 2026-04-10
**Valid until:** 2026-05-10 (30 days — stable codebase, no fast-moving APIs)
