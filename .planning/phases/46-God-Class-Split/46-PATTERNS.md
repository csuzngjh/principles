# Phase 46: God Class Split - Pattern Map

**Mapped:** 2026-04-15
**Files analyzed:** 5 (4 new modules + 1 modified facade)
**Analogs found:** 5 / 5

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/service/queue-migration.ts` | utility | transform | `src/core/evolution-migration.ts` | role-match |
| `src/service/workflow-watchdog.ts` | service | request-response | `src/core/rule-host.ts` | role-match |
| `src/service/queue-io.ts` | service | file-I/O | `src/utils/file-lock.ts` + `src/utils/io.ts` | partial-match |
| `src/service/sleep-cycle.ts` | service | request-response | `src/service/cooldown-strategy.ts` | role-match |
| `src/service/evolution-worker.ts` | facade | re-export | (no analog — this IS the facade pattern source) | N/A |

---

## Pattern Assignments

### `src/service/queue-migration.ts` (utility, transform)

**Role:** Pure data transformation — migrates legacy queue items to V2 format. No I/O, no external dependencies.

**Closest Analog:** `src/core/evolution-migration.ts`

**Imports pattern** (evolution-migration.ts lines 1-5):
```typescript
import * as fs from 'fs';
import * as path from 'path';
import type { EvolutionLoopEvent } from './evolution-types.js';
import { stableContentHash } from './evolution-reducer.js';
import { SystemLogger } from './system-logger.js';
```

**Core pattern — pure data migration function** (from RESEARCH.md lines 281-316):
```typescript
// Source: evolution-worker.ts lines 337-379
export function migrateToV2(item: LegacyEvolutionQueueItem): EvolutionQueueItem {
    return {
        id: item.id,
        taskKind: (item.taskKind as TaskKind) || DEFAULT_TASK_KIND,
        priority: (item.priority as TaskPriority) || DEFAULT_PRIORITY,
        // ... all fields mapped with defaults
        retryCount: item.retryCount || 0,
        maxRetries: item.maxRetries || DEFAULT_MAX_RETRIES,
    };
}

export function isLegacyQueueItem(item: RawQueueItem): boolean {
    return item && typeof item === 'object' && !('taskKind' in item);
}

