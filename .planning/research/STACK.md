# Technology Stack: Tech Debt Remediation

**Project:** Split god classes, fix type safety, add queue tests
**Researched:** 2026/04/15
**Confidence:** HIGH (verified against current docs)

---

## 1. File Splitting Strategy (evolution-worker.ts 2689L, nocturnal-trinity.ts 2429L)

### Natural Module Boundaries in evolution-worker.ts

The file has identifiable vertical slices based on function groupings:

| Module | Lines | Functions | Rationale |
|--------|-------|-----------|-----------|
| `workflow-watchdog.ts` | ~59-300 | `runWorkflowWatchdog` | Self-contained monitoring concern |
| `queue-migration.ts` | ~304-366 | `migrateToV2`, `isLegacyQueueItem`, `migrateQueueToV2` | Version-specific data transformation |
| `time-helpers.ts` | ~348-442 | `isSessionAtOrBeforeTriggerTime`, `buildFallbackNocturnalSnapshot` | Pure date/time utilities |
| `task-lock.ts` | ~442-566 | `createEvolutionTaskId`, `acquireQueueLock`, `extractEvolutionTaskId` | Lock acquisition/release |
| `dedup-helpers.ts` | ~492-651 | `purgeStaleFailedTasks`, `hasRecentDuplicateTask`, `normalizePainDedupKey` | Deduplication logic |
| `pain-source.ts` | ~617-740 | `buildPainSourceKey`, `hasRecentSimilarReflection` | Pain source identification |
| `queue-io.ts` | ~688-830 | `loadEvolutionQueue`, `enqueueNewSleepReflectionTask` | File I/O for queue persistence |
| `enqueue-tasks.ts` | ~830-903 | `enqueueSleepReflectionTask`, `enqueueKeywordOptimizationTask`, `doEnqueuePainTask` | Task creation |
| `pain-flag-checker.ts` | ~903-1077 | `checkPainFlag` | Single responsibility checker |
| `evolution-queue-processor.ts` | ~1077-2210 | `processEvolutionQueue` | Core processing loop |
| `detection-queue-processor.ts` | ~2210-2266 | `processDetectionQueue` | Separate queue concern |
| `session-registration.ts` | ~2266-2338 | `registerEvolutionTaskSession` | Session lifecycle |
| `worker-status.ts` | ~2338-2394 | `writeWorkerStatus` | Status persistence |
| `evolution-worker-service.ts` | ~2394-2689 | Main service object | Facade/re-export |

### Splitting Principles

1. **Extract interfaces first, implementation second** — Define the public API of each module before extracting
2. **Preserve import graph** — Each module should import from `src/core` or `src/config`, not from sibling modules to avoid circular deps
3. **Keep file-lock.ts, atomicWriteFileSync usage centralized** — These utilities should remain in `src/utils/` and be imported
4. **Preserve WAL pragma settings** — Database pragmas belong in the store classes, not scattered

### Anti-Patterns to Avoid

- **Don't create barrel files** (`index.ts` re-exporting everything) — adds indirection without value
- **Don't extract to `helpers/` directories** — leads to god helper files over time
- **Don't extract one function at a time** — batch by concern to preserve git history better

---

## 2. TypeScript Strict Type Refactoring (36 `as any` casts across 6 files)

### Root Causes of `as any` Usage

| File | Count | Pattern | Fix |
|------|-------|---------|-----|
| `evolution-worker.ts` | 4 | Event payload with `skipReason`, `failures` | Define `EventPayload` interface |
| `promote-impl.ts` | 2 | Dynamic `lifecycleState` property | Add to `Implementation` interface |
| `prompt.ts` | 3 | `runtimeSubagent` from plugin framework | Declare module augmentation |
| `message-sanitize.ts` | 2 | Transformed message shape | Define `SanitizedMessage` type |
| `rollback.ts`, `pain.ts` | 2 | `sessionId` from `ctx` | Use proper context typing |
| `deep-reflect.ts` | 1 | `runtimeSubagent` | Module augmentation |

### Type Predicate Pattern for Event Payloads

Replace:
```typescript
if ((payload as any).skipReason) {
    detailedError += ` (skipReason: ${(payload as any).skipReason})`;
}
```

With:
```typescript
// Define type guard
function hasSkipReason(x: unknown): x is { skipReason: string } {
  return typeof x === 'object' && x !== null && 'skipReason' in x;
}

function hasFailures(x: unknown): x is { failures: string[] } {
  return typeof x === 'object' && x !== null && 'failures' in x && Array.isArray((x as { failures: unknown }).failures);
}

// Usage
if (hasSkipReason(payload)) {
    detailedError += ` (skipReason: ${payload.skipReason})`;
}
```

### Discriminated Union for Dynamic Properties

Replace:
```typescript
(impl as any).lifecycleState === 'candidate'
```

