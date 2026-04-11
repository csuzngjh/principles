# Phase 24: Queue Store Extraction - Research

**Researched:** 2026-04-11
**Domain:** Module extraction from monolith (evolution-worker.ts 2133 lines), queue persistence, file locking, schema validation
**Confidence:** HIGH

## Summary

Phase 24 extracts all queue persistence logic from the 2133-line `evolution-worker.ts` into a dedicated `EvolutionQueueStore` class. The extraction targets 8 function clusters (~600 lines of queue I/O, migration, locking, deduplication, and purge logic) currently scattered across the monolith. The existing codebase already has the building blocks needed: `withLockAsync` from `file-lock.ts`, `PdError` hierarchy from `config/errors.ts`, and the v1.13 contract pattern (`readPainFlagContract`, `validateNocturnalSnapshotIngress`) to follow for validation.

The extraction is mechanically straightforward -- relocate existing logic into a class with internal lock management -- but the integration surface is wide. Five call sites in `evolution-worker.ts` acquire locks independently (`processEvolutionQueue`, `enqueueSleepReflectionTask`, `doEnqueuePainTask`, `registerEvolutionTaskSession`, and the sleep reflection Phase 3 re-lock). One external consumer (`pd-reflect.ts`) imports `acquireQueueLock` and `EVOLUTION_QUEUE_LOCK_SUFFIX` directly. Two other files import types only (`RecentPainContext`). Tests import exported helpers like `hasRecentDuplicateTask`, `purgeStaleFailedTasks`, and `registerEvolutionTaskSession`.

**Primary recommendation:** Extract incrementally by cluster (types -> migration -> lock -> dedup -> queue ops -> session), keeping the build green after each move. Internalize lock management so all public store methods auto-lock. Re-export preserved API from evolution-worker.ts for backward compatibility during extraction, then migrate consumers.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** EvolutionQueueStore is a class instantiated with `new EvolutionQueueStore(workspaceDir)`. Holds workspace state, methods operate on `this.workspaceDir`. Consistent with EvolutionEngine pattern.
- **D-02:** Queue item validation is permissive -- validate required fields only (taskKind, status, priority, retryCount, maxRetries, etc.), ignore unknown fields. Forward-compatible without breaking old code.
- **D-03:** EvolutionQueueStore owns lock management internally. All public methods auto-acquire/release the file lock. Callers never manage locks. Eliminates lock-less queue access risk.
- **D-04:** Follow existing `PdError` hierarchy from `config/errors.ts`. Use specific error types (QueueCorruptionError, LockUnavailableError) rather than generic Error.
- **D-05:** Queue corruption on read: backup corrupted file, return structured error with reasons (not silent fallback to empty array).
- **D-06:** Extract incrementally -- move functions one cluster at a time, maintaining a working build after each move. Do not rewrite; relocate existing logic.

### Claude's Discretion
- Internal method names and private helper organization
- Exact file location within `service/` directory
- Test file organization and naming
- Whether to use a separate types file or inline types

### Deferred Ideas (OUT OF SCOPE)
None -- discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| DECOMP-01 | Queue persistence, V2 migration, file locking, and purge logic extracted into dedicated EvolutionQueueStore module | Section: Functions to Extract (by cluster); Architecture Patterns |
| CONTRACT-01 | Queue items validated against schema before write -- corrupt or malformed items rejected with explicit error | Section: Schema Validation; Code Examples |
| CONTRACT-02 | Queue items validated after read -- migration or corruption detected before processing | Section: Schema Validation; Code Examples |
| CONTRACT-06 | Lock management centralized in EvolutionQueueStore -- no external lock acquisition for queue operations | Section: Lock Ownership; External Consumers |
</phase_requirements>

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| TypeScript | 6.0.2 | Language | [VERIFIED: tsc --version] Project standard, strict mode enabled |
| vitest | 4.1.0 | Test framework | [VERIFIED: package.json] `"vitest": "^4.1.0"` |
| Node.js | 24.14.0 | Runtime | [VERIFIED: node --version] |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| file-lock.ts | (internal) | File locking primitives | All queue write operations |
| errors.ts | (internal) | PdError hierarchy | All error throwing |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Class-based store | Functional module with closures | Class matches EvolutionEngine pattern (D-01). Closure approach would diverge from established convention. |

**Installation:**
No new packages needed. This phase extracts and reorganizes existing code.

