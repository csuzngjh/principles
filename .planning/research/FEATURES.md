# Feature Landscape: Tech Debt Remediation

**Domain:** TypeScript plugin refactoring (openclaw-plugin)
**Focus:** Splitting god classes, fixing type safety, adding queue tests
**Researched:** 2026-04-15
**Confidence:** MEDIUM (based on codebase analysis + established patterns; external docs services were unavailable for verification)

---

## 1. God Class Refactoring Patterns

### Table Stakes (Foundational Patterns)

These patterns are industry-standard and expected when splitting TypeScript god classes.

| Pattern | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Single Responsibility via Module Extraction** | Each module does one thing; makes testing and reasoning possible | Medium | See `evolution-worker.ts` - currently 144KB with ~10 concerns |
| **Interface Segregation** | Clients shouldn't depend on methods they don't use | Low | Current code uses broad interfaces like `OpenClawPluginApi as any` |
| **Dependency Injection** | Decouples creation from usage; enables mocking | Medium | Already used in `WorkflowManagerBase` constructor pattern |
| **Strategy Pattern for Variants** | When behavior differs by type but shares structure | Medium | Already used: `NocturnalWorkflowManager`, `EmpathyObserverWorkflowManager`, etc. |

### Differentiators (Advanced Patterns)

Patterns that go beyond basic refactoring to enable testability and extensibility.

| Pattern | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Domain Event Emission** | Replace direct side effects with event streams | High | Enables async testing without mocking the world |
| **State Machine for Complex Objects** | Replaces ad-hoc state with explicit transitions | Medium | `EvolutionQueueItem` has `QueueStatus` - could use `xstate` |
| **Repository Pattern for Persistence** | Abstracts storage; enables in-memory test implementations | Medium | `WorkflowStore` already exists - could generalize |
| **Command/Query Separation** | Distinguish mutating operations from reads | Medium | `EvolutionWorkerService` mixes both |

### Current God Class: `evolution-worker.ts` (144KB)

**Responsibilities currently mixed together:**
1. Workflow Watchdog (lines 46-190)
2. Queue V2 Schema + Migration (lines 203-346)
3. File Locking helpers (lines 435-482)
4. Deduplication logic (lines 492-564)
5. Pain context reading (lines 586+)
6. Nocturnal snapshot building (lines 366-430)
7. Cooldown strategy integration
8. Session cleanup
9. Trajectory registry

**Suggested module boundaries based on existing patterns:**

| Module | Responsibility | Boundary Rationale |
|--------|---------------|-------------------|
| `queue-core.ts` | Queue schema, migration, deduplication, purging | Pure data transformations on `EvolutionQueueItem[]` |
| `queue-persistence.ts` | File locking, queue file I/O | Handles `acquireQueueLock`, `requireQueueLock` |
| `snapshot-builder.ts` | Nocturnal session snapshot building | `buildFallbackNocturnalSnapshot` and related logic |
| `watchdog.ts` | Workflow anomaly detection | `runWorkflowWatchdog` - already isolated function |
| `pain-context.ts` | Pain flag reading, recent context extraction | `readRecentPainContext` - pure transformation |

### Dependencies Identified

```
evolution-worker.ts imports:
├── ../core/workspace-context.js         (WorkspaceContext)
├── ../core/dictionary-service.js         (DictionaryService)
├── ../core/detection-service.js          (DetectionService)
├── ./subagent-workflow/workflow-store.js (WorkflowStore)
├── ./subagent-workflow/*-workflow-manager.js (multiple managers)
├── ../core/nocturnal-trajectory-extractor.js
├── ./nocturnal-runtime.js               (checkWorkspaceIdle, checkCooldown, recordCooldown)
├── ./cooldown-strategy.js               (recordPersistentFailure, resetFailureState, isTaskKindInCooldown)
└── ... 20+ more
```

**Refactoring risk:** High coupling to context objects. Recommend extracting to **Facade pattern** first before splitting.

---

## 2. Type-Safe Alternatives to `as any` Casts

### Table Stakes (Essential Patterns)

