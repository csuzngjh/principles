# Phase 46: God Class Split - Research

**Researched:** 2026-04-15
**Domain:** TypeScript module extraction, file-based queue persistence, RAII-style resource guards, workflow health monitoring
**Confidence:** HIGH

## Summary

Phase 46 extracts four focused modules from `evolution-worker.ts` (2689 lines) and adds a RAII-style queue lock guard. The extraction order is enforced: queue-migration (most isolated) first, then workflow-watchdog, then queue-io (full persistence layer), then sleep-cycle (orchestrator). `evolution-worker.ts` becomes a permanent facade/re-export layer. All three bugs (BUG-01: stale workflow marking, BUG-02: gateway-safe session cleanup, BUG-03: timeout recovery verification) are fixed as part of the split. The phase depends on Phase 45 queue tests as a validation baseline.

**Primary recommendation:** Extract in the locked order (queue-migration -> workflow-watchdog -> queue-io -> sleep-cycle), make queue-io the full persistence layer with RAII guard, and fix BUG-01 inline with workflow-watchdog extraction.

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Extraction order (D-10):** queue-migration → workflow-watchdog → queue-io → sleep-cycle

**queue-io.ts scope (D-07, D-08, D-09):**
- queue-io.ts is a **full persistence layer** — encapsulates locking (`acquireQueueLock`), atomic writes (`atomicWriteFileSync`), and queue file format (`loadEvolutionQueue`/`saveEvolutionQueue`)
- `withQueueLock()` RAII-style guard is part of queue-io.ts (SPLIT-04)