**Version verification:** All versions verified in-session from running environment.

## Architecture Patterns

### Recommended Project Structure
```
packages/openclaw-plugin/src/
├── service/
│   ├── evolution-worker.ts              # Slimmed: delegates to EvolutionQueueStore
│   ├── evolution-queue-store.ts         # NEW: Queue persistence + locking
│   └── evolution-queue-store-types.ts   # NEW (optional): Queue types, interfaces
└── config/
    └── errors.ts                        # ADD: QueueCorruptionError, QueueValidationError
```

### Pattern 1: Class-Based Service (matches EvolutionEngine)
**What:** Constructor takes workspaceDir, methods use `this.workspaceDir`, class-level state.
**When to use:** All service classes in this codebase follow this pattern.
**Example:**
```typescript
// Source: packages/openclaw-plugin/src/core/evolution-engine.ts (L44-57)
export class EvolutionEngine {
  private readonly workspaceDir: string;
  private readonly stateDir: string;
  private readonly storagePath: string;

  constructor(workspaceDir: string, config?: Partial<EvolutionConfig>) {
    this.workspaceDir = workspaceDir;
    this.stateDir = resolvePdPath(workspaceDir, 'STATE_DIR');
    this.storagePath = path.join(this.stateDir, 'evolution-scorecard.json');
    this.scorecard = this.loadOrCreateScorecard();
  }
}
```

### Pattern 2: Validation Contract (v1.13 pattern)
**What:** Return structured `{status, reasons, data?}` result for read validation.
**When to use:** All boundary validation in this codebase (readPainFlagContract, validateNocturnalSnapshotIngress).
**Example:**
```typescript
// Source: packages/openclaw-plugin/src/core/nocturnal-snapshot-contract.ts (L3-7)
export interface NocturnalSnapshotContractResult {
  status: 'valid' | 'invalid';
  reasons: string[];
  snapshot?: NocturnalSessionSnapshot;
}

// Permissive validation: check required fields only, ignore unknowns
// Source: CONTEXT.md D-02
export interface QueueItemValidationResult {
  status: 'valid' | 'invalid';
  reasons: string[];
  item?: EvolutionQueueItem;
}
```

### Pattern 3: Internal Lock Management
**What:** Public methods auto-acquire/release locks. Callers never see locks.
**When to use:** All EvolutionQueueStore public methods (D-03).
**Example:**
```typescript
// Store wraps all operations in withLockAsync internally
async load(): Promise<QueueLoadResult> {
  return withLockAsync(this.queuePath, async () => {
    // read, parse, migrate, validate -- all inside lock
  });
}

async save(queue: EvolutionQueueItem[]): Promise<void> {
  return withLockAsync(this.queuePath, async () => {
    // validate each item, write -- all inside lock
  });
}
```

### Pattern 4: withLock for Atomic Multi-Step (CONTEXT.md specifics)
**What:** `withLock<T>(fn: () => Promise<T>): Promise<T>` for caller-controlled atomic operations.
**When to use:** processEvolutionQueue needs load -> modify -> save in one lock scope (current behavior at L868).
**Example:**
```typescript
// For cases where the caller needs atomic multi-step
const result = await store.withLock(async () => {
  const queue = await store.loadInternal();
  // ... modify ...
  await store.saveInternal(queue);
  return result;
});
```

### Anti-Patterns to Avoid
- **Silent fallback on corruption:** Current code at L877 backs up and returns silently. D-05 requires structured error return, not silent empty array. [VERIFIED: evolution-worker.ts L873-891]
- **Lock leaking:** Current code uses manual `releaseLock()` with a `lockReleased` flag (L870). Store must use try/finally inside withLockAsync to guarantee release. [VERIFIED: evolution-worker.ts L1716-1722]
- **External lock acquisition:** `pd-reflect.ts` directly imports `acquireQueueLock`. CONTRACT-06 requires this go through the store. [VERIFIED: src/commands/pd-reflect.ts L9, L34]
- **Re-writing instead of relocating:** D-06 is explicit -- move existing logic, do not rewrite. Preserve exact behavior.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| File locking | Custom lock primitives | `withLockAsync` from `file-lock.ts` | Already handles O_EXCL, PID detection, stale cleanup, exponential backoff [VERIFIED: src/utils/file-lock.ts] |
| Error hierarchy | Generic Error subclasses | `PdError` + `LockUnavailableError` from `errors.ts` | Already has 8 error types, semantic codes [VERIFIED: src/config/errors.ts] |
| Schema validation | Zod/Joi for queue items | Hand-written type guards (v1.13 pattern) | Project uses hand-written validators throughout (readPainFlagContract, validateNocturnalSnapshotIngress). No schema library in dependencies. [VERIFIED: package.json, no zod/joi] |
| JSON parse/stringify | Custom serialization | Standard `JSON.parse`/`JSON.stringify` | Current code uses this directly. No need for change. |