| Pattern | Use Case | Complexity | Notes |
|---------|----------|------------|-------|
| **Discriminated Unions** | When a value can be one of several shapes | Low | `QueueStatus = 'pending' \| 'in_progress' \| 'completed' \| 'failed' \| 'canceled'` already used |
| **Type Guards** | Narrow union types based on runtime checks | Low | `isLegacyQueueItem(item)` already exists (line 336) |
| **Const Assertions** | Lock object literal to literal types | Low | `as const` on enums and config objects |
| **Unknown vs any** | Replace `any` with `unknown` + type narrowing | Low | Force callers to validate before use |

### Differentiators (Advanced Patterns)

| Pattern | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Branded Types** | Prevent mixing IDs that share same primitive type | Medium | e.g., `type WorkflowId = string & { readonly brand: unique symbol }` |
| **Template Literal Types** | Encode format in type system | Medium | `type SessionKey = \`agent:main:subagent:workflow-${string}\`` |
| **Mapped Types + Infer** | Transform types systematically | High | Useful for deriving `WorkflowHandle` from `WorkflowSpec` |
| **ThisType** | Methods that return instance type | High | Rarely needed |

### Current `as any` Hotspots (from codebase grep: 597 occurrences)

**High-impact locations to fix first:**

| Location | Count | Risk | Suggested Fix |
|----------|-------|------|---------------|
| `evolution-worker.ts` | 6 | High | Queue operations need branded `QueueItemId` |
| `tests/hooks/gate-*.test.ts` | ~100+ | Low | Test mocks - acceptable with `as any` |
| `test-utils.ts` helpers | 3 | Medium | Use `vi.mocked()` instead |
| Service mock definitions | 50+ | Medium | Define proper mock interfaces |

### Existing Type Safety in Codebase

**Already well-done:**
```typescript
// Discriminated union (evolution-worker.ts:203-204)
export type QueueStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'canceled';
export type TaskResolution = 'marker_detected' | 'auto_completed_timeout' | ...;

// Type guard (evolution-worker.ts:336-338)
function isLegacyQueueItem(item: RawQueueItem): boolean {
    return item && typeof item === 'object' && !('taskKind' in item);
}
```

### Branded Type Example for Queue

```typescript
// brands.ts
declare const brand: unique symbol;
export type Brand<T, B> = T & { readonly [brand]: B };
export type WorkflowId = Brand<string, 'WorkflowId'>;
export type QueueItemId = Brand<string, 'QueueItemId'>;
export type SessionKey = Brand<string, 'SessionKey'>;

// Conversion functions
export function toWorkflowId(id: string): WorkflowId {
    return id as WorkflowId;
}

export function toQueueItemId(id: string): QueueItemId {
    return id as QueueItemId;
}

// Validation
export function isQueueItemId(id: string): id is QueueItemId {
    return /^[\w-]{8}$/.test(id); // Matches MD5 hash format used in createEvolutionTaskId
}
```

---

## 3. Queue Integration Testing Patterns

### Table Stakes (Essential Patterns)

| Pattern | Use Case | Complexity | Notes |
|---------|----------|------------|-------|
| **In-Memory Queue Implementation** | Test queue logic without file I/O | Low | Create `InMemoryQueueStore` implementing same interface as `WorkflowStore` |
| **Fixture Factories** | Generate test data programmatically | Low | `createMockQueueItem()`, `createLegacyQueueItem()` |
| **Snapshot Testing** | Verify queue serialization format | Medium | Use `toMatchSnapshot()` for JSON structure |
| **Temp Directory for File Tests** | Isolate file-based tests | Low | `fs.mkdtempSync(path.join(os.tmpdir(), 'pd-queue-'))` |

### Differentiators (Advanced Patterns)

| Pattern | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **State Transition Table Tests** | Exhaustively test all valid/invalid transitions | Medium | `describe('QueueStatus transitions', ...)` |
| **Migration Testing** | Test V1 to V2 migration with fixtures | Medium | `describe('migrateToV2')` with legacy item fixtures |
| **Concurrency Simulation** | Test file locking behavior | High | Multiple `acquireQueueLock` calls in parallel |
| **Property-Based Testing** | Random valid inputs to find edge cases | High | Use `fast-check` library |

### Queue Test Architecture

```
tests/
├── unit/
│   ├── queue-core.test.ts        # Schema validation, migration, deduplication
│   ├── queue-dedup.test.ts       # findRecentDuplicateTask, hasRecentDuplicateTask
│   └── queue-purge.test.ts      # purgeStaleFailedTasks
├── integration/
│   ├── queue-persistence.test.ts # File locking, concurrent writes
│   └── queue-workflow.test.ts    # Queue + workflow interaction
└── fixtures/
    ├── legacy-queue-v1.json       # Pre-V2 queue items
    └── queue-migration-cases.json # Known migration scenarios
```