export function migrateQueueToV2(queue: RawQueueItem[]): EvolutionQueueItem[] {
    return queue.map(item => isLegacyQueueItem(item) ? migrateToV2(item as unknown as LegacyEvolutionQueueItem) : item as unknown as EvolutionQueueItem);
}
```

**Key implementation notes:**
- `migrateToV2` uses type casting with defaults — `item.taskKind as TaskKind || DEFAULT_TASK_KIND`
- `isLegacyQueueItem` checks for absence of `taskKind` field (the v1->v2 discriminator)
- `migrateQueueToV2` is a simple map over the array — pure function, easily testable
- Zero imports from `evolution-worker.ts` — can be extracted first (D-11)
- Exported constants: `DEFAULT_TASK_KIND`, `DEFAULT_PRIORITY`, `DEFAULT_MAX_RETRIES`

---

### `src/service/workflow-watchdog.ts` (service, request-response)

**Role:** Workflow health monitoring — detects stale/orphaned workflows, validates nocturnal snapshots, handles BUG-01/02/03 fixes.

**Closest Analog:** `src/core/rule-host.ts`

**Imports pattern** (rule-host.ts lines 23-36):
```typescript
import * as fs from 'fs';
import { listImplementationsByLifecycleState } from './principle-tree-ledger.js';
import { loadEntrySource } from './code-implementation-storage.js';
import { createRuleHostHelpers } from './rule-host-helpers.js';
import { loadRuleImplementationModule } from './rule-implementation-runtime.js';
import type { RuleHostInput, RuleHostResult, RuleHostMeta, LoadedImplementation } from './rule-host-types.js';
```

**Core watchdog pattern** (evolution-worker.ts lines 92-161):
```typescript
// Source: evolution-worker.ts lines 92-161
async function runWorkflowWatchdog(
  wctx: WorkspaceContext,
  api: OpenClawPluginApi | null,
  logger?: PluginLogger,
): Promise<WatchdogResult> {
  const details: string[] = [];
  const now = Date.now();
  const subagentRuntime = api?.runtime?.subagent;
  const agentSession = api?.runtime?.agent?.session;

  const store = new WorkflowStore({ workspaceDir: wctx.workspaceDir });
  const allWorkflows: WorkflowRow[] = store.listWorkflows();

  // Check 1: Stale active workflows (BUG-01 — stale > 2x TTL)
  const staleThreshold = WORKFLOW_TTL_MS * 2;
  const staleActive = allWorkflows.filter(
    (wf: WorkflowRow) => wf.state === 'active' && (now - wf.created_at) > staleThreshold,
  );
  for (const wf of staleActive) {
    const events = store.getEvents(wf.workflow_id);
    const lastEventReason = events.length > 0 ? events[events.length - 1].reason : 'unknown';

    // BUG-01 fix: Skip marking if expected subagent error (daemon mode)
    if (isExpectedSubagentError(lastEventReason)) {
      logger?.debug?.(`[PD:Watchdog] Skipping stale active workflow ${wf.workflow_id}: expected subagent error (${lastEventReason})`);
      continue;
    }

    store.updateWorkflowState(wf.workflow_id, 'terminal_error');
    store.recordEvent(wf.workflow_id, 'watchdog_timeout', 'active', 'terminal_error', `Stale active > ${staleThreshold / 60000}s`, { ageMs: now - wf.created_at });

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
        // Gateway fallback: if gateway request failed, try agentSession directly
        const errMsg = String(cleanupErr);
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

  return { anomalies: staleActive.length, details };
}
```

**BUG-03 pattern — snapshot validation** (evolution-worker.ts lines 178-202):
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
      const dataSource = snapshot._dataSource as string | undefined;
      if (dataSource === 'pain_context_fallback') {
        details.push(`fallback_snapshot: nocturnal workflow ${wf.workflow_id} uses pain-context fallback`);
      }
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

**Return type pattern** (evolution-worker.ts lines 87-90):
```typescript
interface WatchdogResult {
  anomalies: number;
  details: string[];
}
```

**Key dependencies for workflow-watchdog.ts:**
- `WorkflowStore` from `./subagent-workflow/workflow-store.js`
- `isExpectedSubagentError` from `./subagent-workflow/subagent-error-utils.js`
- `WORKFLOW_TTL_MS` from `../config/defaults/runtime.js`
- `OpenClawPluginApi` from `../openclaw-sdk.js`
- `WorkspaceContext` from `../core/workspace-context.js`

---

### `src/service/queue-io.ts` (service, file-I/O)

**Role:** Full persistence layer — encapsulates queue file locking, atomic writes, and queue format. Combines RAII-style lock guard with queue load/save.

**Closest Analogs:** `src/utils/file-lock.ts` (locking pattern) + `src/utils/io.ts` (atomic write pattern)

**RAII lock guard pattern** (from RESEARCH.md lines 159-188, derived from evolution-worker.ts lines 778-800):
```typescript
// Pattern to copy — from enqueueSleepReflectionTask (evolution-worker.ts lines 778-800)
// Current scattered pattern that should be centralized:
const releaseLock = await requireQueueLock(queuePath, logger, 'enqueueSleepReflection', EVOLUTION_QUEUE_LOCK_SUFFIX);
try {
    const queue = loadEvolutionQueue(queuePath);
    // ... work
} finally {
    releaseLock();
}

// New centralized RAII guard (SPLIT-04):
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
```

**loadEvolutionQueue pattern** (evolution-worker.ts lines 721-731):
```typescript
// Source: evolution-worker.ts lines 721-731
export function loadEvolutionQueue(queuePath: string): EvolutionQueueItem[] {
    let rawQueue: RawQueueItem[] = [];
    try {
        rawQueue = JSON.parse(fs.readFileSync(queuePath, 'utf8'));
    } catch {
        // Queue doesn't exist yet - create empty array
        rawQueue = [];
    }
    return migrateQueueToV2(rawQueue);
}
```

**saveEvolutionQueue pattern** (derived from evolution-worker.ts lines 763):
```typescript
// Pattern: atomicWriteFileSync for queue persistence
// Source: evolution-worker.ts line 763
atomicWriteFileSync(queuePath, JSON.stringify(queue, null, 2));

// New saveEvolutionQueue function:
export function saveEvolutionQueue(queuePath: string, queue: EvolutionQueueItem[]): void {
    atomicWriteFileSync(queuePath, JSON.stringify(queue, null, 2));
}
```

**acquireQueueLock pattern** (evolution-worker.ts lines 491-505):
```typescript
// Source: evolution-worker.ts lines 491-505
export async function acquireQueueLock(
  resourcePath: string,
  logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
  lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX,
): Promise<() => void> {
  try {
    const ctx: LockContext = await acquireLockAsync(resourcePath, {
      lockSuffix,
      maxRetries: LOCK_MAX_RETRIES,
      baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
      lockStaleMs: LOCK_STALE_MS,
    });
    return () => releaseImportedLock(ctx);
  } catch (error: unknown) {
    const warn = logger?.warn;
    warn?.(`[PD:EvolutionWorker] Failed to acquire lock for ${resourcePath}: ${String(error)}`);
    throw error;
  }
}
```

**Key imports for queue-io.ts:**
- `acquireLockAsync`, `releaseLock`, `LockContext` from `../utils/file-lock.js`
- `atomicWriteFileSync` from `../utils/io.js`
- `LockUnavailableError` from `../config/index.js`
- `migrateQueueToV2` from `./queue-migration.js`
- `EvolutionQueueItem`, `RawQueueItem` from `../core/evolution-types.js`

**Lock constants** (evolution-worker.ts lines 489):
```typescript
const EVOLUTION_QUEUE_LOCK_SUFFIX = '.lock';
const LOCK_MAX_RETRIES = 50;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_STALE_MS = 10000;
```

---

### `src/service/sleep-cycle.ts` (service, request-response)

**Role:** Orchestrator for enqueue/keyword-optimization tasks. Coordinates idle checks, cooldowns, pain flag checks, and queue processing.

**Closest Analog:** `src/service/cooldown-strategy.ts`

**Imports pattern** (cooldown-strategy.ts lines 15-18):
```typescript
import { readState as readStateAsync, readStateSync, writeState } from './nocturnal-runtime.js';
import type { CooldownEscalationConfig } from './nocturnal-config.js';
import { loadCooldownEscalationConfig } from './nocturnal-config.js';
import type { ClassifiableTaskKind } from './failure-classifier.js';
```

**Core orchestration pattern** (evolution-worker.ts lines 2467-2580 — `runCycle` function):
```typescript
// Source: evolution-worker.ts lines 2467-2553
async function runCycle(): Promise<void> {
    const cycleStart = Date.now();

    // Load config on each cycle (supports runtime updates)
    const mergedConfig = loadNocturnalConfigMerged(wctx.stateDir);
    const { sleepReflection: sleepConfig, keywordOptimization: kwOptConfig } = mergedConfig;

    // Idle check
    const idleResult = checkWorkspaceIdle(wctx.workspaceDir, {});
    let shouldTrySleepReflection = false;

    // Path 1: Idle-based trigger
    if (idleResult.isIdle && sleepConfig.trigger_mode === 'idle') {
        shouldTrySleepReflection = true;
    }

    // keyword_optimization: Independent periodic trigger
    if (kwOptConfig.enabled && heartbeatCounter > 0 && heartbeatCounter % kwOptConfig.period_heartbeats === 0) {
        enqueueKeywordOptimizationTask(wctx, logger).catch((err) => {
            logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue keyword_optimization task: ${String(err)}`);
        });
    }

    // Path 2: Periodic trigger for sleep_reflection
    if (sleepConfig.trigger_mode === 'periodic') {
        if (heartbeatCounter >= sleepConfig.period_heartbeats) {
            shouldTrySleepReflection = true;
            heartbeatCounter = 0;
        }
    }

    if (shouldTrySleepReflection) {
        const cooldown = checkCooldown(wctx.stateDir, undefined, {
            globalCooldownMs: sleepConfig.cooldown_ms,
            maxRunsPerWindow: sleepConfig.max_runs_per_day,
            quotaWindowMs: 24 * 60 * 60 * 1000,
        });
        if (!cooldown.globalCooldownActive && !cooldown.quotaExhausted) {
            enqueueSleepReflectionTask(wctx, logger).catch((err) => {
                logger?.error?.(`[PD:EvolutionWorker] Failed to enqueue sleep_reflection task: ${String(err)}`);
            });
        }
    }

    // Pain flag check
    const painCheckResult = await checkPainFlag(wctx, logger);

    // Queue processing
    const queueResult = await processEvolutionQueueWithResult(wctx, logger, eventLog, api ?? undefined);

    return {
        timestamp: new Date().toISOString(),
        cycle_start_ms: cycleStart,
        duration_ms: Date.now() - cycleStart,
        pain_flag: painCheckResult,
        queue: queueResult.queue,
        errors: [],
    };
}
```

**Key imports for sleep-cycle.ts:**
- `checkWorkspaceIdle`, `checkCooldown`, `recordCooldown` from `./nocturnal-runtime.js`
- `loadNocturnalConfigMerged` from `./nocturnal-config.js`
- `WorkspaceContext` from `../core/workspace-context.js`
- `enqueueSleepReflectionTask`, `enqueueKeywordOptimizationTask` — from queue-io.ts
- `processEvolutionQueueWithResult`, `checkPainFlag` — remaining in evolution-worker.ts facade

**Return type pattern** (WorkerStatusReport, evolution-worker.ts lines 2477-2491):
```typescript
interface WorkerStatusReport {
  timestamp: string;
  cycle_start_ms: number;
  duration_ms: number;
  pain_flag: { exists: boolean; score: number | null; source: string | null; enqueued: boolean; skipped_reason: string | null };
  queue: { total: number; pending: number; in_progress: number; completed_this_cycle: number; failed_this_cycle: number };
  errors: string[];
}
```

---

### `src/service/evolution-worker.ts` (facade, re-export)

**Role:** Permanent facade/re-export layer. All existing imports continue to work. No new logic added.

**Pattern: Facade re-export** (from RESEARCH.md lines 200-220):
```typescript
// Source: RESEARCH.md lines 200-220
// evolution-worker.ts — after all extractions complete
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

**Facade invariant:** `evolution-worker.ts` must NOT call its own re-exported functions internally. All internal calls go through the extracted modules directly.

---

## Shared Patterns

### Locking Pattern (applies to queue-io.ts)
**Source:** `src/utils/file-lock.ts` (lines 77-108)
**Apply to:** `withQueueLock` and `withQueueLockSync` in `queue-io.ts`

```typescript
// Source: file-lock.ts lines 77-108 — atomic lock acquisition with O_EXCL|O_CREAT
function tryAcquireLock(lockPath: string, pid: number): boolean {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  const fd = fs.openSync(lockPath, flags);
  fs.writeSync(fd, String(pid));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  return true;
}

// Source: evolution-worker.ts lines 491-505 — acquireQueueLock wrapper
export async function acquireQueueLock(
  resourcePath: string,
  logger: PluginLogger | { warn?: (message: string) => void; info?: (message: string) => void } | undefined,
  lockSuffix: string = EVOLUTION_QUEUE_LOCK_SUFFIX,
): Promise<() => void> {
  const ctx: LockContext = await acquireLockAsync(resourcePath, {
    lockSuffix,
    maxRetries: LOCK_MAX_RETRIES,
    baseRetryDelayMs: LOCK_RETRY_DELAY_MS,
    lockStaleMs: LOCK_STALE_MS,
  });
  return () => releaseImportedLock(ctx);
}
```

### Atomic Write Pattern (applies to queue-io.ts saveEvolutionQueue)
**Source:** `src/utils/io.ts` (lines 15-53)
**Apply to:** `saveEvolutionQueue` in `queue-io.ts`

```typescript
// Source: io.ts lines 15-53
export function atomicWriteFileSync(filePath: string, data: string): void {
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, data, 'utf8');

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < RENAME_MAX_RETRIES; attempt++) {
        try {
            fs.renameSync(tmpPath, filePath);
            return;
        } catch (err) {
            lastError = err as Error;
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
                if (attempt < RENAME_MAX_RETRIES - 1) {
                    const delay = RENAME_BASE_DELAY_MS * Math.pow(2, attempt);
                    // Bounded spin-wait with CPU yield
                    const waitUntil = Date.now() + delay;
                    while (Date.now() < waitUntil) {
                        // yield
                    }
                }
                continue;
            }
            break;
        }
    }
    try { fs.unlinkSync(tmpPath); } catch { /* best effort */ }
    throw lastError;
}
```

### Migration Pattern (applies to queue-migration.ts)
**Source:** `src/core/evolution-migration.ts` (lines 35-77)
**Apply to:** `migrateToV2`, `isLegacyQueueItem`, `migrateQueueToV2` in `queue-migration.ts`

```typescript
// Source: evolution-migration.ts lines 35-77
export function migrateLegacyEvolutionData(workspaceDir: string): MigrationResult {
  const streamPath = path.join(workspaceDir, 'memory', 'evolution.jsonl');
  fs.mkdirSync(path.dirname(streamPath), { recursive: true });

  // Load existing hashes to avoid re-importing
  const existingHashes = loadImportedHashes(streamPath, workspaceDir);
  let importedEvents = 0;

  for (const sourceFile of candidates) {
    if (!fs.existsSync(sourceFile)) continue;

    const content = fs.readFileSync(sourceFile, 'utf8').trim();
    if (!content) continue;

    const contentHash = stableContentHash(`${sourceFile}:${content}`);
    if (existingHashes.has(contentHash)) continue;

    // Append event
    importedEvents += 1;
  }

  return { importedEvents, streamPath };
}
```

### Error Handling in Watchdog (applies to workflow-watchdog.ts)
**Source:** `evolution-worker.ts` lines 146-150
**Apply to:** BUG-02 gateway fallback in `runWorkflowWatchdog`

```typescript
// Gateway fallback: if gateway request failed, try agentSession directly
catch (cleanupErr) {
  const errMsg = String(cleanupErr);
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
```

---

## No Analog Found

Files with no close match in the codebase (planner should use RESEARCH.md patterns instead):

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `queue-io.ts` | service | file-I/O | Partial match only — combines file-lock.ts + io.ts but no single file has both the RAII guard and the queue persistence contract |
| `sleep-cycle.ts` | service | request-response | cooldown-strategy.ts is closest but runCycle orchestration is unique to this phase |

---

## Metadata

**Analog search scope:**
- `packages/openclaw-plugin/src/service/` — all service files
- `packages/openclaw-plugin/src/core/` — migration, rule-host, evolution-types
- `packages/openclaw-plugin/src/utils/` — file-lock.ts, io.ts
- `packages/openclaw-plugin/tests/service/` — test patterns

**Files scanned:** 21 service files, 4 core files, 2 utils files, 16 test files

**Pattern extraction date:** 2026-04-15

**Key assumptions (verify before planning):**
- A1: `queue-migration.ts` has zero imports from `evolution-worker.ts` — confirmed (pure data functions)
- A2: `workflow-watchdog.ts` imports (`WorkflowStore`, `isExpectedSubagentError`, `WORKFLOW_TTL_MS`) don't transitively depend on `evolution-worker.ts` — must verify before planning
- A3: `sleep-cycle.ts` can be extracted without pulling in the full `nocturnal-runtime.js` import chain — must grep `nocturnal-runtime.ts` for `from.*evolution-worker` before planning
- A4: `LockUnavailableError` from `config/index.js` is available to `queue-io.ts` without circular imports — must verify