**Bug fix scope (D-03 through D-06):**
- BUG-01: Watchdog marks stale workflows as `terminal_error` after 2x TTL — fix must be verified in extracted `workflow-watchdog.ts`
- BUG-02: Gateway-safe fallback for child session cleanup — verify works after queue split
- BUG-03: Timeout recovery logic (#214/#219) — verify still works after queue split

**evolution-worker.ts facade (D-15, D-16):** becomes a permanent re-export layer; all imports from it continue to work

**Sleep-cycle inclusion (D-01, D-02):** SPLIT-05 is in scope; sleep-cycle.ts is extracted from evolution-worker.ts (not from nocturnal-trinity.ts)

### Deferred Ideas (OUT OF SCOPE)

- SPLIT-07: `nocturnal-trinity.ts` split is deferred to a future milestone (internally cleaner than evolution-worker.ts, lower priority)
- sleep-cycle.ts is NOT extracted from nocturnal-trinity.ts — it lives in evolution-worker.ts where the orchestration logic is

### Claude's Discretion

No areas left to discretion — all decisions captured in CONTEXT.md locked decisions.
</user_constraints>

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SPLIT-01 | Extract `queue-migration.ts` from `evolution-worker.ts` — `migrateToV2`, `isLegacyQueueItem`, `migrateQueueToV2`, `LegacyEvolutionQueueItem`, `DEFAULT_TASK_KIND`, `DEFAULT_PRIORITY`, `DEFAULT_MAX_RETRIES` | All migration functions are self-contained, operate on pure data (no I/O, no closures), lines 297-379. No cross-cutting deps. |
| SPLIT-02 | Extract `workflow-watchdog.ts` — `runWorkflowWatchdog`, `WatchdogResult`, stale workflow detection, BUG-01 fix | Well-bounded health monitoring concern, lines 79-223. Uses `WorkflowStore`, `isExpectedSubagentError`, `WORKFLOW_TTL_MS`. |
| SPLIT-03 | Extract `queue-io.ts` — file I/O for queue persistence, encapsulate all queue writes | Replaces direct `fs.readFileSync`/`fs.writeFileSync` calls. Depends on `acquireQueueLock`, `atomicWriteFileSync`. |
| SPLIT-04 | Add `withQueueLock()` RAII-style guard in queue-io.ts | TypeScript `try/finally` pattern wrapping `acquireQueueLock`. Returns release function, always releases on exceptions. |
| SPLIT-05 | Extract `sleep-cycle.ts` — orchestrator for enqueue/keyword-optimization tasks | `runCycle` function (lines 2467-2580) orchestrates enqueueSleepReflectionTask, enqueueKeywordOptimizationTask, checkPainFlag, processEvolutionQueue. |
| SPLIT-06 | Keep `evolution-worker.ts` as permanent facade/re-export layer | All existing imports must continue to work via re-exports. No new logic added. |
| SPLIT-07 | Defer `nocturnal-trinity.ts` split to future milestone | nocturnal-trinity.ts is a leaf in the import graph (confirmed from Phase 44 inventory). Lower priority than evolution-worker.ts. |
| BUG-01 | Fix #185 — watchdog marks stale workflows as `terminal_error` after 2x TTL; add test for silent subagent failure path | Lines 107-128: `staleThreshold = WORKFLOW_TTL_MS * 2`; uses `isExpectedSubagentError(lastEventReason)` guard before marking terminal_error. |
| BUG-02 | Fix #188 — gateway-safe fallback for child session cleanup | Lines 131-161: chains `subagentRuntime.deleteSession` -> `agentSession.loadSessionStore` -> gateway-try-again pattern. |
| BUG-03 | Verify #214/#219 timeout recovery logic still works after queue split | Lines 178-202: nocturnal completed workflow result validation checks `_dataSource` and zero-stats fallback. Must verify after split. |
</phase_requirements>

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Queue migration (migrateToV2, isLegacyQueueItem) | API/Backend | — | Pure data transformation, no I/O, no external deps |
| Workflow watchdog (stale detection, session cleanup) | API/Backend | — | Reads workflow store, writes workflow state changes |
| Queue persistence (load/save with locking) | API/Backend | — | File I/O with lock acquisition, encapsulates queue file format |
| Sleep-cycle orchestration (runCycle) | API/Backend | — | Coordinates enqueue tasks, cooldown checks, queue processing |
| evolution-worker.ts facade | API/Backend | — | Re-export layer, no new logic |
| BUG-01: stale workflow marking | API/Backend | — | Workflow state mutation in workflow-watchdog.ts |
| BUG-02: gateway-safe session cleanup | API/Backend | Browser (agentSession) | Uses `agentSession.loadSessionStore` which touches browser storage |
| BUG-03: timeout recovery verification | API/Backend | — | Snapshot validation in workflow-watchdog.ts |

---

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 5.x | Language | Project's primary language |
| Vitest | 4.1.x | Test framework | Already configured in project with `pool: 'threads'` for better-sqlite3 |
| `vi.useFakeTimers()` | (Vitest built-in) | Fake timers for queue tests | Phase 45 tests already use this pattern |
| `fs` (Node.js built-in) | built-in | File I/O | Queue persistence uses synchronous reads/writes |
| `crypto` (Node.js built-in) | built-in | MD5 hashing for task IDs | Used by `createEvolutionTaskId` |

### Key Source Utilities (already in codebase)
| Utility | Location | Purpose | Why Standard |
|---------|----------|---------|--------------|
| `atomicWriteFileSync` | `src/utils/io.ts` | Atomic file write with EPERM/EBUSY retry | Proven utility, handles Windows lock errors |
| `acquireLockAsync` | `src/utils/file-lock.ts` | Async file lock acquisition | Used by queue operations to prevent TOCTOU |
| `releaseLock` | `src/utils/file-lock.ts` | Release acquired lock | Paired with acquireLockAsync |
| `asyncLockQueues` | `src/utils/file-lock.ts` | In-process async lock queue | Used for concurrent queue access |
| `LockContext` | `src/utils/file-lock.ts` | Lock acquisition context | Returned by acquireLockAsync |

**Installation:** No new npm packages needed — all required utilities (`atomicWriteFileSync`, `acquireLockAsync`) already exist in the codebase.

---

## Architecture Patterns

### System Architecture Diagram

```
[Heartbeat Timer]
        │
        ▼
[runCycle] (sleep-cycle.ts)
        │
        ├──► [checkWorkspaceIdle] ──► cooldown check
        │                                  │
        │                            [enqueueSleepReflectionTask] ──► [queue-io.ts: withQueueLock] ──► [queue file]
        │                            [enqueueKeywordOptimizationTask] ──► [queue-io.ts: withQueueLock] ──► [queue file]
        │
        ├──► [checkPainFlag] ──► [doEnqueuePainTask] ──► [queue-io.ts: withQueueLock] ──► [queue file]
        │
        ├──► [processEvolutionQueue] ──► [queue-io.ts: withQueueLock] ──► [queue file]
        │
        └──► [runWorkflowWatchdog] (workflow-watchdog.ts)
                    │
                    ├──► [WorkflowStore.listWorkflows] ──► stale detection (2x TTL)
                    │         │
                    │         └──► [WorkflowStore.updateWorkflowState] ──► terminal_error
                    │
                    └──► [subagentRuntime.deleteSession] ──► gateway-try-again ──► [agentSession.loadSessionStore]
```

### Recommended Project Structure

```
src/service/
├── evolution-worker.ts   # [SPLIT-06] Permanent facade: re-exports all extracted symbols
├── queue-migration.ts     # [SPLIT-01] migrateToV2, isLegacyQueueItem, migrateQueueToV2
├── workflow-watchdog.ts   # [SPLIT-02] runWorkflowWatchdog, WatchdogResult, BUG-01/02 fixes
├── queue-io.ts            # [SPLIT-03, SPLIT-04] loadEvolutionQueue, saveEvolutionQueue, withQueueLock RAII
├── sleep-cycle.ts        # [SPLIT-05] runCycle orchestrator
└── (other existing files)

src/utils/
├── io.ts                  # unchanged — atomicWriteFileSync still here
└── file-lock.ts           # unchanged — acquireLockAsync, releaseLock still here
```

### Pattern 1: RAII-style Queue Lock Guard

**What:** `withQueueLock(path, fn)` acquires a queue lock, executes `fn`, and always releases the lock — even on exceptions.

**When to use:** All queue read-modify-write operations. Replaces open-coded `try { ... releaseLock() } finally { ... }` scattered through evolution-worker.ts.

**Source:** Pattern identified in `enqueueSleepReflectionTask` (line 778), `enqueueKeywordOptimizationTask` (line 812), `doEnqueuePainTask` (line 878) — these all follow the same try/finally pattern that should be centralized.

**Implementation sketch (SPLIT-04):**

```typescript
// queue-io.ts
export async function withQueueLock<T>(
  resourcePath: string,
  logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
  scope: string,
  fn: () => Promise<T>
): Promise<T> {
  const releaseLock = await acquireQueueLock(resourcePath, logger, EVOLUTION_QUEUE_LOCK_SUFFIX);
  try {
    return await fn();
  } finally {
    releaseLock();
  }
}

// Synchronous variant for lock-and-write operations
export function withQueueLockSync<T>(
  resourcePath: string,
  logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
  scope: string,
  fn: () => T
): T {
  const releaseLock = /* sync version using acquireLock */;
  try {
    return fn();
  } finally {
    releaseLock();
  }
}
```

### Pattern 2: Facade/Re-export Layer

**What:** Original file becomes a stable import surface — all symbols re-exported from new module locations.

**When to use:** When existing code imports from the god class and you need zero-downtime migration.

**Source:** Locked decision D-15 (evolution-worker.ts becomes facade). Pattern is already used by Phase 44 inventory showing evolution-logger.ts and event-log.ts each maintain their own singleton registries.

**Implementation:**

```typescript
// evolution-worker.ts — after all extractions complete
// This file becomes a facade: re-exports everything from extracted modules
// NO new logic here — only re-exports

// Re-export queue-migration
export { migrateToV2, isLegacyQueueItem, migrateQueueToV2, LegacyEvolutionQueueItem } from './queue-migration.js';

// Re-export queue-io
export { loadEvolutionQueue, saveEvolutionQueue, withQueueLock, withQueueLockSync } from './queue-io.js';

// Re-export workflow-watchdog
export { runWorkflowWatchdog } from './workflow-watchdog.js';

// Re-export sleep-cycle
export { runCycle } from './sleep-cycle.js';

// Re-export types and utilities that live in evolution-worker.ts itself
export { validateQueueEventPayload, createEvolutionTaskId, extractEvolutionTaskId } from './queue-migration.js';
export { purgeStaleFailedTasks, hasRecentDuplicateTask, hasEquivalentPromotedRule, readRecentPainContext } from './queue-migration.js';
```

### Anti-Patterns to Avoid

- **Importing extracted functions back into the god class for internal use:** Once `queue-io.ts` is extracted, `evolution-worker.ts` should only import from it via re-exports — not call its own extracted functions internally.
- **Creating new lock patterns:** Don't add `acquireQueueLock` calls outside of queue-io.ts after SPLIT-03 — all locking goes through the persistence layer.
- **Bypassing `withQueueLock` for queue writes:** Any queue write that doesn't go through `withQueueLock` risks lock-leak bugs (the problem SPLIT-04 solves).
- **Adding new logic to the facade:** `evolution-worker.ts` after SPLIT-06 is stable. New features go into extracted modules or new files.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file writes | Custom rename-on-write | `atomicWriteFileSync` from `src/utils/io.ts` | Already handles Windows EPERM/EBUSY retry; proven in production |
| Queue lock acquisition | Custom file locking | `acquireLockAsync` from `src/utils/file-lock.ts` | PID-based stale lock detection, exponential backoff |
| Queue persistence | Direct `fs.readFileSync`/`fs.writeFileSync` | `loadEvolutionQueue`/`saveEvolutionQueue` in queue-io.ts | Encapsulates format, migration, and locking |
| In-process async queue concurrency | Custom Promise queue | `asyncLockQueues` Map + `withAsyncLock` from `file-lock.ts` | Prevents concurrent writes to same queue file |

---

## Common Pitfalls

### Pitfall 1: Re-entrant lock acquisition during queue operations
**What goes wrong:** If `loadEvolutionQueue` is called while a lock is already held (e.g., inside `withQueueLock`), the second `acquireLockAsync` may timeout or deadlock.
**Why it happens:** `acquireQueueLock` uses file-based locking that is not re-entrant. All queue operations assume they hold the lock.
**How to avoid:** After extraction, audit all call paths — `loadEvolutionQueue` should only be called inside `withQueueLock`. Consider making the internal `loadEvolutionQueueRaw` private and always wrapping.
**Warning signs:** Lock acquisition timeouts in tests (`LOCK_MAX_RETRIES exceeded`).

### Pitfall 2: Circular dependency from facade re-exports
**What goes wrong:** `evolution-worker.ts` re-exports from `queue-io.ts`, which imports from `file-lock.ts`, which may transitively import from `evolution-worker.ts`.
**Why it happens:** `file-lock.ts` is used by many modules; `evolution-worker.ts` has many imports. Extraction must ensure extracted modules don't reintroduce the god-class import.
**How to avoid:** `queue-migration.ts` has zero imports from `evolution-worker.ts` — extract it first. `workflow-watchdog.ts` imports from `WorkflowStore`, `isExpectedSubagentError`, `WORKFLOW_TTL_MS` — verify none come from `evolution-worker.ts`. `queue-io.ts` uses only `file-lock.ts` and `io.ts`. `sleep-cycle.ts` imports from `nocturnal-runtime.js`, `nocturnal-config.js`, `evolution-worker.ts` types — must be verified.
**Warning signs:** `Circular dependency` TypeScript errors after extraction.

### Pitfall 3: Breaking existing test imports
**What goes wrong:** Tests in `evolution-worker.queue.test.ts`, `queue-purge.test.ts`, `async-lock.test.ts` import from `evolution-worker.ts`. After extraction, those imports break.
**Why it happens:** Phase 45 tests import `loadEvolutionQueue`, `purgeStaleFailedTasks`, `hasRecentDuplicateTask` from `../../src/service/evolution-worker.js`.
**How to avoid:** Keep re-exports in `evolution-worker.ts` (SPLIT-06) so test imports continue to resolve. Update tests only after facade is verified.
**Warning signs:** `Cannot find module` errors in test runs after extraction.

### Pitfall 4: Missing BUG-01 fix in extracted watchdog
**What goes wrong:** BUG-01 fix (marking stale workflows as `terminal_error` with `isExpectedSubagentError` guard) is embedded in the `runWorkflowWatchdog` function. If extraction cuts mid-function or renames incorrectly, the fix is lost.
**Why it happens:** The stale detection logic (lines 107-128) includes `isExpectedSubagentError` check before `store.updateWorkflowState`. This specific ordering must be preserved.
**How to avoid:** Extract `runWorkflowWatchdog` as an atomic unit (lines 92-223). The `isExpectedSubagentError` guard is on line 122 — it must be included.
**Warning signs:** Stale workflows not marked `terminal_error` in tests after extraction.

### Pitfall 5: BUG-02 gateway fallback broken by session store path change
**What goes wrong:** The gateway fallback for session cleanup (`agentSession.loadSessionStore`) depends on `agentSession.resolveStorePath()`. If this API is not available in the extraction context, the fallback silently fails.
**Why it happens:** Lines 136-144 use `agentSession.resolveStorePath()` and `agentSession.loadSessionStore()`. These are only available when `api?.runtime?.agent?.session` is non-null.
**How to avoid:** After extracting `runWorkflowWatchdog`, verify the `api` parameter type includes `runtime.agent.session`. The extraction must preserve the full `api: OpenClawPluginApi | null` signature.
**Warning signs:** Session cleanup silently skipped in tests where `api` is mocked without `agent.session`.

---

## Code Examples

### Queue Migration (SPLIT-01) — Already Pure Functions

```typescript
// Source: evolution-worker.ts lines 337-379
export function migrateToV2(item: LegacyEvolutionQueueItem): EvolutionQueueItem {
    return {
        id: item.id,
        taskKind: (item.taskKind as TaskKind) || DEFAULT_TASK_KIND,
        priority: (item.priority as TaskPriority) || DEFAULT_PRIORITY,
        source: item.source,
        traceId: item.traceId,
        task: item.task,
        score: item.score,
        reason: item.reason,
        timestamp: item.timestamp,
        enqueued_at: item.enqueued_at,
        started_at: item.started_at,
        completed_at: item.completed_at,
        assigned_session_key: item.assigned_session_key,
        trigger_text_preview: item.trigger_text_preview,
        status: (item.status as QueueStatus) || 'pending',
        resolution: item.resolution as TaskResolution | undefined,
        session_id: item.session_id,
        agent_id: item.agent_id,
        retryCount: item.retryCount || 0,
        maxRetries: item.maxRetries || DEFAULT_MAX_RETRIES,
        lastError: item.lastError,
        resultRef: item.resultRef,
    };
}

export function isLegacyQueueItem(item: RawQueueItem): boolean {
    return item && typeof item === 'object' && !('taskKind' in item);
}

export function migrateQueueToV2(queue: RawQueueItem[]): EvolutionQueueItem[] {
    return queue.map(item => isLegacyQueueItem(item) ? migrateToV2(item as unknown as LegacyEvolutionQueueItem) : item as unknown as EvolutionQueueItem);
}
```

### Workflow Watchdog BUG-01/02 Core Logic (SPLIT-02)

```typescript
// Source: evolution-worker.ts lines 107-161
// Check 1: Stale active workflows (active > 2x TTL)
const staleThreshold = WORKFLOW_TTL_MS * 2;
const staleActive = allWorkflows.filter(
  (wf: WorkflowRow) => wf.state === 'active' && (now - wf.created_at) > staleThreshold,
);
for (const wf of staleActive) {
  const events = store.getEvents(wf.workflow_id);
  const lastEventReason = events.length > 0 ? events[events.length - 1].reason : 'unknown';

  // BUG-01: Skip marking if expected subagent error (daemon mode)
  if (isExpectedSubagentError(lastEventReason)) {
    logger?.debug?.(`[PD:Watchdog] Skipping stale active workflow ${wf.workflow_id}: expected subagent error`);
    continue;
  }

  store.updateWorkflowState(wf.workflow_id, 'terminal_error');
  store.recordEvent(wf.workflow_id, 'watchdog_timeout', 'active', 'terminal_error', ...);

  // BUG-02: Gateway-safe fallback for child session cleanup
  if (wf.child_session_key) {
    try {
      if (subagentRuntime) {
        await subagentRuntime.deleteSession({ sessionKey: wf.child_session_key, deleteTranscript: true });
      } else if (agentSession) {
        const storePath = agentSession.resolveStorePath();
        const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
        const normalizedKey = wf.child_session_key.toLowerCase();
        if (sessionStore[normalizedKey]) {
          delete sessionStore[normalizedKey];
          await agentSession.saveSessionStore(storePath, sessionStore);
        }
      }
    } catch (cleanupErr) {
      const errMsg = String(cleanupErr);
      // Gateway fallback: if gateway request failed, try agentSession directly
      if (errMsg.includes('gateway request') && agentSession) {
        const storePath = agentSession.resolveStorePath();
        const sessionStore = agentSession.loadSessionStore(storePath, { skipCache: true });
        const normalizedKey = wf.child_session_key.toLowerCase();
        if (sessionStore[normalizedKey]) {
          delete sessionStore[normalizedKey];
          await agentSession.saveSessionStore(storePath, sessionStore);
        }
      }
    }
  }
}
```

### BUG-03: Timeout Recovery Snapshot Validation

```typescript
// Source: evolution-worker.ts lines 178-202
// Check 3: Nocturnal workflow result validation (#181 pattern)
const nocturnalCompleted = allWorkflows.filter(
  (wf: WorkflowRow) => wf.workflow_type === 'nocturnal' && wf.state === 'completed',
);
for (const wf of nocturnalCompleted) {
  try {
    const meta = JSON.parse(wf.metadata_json) as Record<string, unknown>;
    const snapshot = meta.snapshot as Record<string, unknown> | undefined;
    if (snapshot) {
      // #219: Check for fallback data source
      const dataSource = snapshot._dataSource as string | undefined;
      if (dataSource === 'pain_context_fallback') {
        details.push(`fallback_snapshot: nocturnal workflow ${wf.workflow_id} uses pain-context fallback`);
      }
      // #246: Detect empty fallback stats
      const stats = snapshot.stats as Record<string, number> | undefined;
      if (stats && dataSource === 'pain_context_fallback' &&
          stats.totalToolCalls === 0 && stats.totalGateBlocks === 0 &&
          stats.failureCount === 0) {
        details.push(`fallback_snapshot_stats: nocturnal workflow ${wf.workflow_id} has empty fallback stats`);
      }
    }
  } catch { /* ignore malformed metadata */ }
}
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Monolithic `evolution-worker.ts` (2689L) | Extracted modules: queue-migration, workflow-watchdog, queue-io, sleep-cycle | Phase 46 | Enables independent unit testing; reduces merge conflicts |
| Direct `fs.readFileSync`/`fs.writeFileSync` for queue | `loadEvolutionQueue`/`saveEvolutionQueue` in queue-io.ts with RAII guard | Phase 46 | Encapsulates format + migration + locking in one place |
| Lock-in-every-call-site pattern | `withQueueLock()` RAII guard in queue-io.ts | Phase 46 | Prevents lock-leak bugs on exceptions |

**Deprecated/outdated:**
- None identified in this phase's scope.

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `queue-migration.ts` has zero imports from `evolution-worker.ts` (pure data functions) | SPLIT-01 | If false, circular dependency risk during extraction |
| A2 | `workflow-watchdog.ts` imports (`WorkflowStore`, `isExpectedSubagentError`, `WORKFLOW_TTL_MS`) don't transitively depend on `evolution-worker.ts` | SPLIT-02 | If false, circular dependency; must use type re-exports |
| A3 | `sleep-cycle.ts` can be extracted without pulling in the full `evolution-worker.ts` import graph | SPLIT-05 | If false, may need to defer SPLIT-05 or restructure |
| A4 | `LockUnavailableError` from `config/index.js` is available to queue-io.ts without circular imports | queue-io.ts | If false, may need to define or import error type differently |

**All assumptions should be verified by the planner before creating extraction task plans.**

---

## Open Questions

1. **Does `sleep-cycle.ts` extraction require pulling in the full `nocturnal-runtime.js` and `nocturnal-config.js` import chain?**
   - What we know: `runCycle` (lines 2467-2580) calls `checkWorkspaceIdle`, `checkCooldown`, `recordCooldown` from `nocturnal-runtime.js`, `loadNocturnalConfigMerged` from `nocturnal-config.js`.
   - What's unclear: Whether `nocturnal-runtime.js` transitively imports from `evolution-worker.ts`.
   - Recommendation: Grep `nocturnal-runtime.ts` for `from.*evolution-worker` and `from.*evolution-types` before extraction.

2. **Should `saveEvolutionQueue` be extracted to queue-io.ts even though it doesn't exist as a named function in evolution-worker.ts?**
   - What we know: Queue saves happen inline via `atomicWriteFileSync(queuePath, JSON.stringify(queue, null, 2))`. No named `saveEvolutionQueue` function exists.
   - What's unclear: Whether to create a `saveEvolutionQueue(queuePath, queue)` function in queue-io.ts as part of SPLIT-03.
   - Recommendation: Yes — creating it centralizes the persistence contract and makes `withQueueLock` + save atomic.

3. **Does `evolution-worker.ts` still need to export `WorkerStatusReport` and `BackgroundService` types after becoming a facade?**
   - What we know: `WorkerStatusReport` is the return type of `runCycle`. It's used internally and as a public API type.
   - What's unclear: Whether downstream code imports `WorkerStatusReport` from `evolution-worker.ts` specifically.
   - Recommendation: Keep re-exporting from facade if external imports exist; otherwise move to a shared `evolution-types.ts`.

---

## Environment Availability

> Step 2.6: SKIPPED — no external dependencies beyond project codebase. All required tools (TypeScript, Vitest, Node.js built-in `fs`/`crypto`) are already available in the project workspace.

---

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.x |
| Config file | `vitest.config.ts` (existing in packages/openclaw-plugin) |
| Quick run command | `cd packages/openclaw-plugin && npx vitest run --reporter=verbose` |
| Full suite command | `cd packages/openclaw-plugin && npx vitest run --reporter=verbose --pool=threads` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| SPLIT-01 | `migrateToV2` correctly migrates legacy items; `isLegacyQueueItem` detects legacy items | Unit | `vitest run tests/service/evolution-worker.queue.test.ts -t "migrateToV2\|isLegacyQueueItem"` | Yes (Phase 45) |
| SPLIT-02 | `runWorkflowWatchdog` marks stale workflows as `terminal_error` after 2x TTL | Unit | `vitest run tests/service/evolution-worker.* -t "watchdog\|Watchdog"` | Partial (nocturnal.test.ts) |
| SPLIT-03 | `loadEvolutionQueue` reads and migrates queue from file | Unit | `vitest run tests/service/evolution-worker.queue.test.ts -t "loadEvolutionQueue"` | Yes (Phase 45) |
| SPLIT-04 | `withQueueLock` always releases lock on exceptions | Unit | `vitest run tests/queue/async-lock.test.ts -t "withQueueLock"` | Partial (async-lock.test.ts covers similar) |
| SPLIT-05 | `runCycle` orchestrates enqueue tasks and processes queue | Integration | `vitest run tests/service/evolution-worker.* -t "runCycle\|sleep"` | No — needs new test |
| SPLIT-06 | All existing imports from `evolution-worker.ts` continue to resolve | Import/compile | `tsc --noEmit` (TypeScript check) | N/A |
| BUG-01 | Watchdog skips `terminal_error` marking for expected subagent errors | Unit | `vitest run tests/service/evolution-worker.* -t "expected.*subagent\|isExpectedSubagent"` | Partial |
| BUG-02 | Gateway fallback cleans up child sessions via `agentSession` when `subagentRuntime` unavailable | Unit | `vitest run tests/service/evolution-worker.* -t "gateway.*fallback\|child_session"` | No |
| BUG-03 | Nocturnal workflow snapshot validation detects `pain_context_fallback` with zero stats | Unit | `vitest run tests/service/evolution-worker.timeout.test.ts` | Yes (timeout.test.ts) |

### Sampling Rate
- **Per task commit:** `vitest run --reporter=verbose` (full suite, < 60s)
- **Per wave merge:** Full suite with `--pool=threads`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/service/queue-migration.test.ts` — SPLIT-01 unit tests (migrateToV2, isLegacyQueueItem, migrateQueueToV2)
- [ ] `tests/service/workflow-watchdog.test.ts` — SPLIT-02 + BUG-01 + BUG-02 unit tests (stale detection, session cleanup)
- [ ] `tests/service/queue-io.test.ts` — SPLIT-03 + SPLIT-04 unit tests (load/save with lock, RAII guard)
- [ ] `tests/service/sleep-cycle.test.ts` — SPLIT-05 integration test (runCycle orchestrator)
- [ ] `tests/service/evolution-worker.*` — Update imports to use new module paths (after each extraction)
- [ ] Framework install: None needed — Vitest 4.1.x already in project

---

## Sources

### Primary (HIGH confidence)
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — lines 1-100 (imports), 79-223 (workflow watchdog), 297-379 (queue migration), 491-515 (acquireQueueLock), 721-731 (loadEvolutionQueue), 763-800 (enqueueSleepReflectionTask), 807-854 (enqueueKeywordOptimizationTask), 2467-2722 (runCycle, BackgroundService)
- `packages/openclaw-plugin/src/utils/io.ts` — `atomicWriteFileSync` (lines 15-53)
- `packages/openclaw-plugin/src/utils/file-lock.ts` — `acquireLockAsync`, `releaseLock`, `asyncLockQueues`, `LockContext` (lines 257-362)
- `packages/openclaw-plugin/src/core/evolution-types.ts` — `EvolutionQueueItem`, `LegacyEvolutionQueueItem`, `QueueStatus`, `TaskResolution` (lines 260-324)
- Phase 44 Mutable State Inventory — confirms no module-level mutable state in evolution-worker.ts

### Secondary (MEDIUM confidence)
- Phase 45 queue tests — `evolution-worker.queue.test.ts`, `queue-purge.test.ts`, `async-lock.test.ts` validate queue behavior baseline
- ROADMAP.md Phase 46 success criteria (lines 114-129)

### Tertiary (LOW confidence)
- None

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all utilities already in codebase, no new packages needed
- Architecture: HIGH — extraction order enforced by locked decisions, RAII pattern well-understood
- Pitfalls: MEDIUM — circular dependency risks need planner verification before task planning

**Research date:** 2026-04-15
**Valid until:** 2026-05-15 (30 days — stable TypeScript refactoring domain)