### Migration Testing Pattern

```typescript
describe('migrateToV2', () => {
    const cases: Array<{
        name: string;
        input: LegacyEvolutionQueueItem;
        expectedTaskKind: TaskKind;
        expectedPriority: TaskPriority;
    }> = [
        {
            name: 'legacy item without taskKind defaults to pain_diagnosis',
            input: { id: 'abc', score: 85, source: 'gate', reason: 'test', timestamp: '2026-01-01' },
            expectedTaskKind: 'pain_diagnosis',
            expectedPriority: 'medium',
        },
        // Add more cases
    ];

    test.each(cases)('$name', ({ input, expectedTaskKind, expectedPriority }) => {
        const result = migrateToV2(input);
        expect(result.taskKind).toBe(expectedTaskKind);
        expect(result.priority).toBe(expectedPriority);
        expect(result.retryCount).toBe(0);
        expect(result.maxRetries).toBe(3);
    });
});
```

### Deduplication Testing Pattern

```typescript
describe('findRecentDuplicateTask', () => {
    const now = Date.now();
    const thirtyMinAgo = now - (30 * 60 * 1000);

    const queue: EvolutionQueueItem[] = [
        {
            id: 'task-1',
            taskKind: 'pain_diagnosis',
            priority: 'high',
            source: 'gate',
            score: 85,
            reason: 'gate block',
            timestamp: new Date(thirtyMinAgo + 1000).toISOString(),
            enqueued_at: new Date(thirtyMinAgo + 1000).toISOString(),
            status: 'pending',
            retryCount: 0,
            maxRetries: 3,
        },
    ];

    it('returns existing task if duplicate within dedup window', () => {
        const result = findRecentDuplicateTask(queue, 'gate', '', thirtyMinAgo + 5000, 'gate block');
        expect(result).toBeDefined();
        expect(result?.id).toBe('task-1');
    });

    it('returns undefined if outside dedup window', () => {
        const outsideWindow = now - (31 * 60 * 1000);
        const result = findRecentDuplicateTask(queue, 'gate', '', outsideWindow, 'gate block');
        expect(result).toBeUndefined();
    });
});
```

### Purge Testing Pattern

```typescript
describe('purgeStaleFailedTasks', () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const dayAgo = Date.now() - (25 * 60 * 60 * 1000);
    const hourAgo = Date.now() - (30 * 60 * 1000);

    it('removes failed tasks older than 24 hours', () => {
        const queue: EvolutionQueueItem[] = [
            { id: 'old-failed', status: 'failed', timestamp: new Date(dayAgo).toISOString(), score: 80, source: 'test', reason: 'old', taskKind: 'pain_diagnosis', priority: 'medium', retryCount: 0, maxRetries: 3 },
            { id: 'recent-failed', status: 'failed', timestamp: new Date(hourAgo).toISOString(), score: 80, source: 'test', reason: 'recent', taskKind: 'pain_diagnosis', priority: 'medium', retryCount: 0, maxRetries: 3 },
        ];

        const result = purgeStaleFailedTasks(queue, logger as any);

        expect(result.purged).toBe(1);
        expect(result.remaining).toBe(1);
        expect(queue.find(t => t.id === 'old-failed')).toBeUndefined();
        expect(queue.find(t => t.id === 'recent-failed')).toBeDefined();
    });
});
```

---

## 4. Workflow Manager Testing Approaches

### Table Stakes (Essential Patterns)

| Pattern | Use Case | Complexity | Notes |
|---------|----------|------------|-------|
| **Mock AsyncFn Helper** | Create typed async mocks | Low | Already exists in codebase (`mockAsyncFn`) |
| **WorkflowHandle Extraction** | Access internal state for assertions | Low | Uses `(manager as any).activeWorkflows.get(handle.workflowId)` |
| **Timeout Cleanup** | Prevent test pollution from timers | Low | `clearTimeout(timeout)` before assertions |
| **Dispose Verification** | Ensure cleanup in `afterEach` | Low | `manager.dispose()` followed by `fs.rmSync` |

### Differentiators (Advanced Patterns)