With:
```typescript
// In types.ts
export interface Implementation {
  id: string;
  ruleId: string;
  version: number;
  // ... other fields
}

export interface CandidateImplementation extends Implementation {
  lifecycleState: 'candidate';
}

// Use type guard
function isCandidate(impl: Implementation): impl is CandidateImplementation {
  return 'lifecycleState' in impl && (impl as CandidateImplementation).lifecycleState === 'candidate';
}
```

### Module Augmentation for Framework Types

Replace:
```typescript
subagent: runtimeSubagent as any
```

With:
```typescript
// In src/types/framework.d.ts
declare module '../openclaw-sdk' {
  interface OpenClawPluginApi {
    runtime?: {
      subagent?: SubagentRuntime;
    };
  }
}
```

### TypeScript Config Already Has `strict: true`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "noUncheckedIndexedAccess": true
  }
}
```

Add for better safety:
```json
{
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true
  }
}
```

---

## 3. Testing Strategies for Queue-Based Systems

### Current Test Infrastructure

- **Framework:** Vitest 4.1.0 with `pool: 'threads'` (required for better-sqlite3 native handles)
- **Location:** `packages/openclaw-plugin/tests/`
- **Pattern:** `describe`/`it` blocks with `beforeEach`/`afterEach` cleanup

### Queue Test Patterns

#### 1. Fake Timers for Queue Delay Testing

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('evolution queue processing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should process tasks after cooldown', async () => {
    const processSpy = vi.fn();
    const queue = createTestQueue(['task-1', 'task-2']);

    // Enqueue with 100ms delay
    const enqueuePromise = queue.enqueue('task-1', { delayMs: 100 });
    vi.advanceTimersByTime(100);
    await enqueuePromise;

    // Now process
    vi.runAllTimers();
    expect(processSpy).toHaveBeenCalledTimes(1);
  });
});
```

#### 2. Queue State Machine Testing

```typescript
describe('queue item state transitions', () => {
  it('pending -> in_progress -> completed', () => {
    const item: EvolutionQueueItem = {
      id: 'task-1',
      status: 'pending',
      created_at: Date.now(),
      // ...
    };

    // Simulate transition
    item.status = 'in_progress';
    expect(item.status).toBe('in_progress');

    item.status = 'completed';
    expect(item.status).toBe('completed');
  });

  it('should not transition from completed to pending', () => {
    const item: EvolutionQueueItem = { status: 'completed', /* ... */ };
    expect(() => {
      item.status = 'pending'; // Should not happen
    }).toThrow();
  });
});
```

#### 3. Migration Testing (V1 -> V2)

```typescript
describe('queue migration V1 -> V2', () => {
  it('should transform legacy items', () => {
    const legacyItem: LegacyEvolutionQueueItem = {
      kind: 'sleep_reflection', // V1 field
      sessionId: 's1',
      principleId: 'p1',
    };

    const migrated = migrateToV2(legacyItem);

    expect(migrated.taskKind).toBe('sleep_reflection');
    expect(migrated.version).toBe(2);
    expect(migrated.id).toBeDefined();
  });

  it('should handle mixed queue with V1 and V2 items', () => {
    const mixedQueue: RawQueueItem[] = [
      { version: 1, kind: 'sleep_reflection', sessionId: 's1', principleId: 'p1' },
      { version: 2, taskKind: 'sleep_reflection', id: 'v2-1' },
    ];

    const migrated = migrateQueueToV2(mixedQueue);

    expect(migrated).toHaveLength(2);
    expect(migrated[0].version).toBe(2);
    expect(migrated[1].version).toBe(2);
  });
});
```

#### 4. Integration Test with Real Database

```typescript
// tests/integration/queue-migration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';

describe('workflow store integration', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec('CREATE TABLE test_queue (...);');
  });

  afterEach(() => {
    db.close();
  });

  it('should persist and retrieve queue items', () => {
    const insert = db.prepare('INSERT INTO test_queue VALUES (?, ?)');
    insert.run('task-1', JSON.stringify({ status: 'pending' }));

    const result = db.prepare('SELECT * FROM test_queue').get() as { id: string; data: string };
    expect(JSON.parse(result.data).status).toBe('pending');
  });
});
```

### DO NOT Add

- **Sinon** — Vitest's `vi.fn()`, `vi.spyOn()` are sufficient
- **ts-mockito** — Vitest's built-in mocking covers most needs
- **Jest-matchers** — Vitest uses identical API but different import
- **Testcontainers** — Not needed; better-sqlite3 with `:memory:` or temp files works

---

## 4. better-sqlite3 Replacement Options

### Option A: node:sqlite (Node.js 22.5+ built-in) — RECOMMENDED (with conditions)

**Status:** Built into Node.js, no npm package needed

| Criterion | better-sqlite3 | node:sqlite |
|-----------|---------------|-------------|
| API | Synchronous only | `DatabaseSync` (sync) + `Database` (async) |
| ESM Support | Yes (with `import Database from 'better-sqlite3'`) | Native ESM via `node:sqlite` |
| TypeScript types | `@types/better-sqlite3` | Bundled with Node.js |
| Speed | Faster (native) | Slightly slower but acceptable |
| Maintenance | Third-party | Core Node.js team |

