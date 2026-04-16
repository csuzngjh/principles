# Architecture Research: God Class Refactoring for Nocturnal Pipeline

**Project:** Tech Debt Remediation - Splitting God Classes (evolution-worker.ts, nocturnal-trinity.ts)
**Researched:** 2026-04-15
**Confidence:** HIGH (based on code analysis of evolution-worker.ts, nocturnal-trinity.ts, nocturnal-runtime.ts)

---

## Executive Summary

The nocturnal pipeline's `evolution-worker.ts` is a textbook god class -- a single ~2000+ line file handling queue management, workflow monitoring, sleep cycle coordination, deduplication, locking, and task dispatch. The suggested split into `queue-processor.ts`, `workflow-watchdog.ts`, and `sleep-cycle.ts` is the correct boundary decomposition. These three modules map cleanly to the three distinct responsibility axes in the file: **data persistence**, **health monitoring**, and **business logic orchestration**.

The key architectural insight: the existing heartbeat cycle (in `nocturnal-runtime.ts`) calls into `evolution-worker.ts` only at specific well-defined points (`enqueueSleepReflectionTask`, `enqueueKeywordOptimizationTask`). This means the split can proceed module-by-module without touching the heartbeat cycle, as long as the exported function signatures remain identical.

---

## 1. How God Classes Like evolution-worker.ts Are Typically Split

### Current State (God Class)

`evolution-worker.ts` conflates three orthogonal concerns:

| Concern | Functions | Nature |
|---------|-----------|--------|
| Queue persistence, migration, deduplication | `loadEvolutionQueue`, `migrateToV2`, `findRecentDuplicateTask`, `purgeStaleFailedTasks`, `createEvolutionTaskId`, `acquireQueueLock` | Pure data + atomic file I/O |
| Workflow health monitoring | `runWorkflowWatchdog` (~140 lines) | Observability + cleanup |
| Sleep cycle orchestration | `enqueueSleepReflectionTask`, `enqueueKeywordOptimizationTask`, `shouldSkipForDedup` | Business logic + decision-making |
| Shared infrastructure | `readRecentPainContext`, `buildFallbackNocturnalSnapshot` | Utility |

### Recommended Module Boundaries

#### `queue-processor.ts` -- Queue State Machine

**Responsibility:** All queue CRUD, migration, deduplication, and atomic persistence. Zero business logic.

**Public API:**
```typescript
// Queue lifecycle
export function loadEvolutionQueue(queuePath: string): EvolutionQueueItem[]
export function saveEvolutionQueue(queue: EvolutionQueueItem[], queuePath: string): void  // atomic under lock

// Migration
export function migrateToV2(item: LegacyEvolutionQueueItem): EvolutionQueueItem
export function migrateQueueToV2(queue: RawQueueItem[]): EvolutionQueueItem[]
export function isLegacyQueueItem(item: RawQueueItem): boolean

// Deduplication
export function findRecentDuplicateTask(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): EvolutionQueueItem | undefined
export function hasRecentDuplicateTask(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): boolean

// Maintenance
export function purgeStaleFailedTasks(queue: EvolutionQueueItem[], logger: PluginLogger): { purged: number; remaining: number; byReason: Record<string, number> }

// Identity
export function createEvolutionTaskId(source: string, score: number, preview: string, reason: string, now: number): string

// Locking infrastructure (shared with sleep-cycle)
export async function acquireQueueLock(resourcePath: string, logger: PluginLogger | {...}, lockSuffix?: string): Promise<() => void>
export const EVOLUTION_QUEUE_LOCK_SUFFIX, LOCK_MAX_RETRIES, LOCK_RETRY_DELAY_MS, LOCK_STALE_MS

// RAII-style lock guard (new -- eliminates manual release bugs)
export async function withQueueLock<T>(queuePath: string, logger: PluginLogger, fn: () => Promise<T>): Promise<T>
```

**Internal types (not exported):**
- `RawQueueItem`, `LegacyEvolutionQueueItem`

---

#### `workflow-watchdog.ts` -- Workflow Health Monitor

**Responsibility:** Scan workflow store, detect anomalies (stale/orphaned/invalid), emit structured `WatchdogResult`. Called every heartbeat cycle for observability.

