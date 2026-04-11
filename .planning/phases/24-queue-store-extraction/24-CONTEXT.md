# Phase 24: Queue Store Extraction - Context

**Gathered:** 2026-04-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Extract all queue persistence logic (read/write/migrate/purge/lock) from `evolution-worker.ts` into a dedicated `EvolutionQueueStore` class with write/read validation contracts. The worker retains only the call sites that delegate to the new store.

**Scope:**
- Queue file I/O (read, write, backup)
- V2 migration logic
- Lock acquisition and release for queue operations
- Queue item schema validation (write-time and read-time)
- Purge/cleanup of stale failed tasks
- Deduplication helpers (normalizePainDedupKey, findRecentDuplicateTask, hasRecentDuplicateTask)

**NOT in scope:**
- Task dispatch logic (Phase 26)
- Pain flag detection (Phase 25)
- Workflow watchdog (Phase 27)
- Silent fallback audit (Phase 28)

</domain>

<decisions>
## Implementation Decisions

### API Shape
- **D-01:** EvolutionQueueStore is a **class** instantiated with `new EvolutionQueueStore(workspaceDir)`. Holds workspace state, methods operate on `this.workspaceDir`. Consistent with `EvolutionEngine` pattern in codebase.

### Schema Validation
- **D-02:** Queue item validation is **permissive** — validate required fields only (taskKind, status, priority, retryCount, maxRetries, etc.), ignore unknown fields. This allows forward-compatible queue format evolution without breaking old code.

### Lock Ownership
- **D-03:** EvolutionQueueStore **owns lock management internally**. All public methods (load, save, add, update, purge, etc.) automatically acquire and release the file lock. Callers do not need to manage locks. This eliminates the risk of lock-less queue access that causes corruption.

### Error Handling
- **D-04:** Follow existing `PdError` hierarchy from `config/errors.ts`. Use specific error types (e.g., `QueueCorruptionError`, `LockUnavailableError`) rather than generic Error throws.
- **D-05:** Queue corruption on read: backup corrupted file, return structured error with reasons (not silent fallback to empty array).

### Extraction Approach
- **D-06:** Extract incrementally — move functions one cluster at a time, maintaining a working build after each move. Do not rewrite; relocate existing logic.

### Claude's Discretion
- Internal method names and private helper organization
- Exact file location within `service/` directory
- Test file organization and naming
- Whether to use a separate types file or inline types

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Contract Patterns (v1.13 templates)
- `packages/openclaw-plugin/src/core/pain.ts` — Factory function + validator pattern (buildPainFlag, readPainFlagContract)
- `packages/openclaw-plugin/src/core/workspace-dir-service.ts` — Fail-fast service pattern (resolveRequiredWorkspaceDir)
- `packages/openclaw-plugin/src/core/nocturnal-snapshot-contract.ts` — Structured validation result pattern ({status, reasons, snapshot})

### Existing Code to Extract From
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — Source file (2133 lines). Queue-related functions at lines 175-486, 551-607, 1780-1819. Lock functions at lines 397-420. Dedup functions at lines 429-512.

### Infrastructure to Reuse
- `packages/openclaw-plugin/src/utils/file-lock.ts` — withLockAsync, acquireLockAsync, releaseImportedLock
- `packages/openclaw-plugin/src/config/errors.ts` — PdError hierarchy, LockUnavailableError
- `packages/openclaw-plugin/src/config/index.ts` — LockUnavailableError export

### Patterns to Follow
- `packages/openclaw-plugin/src/core/evolution-engine.ts` — Class-based service pattern with workspace state

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `PdError` hierarchy (8 derived error types) — use for queue-specific errors
- `withLockAsync` / `acquireLockAsync` — file locking primitives, already handle async lock acquisition
- `EvolutionEngine` class pattern — shows how to structure a class-based service with workspace state

### Established Patterns
- **Class pattern:** Constructor takes workspaceDir, methods use `this.workspaceDir`, class-level logger
- **Error pattern:** Semantic error classes extending PdError, thrown at boundary points
- **Test pattern:** describe blocks with beforeEach/afterEach, temp workspaces via os.tmpdir()
- **Import style:** ES modules with `import type` for type-only imports

### Integration Points
- `evolution-worker.ts` → will import and delegate to `EvolutionQueueStore` instead of inline queue I/O
- `processEvolutionQueue()` → currently reads queue directly; will call `store.load()`
- `doEnqueuePainTask()` / `enqueueSleepReflectionTask()` → currently write queue directly; will call `store.add()`
- `purgeStaleFailedTasks()` → currently inline; will become `store.purge()`
- `registerEvolutionTaskSession()` → currently reads/writes queue; will call store methods
- `migrateQueueToV2()` / `isLegacyQueueItem()` → will move into store as private methods

### Functions to Extract (by cluster)
1. **Queue types** (L175-274): QueueStatus enum, TaskResolution enum, EvolutionQueueItem interface, LegacyEvolutionQueueItem interface
2. **Migration** (L276-318): migrateToV2, isLegacyQueueItem, migrateQueueToV2
3. **Lock** (L397-420): acquireQueueLock, requireQueueLock
4. **Dedup** (L429-512): findRecentDuplicateTask, normalizePainDedupKey, hasRecentDuplicateTask, hasEquivalentPromotedRule
5. **Queue ops** (L456-607): purgeStaleFailedTasks, enqueueSleepReflectionTask, doEnqueuePainTask
6. **Queue read** in processEvolutionQueue (L861-920): initial queue load, backup, migration call
7. **Queue write** in processEvolutionQueue: task status updates, completion markers
8. **Register session** (L1780-1819): registerEvolutionTaskSession

</code_context>

<specifics>
## Specific Ideas

- Queue item validation should follow the v1.13 `readPainFlagContract` pattern: return `{status: 'valid'|'invalid', reasons: string[], data?: EvolutionQueueItem}`
- Corrupted queue files should be backed up (current behavior) but with a structured error instead of silent fallback to empty
- Store should provide a `withLock<T>(fn: () => Promise<T>): Promise<T>` method for cases where the caller needs atomic multi-step operations (e.g., load → modify → save in one lock scope)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 24-queue-store-extraction*
*Context gathered: 2026-04-11*