**Key insight:** The entire extraction reuses existing internal infrastructure. No new dependencies needed.

## Functions to Extract (by cluster)

All line numbers from `packages/openclaw-plugin/src/service/evolution-worker.ts`:

### Cluster 1: Queue Types (L175-274)
- `QueueStatus` type export
- `TaskResolution` type export
- `RecentPainContext` interface export
- `EvolutionQueueItem` interface export
- `LegacyEvolutionQueueItem` interface (private)
- Constants: `DEFAULT_TASK_KIND`, `DEFAULT_PRIORITY`, `DEFAULT_MAX_RETRIES`

**Note:** These types are imported externally by:
- `nocturnal-service.ts` (line 34): `import type { RecentPainContext }`
- `nocturnal-workflow-manager.ts` (line 40): `import type { RecentPainContext }`
- Tests: `evolution-worker.nocturnal.test.ts`

### Cluster 2: Migration (L276-318)
- `RawQueueItem` type (private)
- `migrateToV2()` (private)
- `isLegacyQueueItem()` (private)
- `migrateQueueToV2()` (private)

### Cluster 3: Lock Helpers (L375-420)
- `EVOLUTION_QUEUE_LOCK_SUFFIX` (exported constant)
- `LOCK_MAX_RETRIES`, `LOCK_RETRY_DELAY_MS`, `LOCK_STALE_MS` (exported constants)
- `acquireQueueLock()` (exported, used by `pd-reflect.ts`)
- `requireQueueLock()` (private)

### Cluster 4: Dedup Helpers (L429-512, L488-498)
- `normalizePainDedupKey()` (private)
- `findRecentDuplicateTask()` (private)
- `hasRecentDuplicateTask()` (exported, used by tests)
- `hasEquivalentPromotedRule()` (exported, used by tests)

### Cluster 5: Queue Operations (L456-607, L615-684)
- `purgeStaleFailedTasks()` (exported, used by tests)
- `enqueueSleepReflectionTask()` (private)
- `doEnqueuePainTask()` (private)
- `readRecentPainContext()` (exported, used by tests and nocturnal)
- `createEvolutionTaskId()` (exported, used by tests)
- `extractEvolutionTaskId()` (exported, used by tests)

### Cluster 6: Queue Read in processEvolutionQueue (L861-920)
- Initial queue load, backup, migration call (L873-894)
- Stuck task recovery for sleep_reflection (L906-975)

### Cluster 7: Queue Write in processEvolutionQueue (L1441-1720)
- Task status updates (in_progress, completed, failed)
- Sleep reflection Phase 3 re-lock and write-back (L1650-1696)
- Final queue write before release (L1698-1700)

### Cluster 8: Session Registration (L1780-1819)
- `registerEvolutionTaskSession()` (exported, used by tests and subagent hooks)

## External Consumers (must remain compatible)

| Consumer | What It Imports | Location |
|----------|----------------|----------|
| `src/index.ts` | `EvolutionWorkerService` | L52 |
| `src/commands/pd-reflect.ts` | `acquireQueueLock`, `EVOLUTION_QUEUE_LOCK_SUFFIX` | L9, L34 |
| `src/service/nocturnal-service.ts` | `type RecentPainContext` | L34 |
| `src/service/subagent-workflow/nocturnal-workflow-manager.ts` | `type RecentPainContext` | L40 |
| `tests/service/evolution-worker.test.ts` | `EvolutionWorkerService`, `createEvolutionTaskId`, `extractEvolutionTaskId`, `hasRecentDuplicateTask`, `hasEquivalentPromotedRule`, `registerEvolutionTaskSession`, `purgeStaleFailedTasks` | L1-9, L399 |
| `tests/service/evolution-worker.nocturnal.test.ts` | `EvolutionWorkerService`, `readRecentPainContext` | L53 |
| `tests/hooks/subagent.test.ts` | mocks `evolution-worker.js` module | L5-11 |