**Public API:**
```typescript
export interface WatchdogResult {
  anomalies: number;
  details: string[];
}

export async function runWorkflowWatchdog(
  wctx: WorkspaceContext,
  api: OpenClawPluginApi | null,
  logger?: PluginLogger,
): Promise<WatchdogResult>
```

**What it detects:**
- Stale active workflows (active > 2x TTL, skipping expected subagent unavailability)
- Terminal-error workflows pending cleanup
- Nocturnal result validation (fallback snapshot detection, empty fallback stats)

**Heartbeat cycle impact:** NONE. It is called purely for observability/logging. It never writes to the queue.

---

#### `sleep-cycle.ts` -- Sleep Reflection Orchestrator

**Responsibility:** Coordinate sleep reflection enqueueing, keyword optimization dispatch, cooldown checking, and pain context attachment. This is where business logic lives.

**Public API:**
```typescript
// Task enqueueing (called by heartbeat)
export async function enqueueSleepReflectionTask(wctx: WorkspaceContext, logger: PluginLogger): Promise<void>
export async function enqueueKeywordOptimizationTask(wctx: WorkspaceContext, logger: PluginLogger): Promise<void>

// Pain context (used by enqueueing logic)
export function readRecentPainContext(wctx: WorkspaceContext): RecentPainContext
export function buildPainSourceKey(painCtx: ReturnType<typeof readRecentPainContext>): string | null

// Dedup and skip logic
export function hasRecentSimilarReflection(queue: EvolutionQueueItem[], painSourceKey: string, now: number): EvolutionQueueItem | null
export function hasPendingTask(queue: EvolutionQueueItem[], taskKind: TaskKind): boolean
export function shouldSkipForDedup(queue: EvolutionQueueItem[], wctx: WorkspaceContext, logger: PluginLogger): boolean

// Internal helpers (private to module, called by public functions)
function enqueueNewSleepReflectionTask(queue: EvolutionQueueItem[], recentPainContext: ReturnType<typeof readRecentPainContext>, queuePath: string, logger: PluginLogger): void
function normalizePainDedupKey(source: string, preview: string, reason?: string): string
function buildFallbackNocturnalSnapshot(sleepTask: EvolutionQueueItem, extractor?: ReturnType<typeof createNocturnalTrajectoryExtractor>, logger?: {...}): NocturnalSessionSnapshot | null
```

**Key architectural point:** This module does NOT call `atomicWriteFileSync` directly. It calls `enqueueNewSleepReflectionTask` (which lives in `queue-processor`) under lock. Queue writes are always encapsulated in `queue-processor`.

---

### Backward-Compatible Facade (evolution-worker.ts During Transition)

During the refactoring, `evolution-worker.ts` acts as a facade that re-exports everything under the original import paths:

```typescript
// evolution-worker.ts -- TEMPORARY FACADE
// All existing callers import from here (no import path changes needed)

export { loadEvolutionQueue, saveEvolutionQueue, migrateToV2, ... } from './queue-processor.js';
export { runWorkflowWatchdog, type WatchdogResult } from './workflow-watchdog.js';
export {
  enqueueSleepReflectionTask,
  enqueueKeywordOptimizationTask,
  readRecentPainContext,
  // ... all other sleep-cycle exports
} from './sleep-cycle.js';
export type {
  EvolutionQueueItem,
  RecentPainContext,
  QueueStatus,
  TaskResolution,
  TaskKind,
  TaskPriority,
} from './sleep-cycle.js';
```

After all callers are migrated, this facade can be kept indefinitely as a stable import point, or removed if callers update their imports directly.

---

## 2. Integrating New Modules Without Breaking the Heartbeat Cycle

### Current Heartbeat Integration Points

The heartbeat (in `nocturnal-runtime.ts`) calls into `evolution-worker.ts` at three points:

| Caller | Function Called | Purpose |
|--------|----------------|---------|
| Idle detection path | `enqueueSleepReflectionTask(wctx, logger)` | Enqueue reflection when workspace idle |
| Keyword optimization dispatch | `enqueueKeywordOptimizationTask(wctx, logger)` | Enqueue keyword optimization |
| Every heartbeat cycle | `runWorkflowWatchdog(wctx, api, logger)` | Health monitoring |