| Pattern | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Spec-Driven Testing** | Test any workflow type via `SubagentWorkflowSpec` | Medium | Already used in empathy-observer tests |
| **Transport Abstraction** | Test both `runtime_direct` and future transports | Medium | `runtime_direct` is current only option |
| **TTL Expiry Simulation** | Test orphan cleanup without waiting | Medium | Manipulate `created_at` in store |
| **Event Sequence Verification** | Verify workflow events in order | Medium | `store.getEvents(wf.workflow_id)` |

### Key Test Scenarios for Workflow Managers

| Scenario | What to Test | Approach |
|----------|-------------|----------|
| **startWorkflow success** | Workflow created, session started, timeout scheduled | Assert `store.getWorkflow()`, assert `subagent.run` called |
| **startWorkflow surface degrade** | Boot session rejection, subagent unavailable | Assert error thrown |
| **notifyWaitResult(ok)** | Finalize called, session deleted | Spy on `finalizeOnce`, assert `subagent.deleteSession` |
| **notifyWaitResult(timeout)** | Workflow marked `terminal_error` | Assert `store.getWorkflow().state === 'terminal_error'` |
| **TTL expiry** | Workflow swept as expired | Manipulate `wf.created_at`, run watchdog |
| **getWorkflowDebugSummary** | Returns correct summary | Assert structure matches `WorkflowDebugSummary` |
| **dispose cleanup** | All timeouts cleared | Track active timeouts, call dispose, verify cleared |

### Existing Workflow Manager Test Pattern

**From `tests/service/empathy-observer-workflow-manager.test.ts`:**

```typescript
function mockAsyncFn<T extends (...args: any[]) => Promise<any>>(impl: (...args: any[]) => any) {
    const fn = vi.fn(impl) as unknown as T;
    Object.defineProperty(fn, 'constructor', {
        value: function AsyncFunction() {},
        writable: true,
        configurable: true,
    });
    return fn;
}

describe('EmpathyObserverWorkflowManager', () => {
    let subagent = {
        run: mockAsyncFn(async () => ({ runId: 'run-123' })),
        waitForRun: mockAsyncFn(async () => ({ status: 'ok' as const })),
        getSessionMessages: mockAsyncFn(async () => ({ messages: [], assistantTexts: ['{"ok":true}'] })),
        deleteSession: mockAsyncFn(async () => {}),
    };

    // Test pattern: clear internal timeout before assertions
    const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
    if (timeout) {
        clearTimeout(timeout);
        (manager as any).activeWorkflows.delete(handle.workflowId);
    }
});
```

### Workflow Manager Base Test Pattern

Tests shared behavior in `WorkflowManagerBase` that all workflow managers inherit:

```typescript
describe('WorkflowManagerBase', () => {
    describe('startWorkflow', () => {
        it('creates workflow record with correct initial state', async () => {
            const handle = await manager.startWorkflow(spec, {
                parentSessionId: 'parent-1',
                taskInput: 'test',
            });

            const workflow = (manager as any).store.getWorkflow(handle.workflowId);
            expect(workflow.state).toBe('active');
            expect(workflow.workflowType).toBe('empathy-observer');
        });

        it('schedules timeout for workflow TTL', async () => {
            const handle = await manager.startWorkflow(spec, {
                parentSessionId: 'parent-2',
                taskInput: 'test',
            });

            const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
            expect(timeout).toBeDefined();
            // TTL is 300000ms (5 min), verify timeout is set correctly
        });
    });

    describe('notifyWaitResult', () => {
        it('finalizes workflow on ok status', async () => {
            const handle = await manager.startWorkflow(spec, {
                parentSessionId: 'parent-3',
                taskInput: 'test',
            });

            // Clear timeout to prevent actual timer firing
            const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
            clearTimeout(timeout);
            (manager as any).activeWorkflows.delete(handle.workflowId);

            const finalizeSpy = vi.spyOn(manager, 'finalizeOnce').mockResolvedValue();
            await manager.notifyWaitResult(handle.workflowId, 'ok');

            expect(finalizeSpy).toHaveBeenCalledWith(handle.workflowId);
        });

        it('marks terminal_error on timeout status', async () => {
            const handle = await manager.startWorkflow(spec, {
                parentSessionId: 'parent-4',
                taskInput: 'test',
            });

            const timeout = (manager as any).activeWorkflows.get(handle.workflowId);
            clearTimeout(timeout);
            (manager as any).activeWorkflows.delete(handle.workflowId);

            await manager.notifyWaitResult(handle.workflowId, 'timeout', 'timed out');

            const workflow = (manager as any).store.getWorkflow(handle.workflowId);
            expect(workflow.state).toBe('terminal_error');
        });
    });
});
```