**Key constraint (INTEG-01):** Tests must pass without modification to test expectations. Tests import helpers directly from `evolution-worker.js` -- re-exporting from the old location preserves this.

## Schema Validation Design

### Write Validation (CONTRACT-01)
Per D-02, validate required fields only:

```typescript
// Required fields for EvolutionQueueItem (permissive)
const REQUIRED_QUEUE_ITEM_FIELDS = [
  'id', 'taskKind', 'priority', 'source', 'score',
  'reason', 'timestamp', 'status', 'retryCount', 'maxRetries'
] as const;

function validateQueueItemForWrite(raw: unknown): QueueItemValidationResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { status: 'invalid', reasons: ['item must be a non-null object'] };
  }
  const item = raw as Record<string, unknown>;
  const reasons: string[] = [];

  for (const field of REQUIRED_QUEUE_ITEM_FIELDS) {
    if (item[field] === undefined || item[field] === null) {
      reasons.push(`missing required field: ${field}`);
    }
  }

  // Validate status is a known value
  const validStatuses = ['pending', 'in_progress', 'completed', 'failed', 'canceled'];
  if (item.status && !validStatuses.includes(item.status)) {
    reasons.push(`invalid status: ${item.status}`);
  }

  if (reasons.length > 0) return { status: 'invalid', reasons };
  return { status: 'valid', reasons: [], item: item as unknown as EvolutionQueueItem };
}
```

### Read Validation (CONTRACT-02)
After JSON parse + V2 migration, validate each item before processing:

```typescript
interface QueueLoadResult {
  status: 'ok' | 'corrupted';
  reasons: string[];
  queue: EvolutionQueueItem[];
  backupPath?: string;  // Set when file was backed up due to corruption
}
```

## Lock Ownership Design (CONTRACT-06)

### Current State: 5 independent lock acquisition points
1. `processEvolutionQueue` (L868) -- `requireQueueLock`
2. `enqueueSleepReflectionTask` (L556) -- `requireQueueLock`
3. `doEnqueuePainTask` (L630) -- `requireQueueLock`
4. `registerEvolutionTaskSession` (L1789) -- `requireQueueLock`
5. Sleep reflection Phase 3 re-lock (L1652) -- `requireQueueLock`

### Target State: All locking inside EvolutionQueueStore
Every public method wraps its work in `withLockAsync`. The `processEvolutionQueue` function uses `store.withLock()` for its atomic load-modify-save cycle.

### pd-reflect.ts Migration
Currently imports `acquireQueueLock` directly. Must be refactored to use a store method instead:
```typescript
// Before (pd-reflect.ts L34)
const releaseLock = await acquireQueueLock(queuePath, ctx.api?.logger, EVOLUTION_QUEUE_LOCK_SUFFIX);

// After
const store = new EvolutionQueueStore(workspaceDir);
const result = await store.add(taskItem); // lock handled internally
```

## Common Pitfalls

### Pitfall 1: Lock Scope Mismatch in processEvolutionQueue
**What goes wrong:** The current `processEvolutionQueue` acquires a lock, does initial processing, then releases the lock to run sleep_reflection (long-running), then re-acquires to write results (L1650). If the store's `withLock` wraps the entire cycle, the lock is held too long and blocks other queue consumers.
**Why it happens:** The two-phase lock pattern (claim -> release -> execute -> re-lock -> write) is essential for throughput.
**How to avoid:** The store must expose a `withLock<T>()` method that lets `processEvolutionQueue` maintain its current two-phase pattern. Alternatively, expose granular methods that each acquire their own lock.
**Warning signs:** Sleep reflection tasks blocking pain diagnosis enqueue; lock timeout errors in logs.

### Pitfall 2: Breaking External Import Paths
**What goes wrong:** Tests and `pd-reflect.ts` import directly from `evolution-worker.js`. Moving exports to a new file breaks these imports.
**Why it happens:** TypeScript module resolution is path-dependent; re-exports are a separate import step.
**How to avoid:** Keep re-exports in `evolution-worker.ts` during and after extraction:
```typescript
// evolution-worker.ts (after extraction)
export { EvolutionQueueStore } from './evolution-queue-store.js';
export type { EvolutionQueueItem, QueueStatus, TaskResolution, RecentPainContext } from './evolution-queue-store.js';
// Re-export for backward compatibility
export { hasRecentDuplicateTask, purgeStaleFailedTasks, registerEvolutionTaskSession, ... } from './evolution-queue-store.js';
```
**Warning signs:** TypeScript compilation errors, test import failures.