### Integration Strategy: Zero-Change Facade

```
Heartbeat (nocturnal-runtime.ts)
    │
    ├── import { enqueueSleepReflectionTask } from '../service/evolution-worker.js'  ← UNCHANGED
    ├── import { enqueueKeywordOptimizationTask } from '../service/evolution-worker.js'  ← UNCHANGED
    └── import { runWorkflowWatchdog } from '../service/evolution-worker.js'  ← UNCHANGED

evolution-worker.js (facade)
    ├── re-exports from queue-processor.js
    ├── re-exports from workflow-watchdog.js
    └── re-exports from sleep-cycle.js
```

The facade pattern means the heartbeat sees zero change. The facade re-exports from the new module files. This is the critical enabler for incremental refactoring.

### Lock Sharing Between Modules

Both `queue-processor` and `sleep-cycle` need the queue lock. The lock acquisition lives in `queue-processor` (shared infrastructure):

```typescript
// queue-processor.ts
export async function withQueueLock<T>(
  queuePath: string,
  logger: PluginLogger,
  fn: () => Promise<T>
): Promise<T> {
  const release = await acquireQueueLock(queuePath, logger);
  try {
    return await fn();
  } finally {
    release();
  }
}

// sleep-cycle.ts calls it internally:
export async function enqueueSleepReflectionTask(wctx, logger) {
  const queuePath = wctx.resolve('EVOLUTION_QUEUE');
  await withQueueLock(queuePath, logger, async () => {
    const queue = loadEvolutionQueue(queuePath);
    // ... business logic
    saveEvolutionQueue(queue, queuePath);
  });
}
```

This eliminates the common bug pattern of lock leaks (forgetting to call `release()` in all code paths).

---

## 3. Data Flow Changes When Splitting a Monolithic Worker

### Before Split (Monolithic Worker)

```
Heartbeat Cycle
    │
    ▼
evolution-worker.ts
    ├── readRecentPainContext()
    ├── loadEvolutionQueue()  ──────────────────────────┐
    ├── hasPendingTask()                              │
    ├── shouldSkipForDedup() ─────────────────────────┤
    │                                                 │ Queue I/O
    ├── enqueueSleepReflectionTask() ◄────────────────┤
    │    │
    │    ├── createEvolutionTaskId()
    │    ├── atomicWriteFileSync()  ──────────────────┼── Single write
    │    └── [releases lock]
    │
    └── runWorkflowWatchdog()
         ├── WorkflowStore.listWorkflows()
         ├── WorkflowStore.getEvents()
         └── [session cleanup via api]
```

### After Split (Modular)

```
Heartbeat Cycle
    │
    ▼
evolution-worker.ts (facade -- thin re-export)
    │
    ├──────────────────────────────────────────────────────────┐
    │                                                          │
    ▼                                                          ▼
sleep-cycle.ts                                         workflow-watchdog.ts
    │                                                          │
    ├── readRecentPainContext()                                ├── WorkflowStore.listWorkflows()
    │                                                          ├── WorkflowStore.getEvents()
    ▼                                                          └── [session cleanup via api]
queue-processor.ts
    │
    ├── acquireQueueLock() ◄──────────────┐
    ├── loadEvolutionQueue() ◄────────────┼── Queue I/O
    │                                     │
    ├── [dedup + business logic]          │
    │                                     │
    └── saveEvolutionQueue() ◄────────────┴── Single atomic write
```

### Data Flow Invariants (Must Preserve)

1. **Queue write is atomic**: `sleep-cycle` never calls `atomicWriteFileSync` directly. It calls `saveEvolutionQueue` (in `queue-processor`) which acquires the lock, writes, and releases.

2. **Watchdog is read-only**: `runWorkflowWatchdog` reads the workflow store and API. It never acquires the queue lock or writes to any shared state.

3. **Dedup is a pure function**: `findRecentDuplicateTask` takes the queue as an argument and returns a result. No side effects.

4. **Lock lifetime is encapsulated**: Using the `withQueueLock` RAII pattern, the lock is held for the minimum necessary duration.

---