**Migration Path:**
```typescript
// Before
import Database from 'better-sqlite3';
const db = new Database(path);
db.pragma('journal_mode = WAL');

// After
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(path);
```

**Breaking Changes:**
- No `.prepare().get()` — use `DatabaseSync.prepare()` then `.all()` or `.run()`
- No `.exec()` chaining — statements are separate
- Busy timeout: `new DatabaseSync(path, { timeout: 5000 })` instead of pragma

**Files affected:** `control-ui-db.ts`, `central-database.ts`, `workflow-store.ts`, `trajectory.ts`

**Caveat:** node:sqlite is only viable if the project can target Node.js 22.5+. Check `engines` in package.json.

### Option B: sql.js (WebAssembly SQLite) — AVOID

- Pure JavaScript, no native compilation
- Slower than both better-sqlite3 and node:sqlite
- No write-ahead logging (WAL) support
- Same API as better-sqlite3 but slower

**DO NOT USE** — Only appropriate for browser environments.

### Migration Sequence (If Switching to node:sqlite)

1. Add `node:sqlite` types polyfill if needed (TypeScript 5.6+ has built-in)
2. Replace import: `import { DatabaseSync } from 'node:sqlite'`
3. Change constructor: `new Database(path)` -> `new DatabaseSync(path)`
4. Update pragma calls to constructor options
5. Replace `.get()` with `.all()[0]` or `.run()` for side effects
6. Add to vitest integration list (same as better-sqlite3 — native handles still need threads pool)

---

## Integration Points

### Files Importing better-sqlite3

| File | Usage Pattern |
|------|---------------|
| `src/core/control-ui-db.ts` | Full schema with migrations |
| `src/core/trajectory.ts` | Sessions, turns, tool_calls tables |
| `src/service/central-database.ts` | Shared DB for services |
| `src/service/subagent-workflow/workflow-store.ts` | Workflow + events tables |
| `src/core/schema/db-types.ts` | `Db` interface (should be preserved) |

### Queue Entry Points

| Function | File | Purpose |
|----------|------|---------|
| `loadEvolutionQueue` | evolution-worker.ts:688 | Read queue from disk |
| `enqueueSleepReflectionTask` | evolution-worker.ts:740 | Add sleep task |
| `enqueueKeywordOptimizationTask` | evolution-worker.ts:774 | Add keyword task |
| `doEnqueuePainTask` | evolution-worker.ts:830 | Add pain task |
| `processEvolutionQueue` | evolution-worker.ts:1077 | Main worker loop |

---

## What NOT to Add

| Library | Why Not |
|---------|---------|
| `zod` | `@sinclair/typebox` is already in use; adding both creates type duplication |
| `io-ts` | Same as above |
| `runtypes` | Same as above |
| `typanion` | Static validation only; typebox covers runtime |
| `jest` | Vitest already present and configured |
| `chai` | Vitest expect is equivalent |
| `proxyquire` | Vitest vi.mock() is sufficient |
| `testdouble` | Same as above |
| `msw` | Only for HTTP; not needed for queue testing |

---

## Recommended Order of Work

1. **Define interfaces** — Create `src/types/queue.ts` with all queue item types, then `src/types/event-payload.ts`
2. **Extract migrations** — Pull V1->V2 migration into `src/service/queue-migration.ts`
3. **Extract pure functions** — time-helpers, dedup-helpers, task-lock as standalone modules
4. **Fix `as any` casts** — Use type predicates and discriminated unions
5. **Add unit tests** — Test extracted modules with fake timers
6. **Consider node:sqlite** — Only if Node 22+ is targeted; otherwise stay with better-sqlite3

---

## Sources

- [TypeScript Narrowing with Type Predicates](https://github.com/microsoft/typescript/blob/main/tests/baselines/reference/inKeywordTypeguard(strict=false).errors.txt) — HIGH confidence
- [TypeScript Unknown Type Guard Patterns](https://github.com/microsoft/typescript/blob/main/tests/baselines/reference/unknownType1.errors.txt) — HIGH confidence
- [Vitest Fake Timers](https://github.com/vitest-dev/vitest/blob/main/docs/guide/mocking/timers.md) — HIGH confidence
- [Vitest vi.runAllTicks](https://github.com/vitest-dev/vitest/blob/main/docs/api/vi.md) — HIGH confidence
- [Node.js node:sqlite Documentation](https://github.com/nodejs/node/blob/main/doc/api/sqlite.md) — HIGH confidence
- [TypeScript verbatimModuleSyntax Migration](https://github.com/microsoft/typescript/blob/main/tests/baselines/reference/preserveValueImports(isolatedmodules=true).errors.txt) — HIGH confidence