### Pitfall 3: Silent Corruption Fallback (D-05 violation)
**What goes wrong:** Current code at L877 catches parse errors, backs up the file, and silently returns (empty queue). D-05 requires structured error return.
**Why it happens:** The current function signature returns void; there was no way to signal corruption to callers.
**How to avoid:** Store's `load()` returns `QueueLoadResult` with `status: 'corrupted'` and `reasons` array. Caller decides what to do.
**Warning signs:** Corrupted queue files silently producing empty queues, lost tasks.

### Pitfall 4: Type Drift Between Store and Worker
**What goes wrong:** After extraction, `EvolutionQueueItem` is defined in the store file, but `evolution-worker.ts` still has inline references to `RawQueueItem` or other internal types.
**Why it happens:** Incomplete extraction leaves type dependencies spanning both files.
**How to avoid:** Move ALL queue-related types to the store (or a types file). Evolution-worker imports them. No shared internal types.
**Warning signs:** TypeScript errors about missing types, circular imports.

### Pitfall 5: Test Expectation Mismatch
**What goes wrong:** INTEG-01 requires existing tests pass without modification. But if function signatures change (e.g., adding validation that rejects previously accepted malformed items), tests break.
**Why it happens:** Validation is new behavior, not just relocation.
**How to avoid:** Permissive validation (D-02) means only truly malformed items are rejected. Existing test data uses well-formed items. Validate with `purgeStaleFailedTasks` test fixtures -- all have required fields.
**Warning signs:** Test failures after extraction, especially in `evolution-worker.test.ts` and `evolution-worker.nocturnal.test.ts`.

### Pitfall 6: Circular Import Between Store and Worker
**What goes wrong:** Store needs types from trajectory-types, worker needs types from store, store needs WorkspaceContext, etc.
**Why it happens:** Heavy interdependency in the current monolith.
**How to avoid:** Store should NOT import from `evolution-worker.ts`. Store imports from `utils/file-lock.ts`, `config/errors.ts`, `core/paths.ts` only. Worker imports from store.
**Warning signs:** TypeScript circular dependency warnings, runtime `undefined` imports.

## Code Examples

### Error Types to Add
```typescript
// Source: follows PdError pattern from config/errors.ts
export class QueueCorruptionError extends PdError {
  constructor(
    public readonly queuePath: string,
    public readonly backupPath: string | undefined,
    reasons: string[],
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Queue] Queue corrupted at ${queuePath}. ${reasons.join('; ')}`,
      'QUEUE_CORRUPTION',
      options
    );
    this.name = 'QueueCorruptionError';
  }
}