## 4. Suggested Build Order for Incremental Refactoring

### Phase 1: Extract Shared Types (Lowest Risk)

**Create `nocturnal-queue-types.ts` in `src/core/`**

Extract all shared types:
```typescript
// nocturnal-queue-types.ts
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | ...;
export type TaskKind = 'pain_diagnosis' | 'sleep_reflection' | 'keyword_optimization';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface RecentPainContext {
  mostRecent: { score: number; source: string; reason: string; timestamp: string; sessionId: string } | null;
  recentPainCount: number;
  recentMaxPainScore: number;
}

export interface EvolutionQueueItem {
  id: string;
  taskKind: TaskKind;
  priority: TaskPriority;
  source: string;
  // ... all fields
}
```

**Why first:** Types have no runtime dependencies. Validation: run `tsc --noEmit` after extraction. All importing files should see identical types.

---

### Phase 2: Extract `workflow-watchdog.ts` (No Dependencies on New Modules)

**Create `src/service/workflow-watchdog.ts`**

Move `runWorkflowWatchdog` (~140 lines). Dependencies:
- `WorkspaceContext` (core)
- `OpenClawPluginApi` (SDK)
- `PluginLogger` (SDK)
- `WorkflowStore` (already in `subagent-workflow/`)
- `WORKFLOW_TTL_MS` (config)
- `isExpectedSubagentError` (subagent-workflow)

**Update:** `evolution-worker.ts` imports from `./workflow-watchdog.js` and re-exports.

**Verification:** Heartbeat calls `runWorkflowWatchdog` through the facade. Compare output before/after.

---

### Phase 3: Extract `queue-processor.ts` (No Business Logic)

**Create `src/service/queue-processor.ts`**

Move all queue operations. This is the largest extraction.

**Key new API addition:** `saveEvolutionQueue(queue, queuePath)` -- encapsulates the atomic write + lock release pattern. This becomes the ONLY way other modules write to the queue.

**Update:** `evolution-worker.ts` imports from `./queue-processor.js` and re-exports.

**Verification:**
```typescript
// Unit test: verify atomic write is called exactly once per enqueue
// Integration test: full sleep reflection enqueue flow still works
// Check: no module other than queue-processor calls atomicWriteFileSync on the queue
```

---

### Phase 4: Extract `sleep-cycle.ts` (Orchestrator)

**Create `src/service/sleep-cycle.ts`**

Move business logic orchestration. This module imports from `queue-processor` but adds no new dependencies on the queue itself.

**Update:** `evolution-worker.ts` imports from `./sleep-cycle.js` and re-exports.

**Verification:**
```typescript
// Dedup logic: verify skip behavior with test queue state
// Keyword optimization: verify throttle check still works
// Pain context: verify attachment to sleep_reflection tasks
// Full heartbeat cycle: idle detection -> sleep reflection enqueue -> queue state
```

---

### Phase 5: Thin the Facade (Optional)

Once all callers are migrated:
- Option A: Keep `evolution-worker.ts` as a permanent stable re-export facade (low cost, high compatibility)
- Option B: Update all callers to import from new modules directly, delete `evolution-worker.ts`

**Recommendation: Option A.** The facade provides a single stable import point for the heartbeat. Changing import paths in `nocturnal-runtime.ts` adds risk without benefit.

---

## 5. Nocturnal-Trinity.ts Splitting (Parallel Track)

`nocturnal-trinity.ts` (~2430 lines) has six distinct sections:

| Section | Lines (est.) | New Module | Dependencies |
|---------|-------------|------------|--------------|
| Types and interfaces | ~400 | `trinity-types.ts` | None |
| Prompt strings | ~300 | `trinity-prompts.ts` | None (static) |
| formatReasoningContext | ~50 | `nocturnal-reasoning-deriver.ts` | Already in nocturnal-reasoning-deriver.js, just move here |
| Stub implementations | ~350 | `trinity-stubs.ts` | Types, prompts |
| TrinityRuntimeAdapter interface + OpenClawTrinityRuntimeAdapter | ~400 | `trinity-runtime-adapter.ts` | Types, prompts, stubs |
| Chain execution (runTrinity, runTrinityAsync) | ~300 | `trinity-executor.ts` | All above |
| Validation + draftToArtifact | ~100 | `trinity-validator.ts` | Types |