---

## Feature Dependencies

```
God Class Refactoring (evolution-worker.ts)
    │
    ├── Module: queue-core.ts
    │       └── Types: EvolutionQueueItem, QueueStatus, TaskResolution
    │
    ├── Module: queue-persistence.ts
    │       └── Depends on: queue-core.ts
    │       └── External: fs, file-lock utilities
    │
    ├── Module: snapshot-builder.ts
    │       └── Depends on: queue-core.ts, nocturnal-trajectory-extractor
    │       └── Produces: NocturnalSessionSnapshot
    │
    └── Module: watchdog.ts
            └── Depends on: workflow-store, subagent runtime
            └── Produces: WatchdogResult

Type Safety Improvements
    │
    ├── Brand types for IDs
    │       └── QueueItemId, WorkflowId, SessionKey
    │
    ├── Type guards for queue items
    │       └── isValidQueueItem, isLegacyQueueItem
    │
    └── Replace `as any` with unknown + narrowing
            └── Target: evolution-worker.ts queue operations

Queue Testing
    │
    ├── Unit tests for migration (migrateToV2)
    │       └── Fixture: legacy queue items
    │
    ├── Unit tests for deduplication
    │       └── findRecentDuplicateTask, hasRecentDuplicateTask
    │
    ├── Unit tests for purging
    │       └── purgeStaleFailedTasks
    │
    └── Integration tests for file persistence
            └── Concurrent lock acquisition

Workflow Manager Testing
    │
    ├── Base class tests (shared behavior)
    │       └── startWorkflow, notifyWaitResult, dispose
    │
    ├── Subclass tests (specific behavior)
    │       └── surfaceDegrade checks, metadata creation
    │
    └── TTL expiry tests (via store manipulation)
```

---

## MVP Recommendation

**Prioritize in this order:**

1. **Type Safety First** (Low risk, high value)
   - Add branded types for `QueueItemId`, `WorkflowId`, `SessionKey`
   - Replace `as any` in queue operations with proper type guards
   - This enables safe refactoring in subsequent steps

2. **Queue Core Extraction** (Medium risk, high value)
   - Extract `migrateToV2`, `isLegacyQueueItem`, `findRecentDuplicateTask`, `purgeStaleFailedTasks` to `queue-core.ts`
   - These are pure functions, easily testable in isolation
   - Creates clear module boundary for queue operations

3. **Queue Unit Tests** (Low risk, medium value)
   - Test migration logic with legacy fixtures
   - Test deduplication window behavior
   - Test purge logic

4. **Workflow Manager Base Tests** (Low risk, medium value)
   - Add tests for shared `WorkflowManagerBase` behavior
   - Enables safe refactoring of workflow managers
   - Uses existing `mockAsyncFn` pattern

**Defer:**
- `watchdog.ts` extraction (high coupling to `WorkflowStore` internals)
- `snapshot-builder.ts` extraction (depends on trajectory extractor)
- Event emission refactoring (high complexity, low immediate value)
- File-based queue persistence tests (requires complex temp directory setup)

---

## Sources

- God class analysis: `packages/openclaw-plugin/src/service/evolution-worker.ts` (144KB, 488+ lines)
- Existing refactoring: `packages/openclaw-plugin/src/service/subagent-workflow/workflow-manager-base.ts` (demonstrates Strategy pattern extraction)
- Existing tests: `packages/openclaw-plugin/tests/service/empathy-observer-workflow-manager.test.ts`
- Existing queue schema: `evolution-worker.ts:203-346` (QueueStatus, TaskResolution, migration)
- Existing type guard: `evolution-worker.ts:336-338` (isLegacyQueueItem)
- Testing patterns: `docs/maps/testing-patterns.md`

**Confidence Note:** External documentation services (Context7, WebSearch) were unavailable during research. Findings are based on codebase analysis combined with established TypeScript/Node.js patterns. Recommend validation of specific API choices before implementation.