export class QueueValidationError extends PdError {
  constructor(
    public readonly itemId: string,
    reasons: string[],
    options?: { cause?: unknown }
  ) {
    super(
      `[PD:Queue] Validation failed for item ${itemId}: ${reasons.join('; ')}`,
      'QUEUE_VALIDATION',
      options
    );
    this.name = 'QueueValidationError';
  }
}
```

### Store Public API (sketch)
```typescript
export class EvolutionQueueStore {
  private readonly workspaceDir: string;
  private readonly queuePath: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
    this.queuePath = resolvePdPath(workspaceDir, 'EVOLUTION_QUEUE');
  }

  // Read queue with validation and migration
  async load(): Promise<QueueLoadResult>;

  // Save entire queue (validates each item)
  async save(queue: EvolutionQueueItem[]): Promise<void>;

  // Add a single item (validates, loads, appends, saves)
  async add(item: EvolutionQueueItem): Promise<void>;

  // Update items by ID
  async update(updates: Map<string, Partial<EvolutionQueueItem>>): Promise<void>;

  // Purge stale failed tasks
  purge(queue: EvolutionQueueItem[], logger: PluginLogger): { purged: number; remaining: number; byReason: Record<string, number> };

  // Find recent duplicate task
  findRecentDuplicate(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): EvolutionQueueItem | undefined;

  // Register task session
  async registerSession(taskId: string, sessionKey: string, logger?: { warn?: (m: string) => void; info?: (m: string) => void }): Promise<boolean>;

  // Atomic multi-step (for processEvolutionQueue)
  async withLock<T>(fn: (store: QueueStoreInternal) => Promise<T>): Promise<T>;

  // Static helpers (preserve exported function signatures)
  static createTaskId(source: string, score: number, preview: string, reason: string, now: number): string;
  static extractTaskId(task: string): string | null;
  static hasRecentDuplicate(queue: EvolutionQueueItem[], source: string, preview: string, now: number, reason?: string): boolean;
}
```

### Write Validation Integration
```typescript
// Inside store.add() or store.save()
async save(queue: EvolutionQueueItem[]): Promise<void> {
  return withLockAsync(this.queuePath, async () => {
    // CONTRACT-01: Validate each item before write
    for (const item of queue) {
      const result = validateQueueItemForWrite(item);
      if (result.status === 'invalid') {
        throw new QueueValidationError(
          (item as any).id ?? 'unknown',
          result.reasons
        );
      }
    }
    fs.writeFileSync(this.queuePath, JSON.stringify(queue, null, 2), 'utf8');
  });
}
```

### Read Validation Integration
```typescript
// Inside store.load()
async load(): Promise<QueueLoadResult> {
  return withLockAsync(this.queuePath, async () => {
    if (!fs.existsSync(this.queuePath)) {
      return { status: 'ok', reasons: [], queue: [] };
    }

    let raw: RawQueueItem[];
    try {
      raw = JSON.parse(fs.readFileSync(this.queuePath, 'utf8'));
    } catch (e) {
      // D-05: Backup and return structured error
      const backupPath = `${this.queuePath}.corrupted.${Date.now()}`;
      try { fs.renameSync(this.queuePath, backupPath); } catch { /* ignore */ }
      return {
        status: 'corrupted',
        reasons: [`Parse error: ${String(e)}`],
        queue: [],
        backupPath,
      };
    }

    // V2 migration
    const queue = migrateQueueToV2(raw);

    // CONTRACT-02: Validate each item after read
    const reasons: string[] = [];
    const validItems = queue.filter(item => {
      const result = validateQueueItemForRead(item);
      if (result.status === 'invalid') {
        reasons.push(`Item ${(item as any).id ?? 'unknown'}: ${result.reasons.join(', ')}`);
        return false;
      }
      return true;
    });

    return {
      status: reasons.length > 0 ? 'corrupted' : 'ok',
      reasons,
      queue: validItems,
    };
  });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Inline queue I/O in 2133-line monolith | Extracted store module | Phase 24 (this phase) | Testability, contract enforcement |
| Silent fallback on corruption | Structured error with backup | D-05 (this phase) | No silent data loss |
| External lock management | Internal lock management | D-03 (this phase) | No lock-less access risk |
| No write validation | Write-time schema validation | CONTRACT-01 (this phase) | Catch corruption at source |
| No read validation | Read-time schema validation | CONTRACT-02 (this phase) | Catch migration/corruption before processing |

**Deprecated/outdated:**
- `acquireQueueLock` export from evolution-worker.ts: Will be superseded by store methods. Must keep for backward compat during transition, eventually deprecated.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `resolvePdPath(workspaceDir, 'EVOLUTION_QUEUE')` is the standard way to get queue path [ASSUMED] -- verified at L862 but not confirmed for all call sites | Architecture | Store resolves queue path differently per call site |
| A2 | No other files besides those listed import queue-related exports from evolution-worker.ts [ASSUMED] -- grep was comprehensive but may miss dynamic imports | External Consumers | Hidden consumers break on extraction |
| A3 | The `purgeStaleFailedTasks` function can remain a static method since it operates on a queue array, not on the file directly [ASSUMED] -- it mutates the array in place which suggests it should work with the store's load/save cycle | Schema Validation | Test signature changes |

## Open Questions

1. **Queue path resolution in registerEvolutionTaskSession**
   - What we know: Uses `workspaceResolve('EVOLUTION_QUEUE')` (a function parameter) rather than `wctx.resolve('EVOLUTION_QUEUE')` (L1786). This is a different pattern from other functions.
   - What's unclear: Whether the store should accept a path resolver function or always derive the path from workspaceDir.
   - Recommendation: Have `registerSession` accept `workspaceDir` as parameter (matching the class constructor pattern), or make the session registration a method on the store that uses `this.queuePath`.

2. **Two-phase lock in processEvolutionQueue**
   - What we know: The function acquires a lock, processes pain_diagnosis tasks, then releases the lock for sleep_reflection execution, then re-acquires for write-back (L1444, L1650).
   - What's unclear: Whether the store's `withLock()` method should expose a way to release mid-operation, or if the entire flow should use separate store calls.
   - Recommendation: Keep the two-phase pattern. `processEvolutionQueue` calls `store.withLock()` for phase 1 (claim), does work outside lock, then calls `store.update()` (which re-locks) for phase 3 (write-back). This matches current behavior.

## Environment Availability

Step 2.6: SKIPPED (no external dependencies identified -- this phase is pure code restructuring using existing project infrastructure)

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.0 |
| Config file | `packages/openclaw-plugin/vitest.config.ts` |
| Quick run command | `npx vitest run tests/service/evolution-worker.test.ts -t "test name"` |
| Full suite command | `npx vitest run` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| DECOMP-01 | Queue I/O extracted to store, worker delegates | integration | `npx vitest run tests/service/evolution-worker.test.ts` | Yes (existing) |
| CONTRACT-01 | Invalid items rejected on write | unit | `npx vitest run tests/service/evolution-queue-store.test.ts` | Wave 0 (new file) |
| CONTRACT-02 | Invalid items flagged on read | unit | `npx vitest run tests/service/evolution-queue-store.test.ts` | Wave 0 (new file) |
| CONTRACT-06 | No external lock calls for queue data | unit | `npx vitest run tests/service/evolution-queue-store.test.ts` | Wave 0 (new file) |
| INTEG-01 | Existing tests pass unmodified | regression | `npx vitest run` | Yes (existing) |

### Sampling Rate
- **Per task commit:** `npx vitest run tests/service/evolution-queue-store.test.ts`
- **Per wave merge:** `npx vitest run`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `tests/service/evolution-queue-store.test.ts` -- covers CONTRACT-01, CONTRACT-02, CONTRACT-06
- [ ] Tests for `QueueCorruptionError` and `QueueValidationError` in error hierarchy

*(Existing test infrastructure covers regression testing via `evolution-worker.test.ts` and `evolution-worker.nocturnal.test.ts`)*

## Security Domain

> This phase is a code extraction/refactoring with no new external interfaces, authentication, or cryptography. Security-relevant considerations:

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | N/A -- no auth changes |
| V3 Session Management | no | N/A -- no session changes |
| V4 Access Control | no | N/A -- no access control changes |
| V5 Input Validation | yes | Permissive validation per D-02 (required fields only) |
| V6 Cryptography | no | N/A -- no crypto changes |

### Known Threat Patterns for Queue Store Extraction

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Queue file tampering | Tampering | File lock prevents concurrent write (existing); validation catches corruption |
| Queue item injection | Tampering | Write validation (CONTRACT-01) rejects malformed items |
| Lock starvation | Denial of Service | Existing exponential backoff with jitter (file-lock.ts L174-182) |

## Sources

### Primary (HIGH confidence)
- Codebase analysis: `packages/openclaw-plugin/src/service/evolution-worker.ts` (2133 lines, all queue-related functions verified at documented line numbers)
- Codebase analysis: `packages/openclaw-plugin/src/utils/file-lock.ts` (lock primitives, withLockAsync signature)
- Codebase analysis: `packages/openclaw-plugin/src/config/errors.ts` (PdError hierarchy, 8 error types)
- Codebase analysis: `packages/openclaw-plugin/src/core/evolution-engine.ts` (class pattern reference)
- Codebase analysis: `packages/openclaw-plugin/src/core/nocturnal-snapshot-contract.ts` (validation contract pattern)
- Codebase analysis: `packages/openclaw-plugin/src/core/pain.ts` (factory + validator pattern)

### Secondary (MEDIUM confidence)
- Test patterns from `tests/service/evolution-worker.test.ts` (462 lines, test structure and expectations)
- Import analysis via grep: all external consumers of evolution-worker exports identified

### Tertiary (LOW confidence)
- None -- all findings verified against source code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - no new dependencies, verified in-session
- Architecture: HIGH - matches existing patterns (EvolutionEngine, v1.13 contracts), all integration points verified by code reading
- Pitfalls: HIGH - identified from direct code analysis of current lock patterns and import chains

**Research date:** 2026-04-11
**Valid until:** 2026-05-11 (stable codebase, no fast-moving dependencies)