**Why nocturnal-trinity is lower priority than evolution-worker:**
- `nocturnal-trinity.ts` is well-structured (prompt strings, types, stubs, adapter, executor are already logically separated within the file)
- The god class problem in `evolution-worker.ts` is more severe (heterogeneous concerns)
- The heartbeat does not call `nocturnal-trinity.ts` directly -- `evolution-worker.ts` calls it internally

**Split order for trinity:** Types -> Prompts -> Stubs -> Adapter -> Executor -> Validator

---

## 6. Type Safety Improvements During Refactoring

### Add Discriminated Unions for Queue Status

Current `EvolutionQueueItem` uses optional fields for status transitions. A discriminated union makes illegal states unrepresentable:

```typescript
// nocturnal-queue-types.ts

export type EvolutionQueueItem =
  | { readonly status: 'pending'; id: string; taskKind: TaskKind; priority: TaskPriority; source: string; score: number; reason: string; timestamp: string; enqueued_at?: string; trigger_text_preview?: string; traceId?: string; retryCount: number; maxRetries: number; recentPainContext?: RecentPainContext; resultRef?: string; }
  | { readonly status: 'in_progress'; id: string; started_at: string; assigned_session_key?: string; session_id?: string; agent_id?: string; /* ... common fields */ }
  | { readonly status: 'completed'; id: string; completed_at: string; resolution: TaskResolution; resultRef: string; /* ... */ }
  | { readonly status: 'failed'; id: string; lastError: string; retryCount: number; /* ... */ }
  | { readonly status: 'canceled'; id: string; /* ... */ };
```

### RAII-Style Lock Guard

Current pattern requires manual lock release in every code path:

```typescript
// CURRENT (bug-prone):
const release = await acquireQueueLock(queuePath, logger);
try {
  // ... work
} finally {
  release();  // Easy to forget, especially in early returns
}

// RECOMMENDED (RAII-style):
await withQueueLock(queuePath, logger, async () => {
  // ... work
  // lock automatically released when scope exits
});
```

---

## 7. Testing Strategy for Incremental Refactoring

| Phase | Module | What to Test |
|-------|--------|--------------|
| 1 | nocturnal-queue-types | All types round-trip correctly |
| 2 | workflow-watchdog | Stale detection, anomaly output, cleanup triggers |
| 3 | queue-processor | Migration, dedup, atomic write, lock encapsulation |
| 4 | sleep-cycle | Dedup skip, throttle enforcement, pain context attachment |
| 5 | Facade | All re-exports work, import paths unchanged |

### Snapshot Tests for Watchdog Output

`WatchdogResult` is structured. Snapshots prevent regression in anomaly detection behavior across refactoring.

### Integration Test: Full Heartbeat Cycle

After each phase, run the existing nocturnal pipeline integration test. The facade ensures the import path never changes for callers.

---

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Module boundaries | HIGH | Clear responsibility separation identified in code |
| Heartbeat integration | HIGH | Facade pattern ensures zero caller changes needed |
| Data flow | HIGH | Lock sharing model well-understood from code |
| Build order | HIGH | Phases are dependency-orderable |
| Trinity split | MEDIUM | Lower priority; more modules may increase complexity if over-split |
| Type safety improvements | MEDIUM | Recommendations, not blockers |

## Sources

- Code analysis: `packages/openclaw-plugin/src/service/evolution-worker.ts` (lines 1-800 reviewed; structure extrapolated to full file based on function signatures)
- Code analysis: `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` (full file reviewed, 2430 lines)
- Code analysis: `packages/openclaw-plugin/src/service/nocturnal-runtime.ts` (lines 1-200 reviewed, heartbeat integration points confirmed)
- Pattern: Facade for backward-compatible refactoring (standard practice, Martin Fowler)
- Pattern: Discriminated unions for state machines (TypeScript best practice)
- Pattern: RAII-style lock guards (common Node.js resource management pattern)

---

*Architecture research for: God Class Refactoring - evolution-worker.ts and nocturnal-trinity.ts*
*Researched: 2026-04-15*
