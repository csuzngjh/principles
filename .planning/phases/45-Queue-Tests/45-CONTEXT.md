# Phase 45: Queue Tests - Context

**Gathered:** 2026-04-15
**Status:** Ready for planning

<domain>
## Phase Boundary

Add integration and unit tests for queue enqueue/dequeue/migration paths in `packages/openclaw-plugin/`. No implementation changes — testing only. Functions under test live in `evolution-worker.ts` (migrateToV2, loadEvolutionQueue, saveEvolutionQueue, purgeStaleFailedTasks) and `utils/file-lock.ts` (asyncLockQueues).

</domain>

<decisions>
## Implementation Decisions

### QTEST-01: legacy-queue-v1.json Fixture Location
- **D-01:** Store the `legacy-queue-v1.json` fixture as a dedicated JSON file at `tests/fixtures/legacy-queue-v1.json`
- **D-02:** This matches the existing `tests/fixtures/production-mock-generator.ts` pattern — fixtures are versioned files, generators produce dynamic data

### QTEST-04: Queue Async Lock Test Location
- **D-03:** Create dedicated `tests/queue/async-lock.test.ts` for queue-specific async locking tests
- **D-04:** Use `Promise.all` for race detection as specified in the requirement
- **D-05:** Clear Map state between tests using `beforeEach` setup
- **D-06:** This follows the established project structure (tests/core/, tests/service/, tests/utils/) — a new `tests/queue/` subdirectory for queue-specific tests

### QTEST-05: Snapshot Test Format
- **D-07:** Use explicit `expect()` assertions with input/expected pairs for migration state transitions
- **D-08:** Do NOT use Vitest `toMatchInlineSnapshot` or `toMatchSnapshot` — project convention is explicit assertions throughout
- **D-09:** Test each state transition as: given input queue state → expected migrated output

### Test Infrastructure (all QTESTs)
- **D-10:** Use `vi.useFakeTimers()` — already the project standard (14+ existing test files)
- **D-11:** Use `os.tmpdir()` + `fs.mkdtempSync()` for temp file isolation — established pattern in `file-lock.test.ts`
- **D-12:** Use `beforeEach`/`afterEach` for test isolation and cleanup
- **D-13:** Tests go in `tests/` subdirectories matching source module location: `tests/core/` for migration, `tests/queue/` for queue operations

### Test File Structure
- **D-14:** `tests/core/evolution-migration.test.ts` — already exists, extend for `migrateToV2` integration tests
- **D-15:** `tests/service/evolution-worker.queue.test.ts` — new file for loadEvolutionQueue/saveEvolutionQueue unit tests with fake timers
- **D-16:** `tests/queue/async-lock.test.ts` — new dedicated file for `asyncLockQueues` concurrency tests
- **D-17:** `tests/core/queue-purge.test.ts` — new file for `purgeStaleFailedTasks` deduplication logic tests

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source files under test
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — migrateToV2 (line 337), loadEvolutionQueue (line 721), saveEvolutionQueue, purgeStaleFailedTasks (line 554)
- `packages/openclaw-plugin/src/utils/file-lock.ts` — asyncLockQueues (async lock utilities)

### Existing test patterns
- `packages/openclaw-plugin/tests/core/evolution-migration.test.ts` — existing migration tests (uses os.tmpdir pattern)
- `packages/openclaw-plugin/tests/utils/file-lock.test.ts` — existing file lock tests (uses Promise.all for race detection, vi.useFakeTimers)
- `packages/openclaw-plugin/tests/service/evolution-worker.timeout.test.ts` — existing worker tests with vi.useFakeTimers
- `packages/openclaw-plugin/tests/fixtures/production-mock-generator.ts` — existing fixture pattern
- `packages/openclaw-plugin/vitest.config.ts` — Vitest configuration

### Type definitions
- `packages/openclaw-plugin/src/service/evolution-worker.ts` — EvolutionQueueItem, LegacyEvolutionQueueItem types
- `packages/openclaw-plugin/src/types/queue.ts` — queue type definitions (from Phase 43 Type Safety work)

</canonical_refs>

<codebase_context>
## Existing Code Insights

### Reusable Assets
- `os.tmpdir()` + `fs.mkdtempSync()` — temp file creation for test isolation
- `vi.useFakeTimers()` / `vi.useRealTimers()` — timer control, already widespread
- `Promise.all` with result tracking — race detection pattern from `file-lock.test.ts`

### Established Patterns
- Tests in `tests/` mirror `src/` directory structure
- Chinese-language test descriptions used in some test files
- `beforeEach`/`afterEach` for cleanup
- Mock factories in `tests/fixtures/` for complex objects

### Integration Points
- `loadEvolutionQueue` reads from `queuePath` (filesystem path to queue JSON file)
- `purgeStaleFailedTasks` operates on in-memory `EvolutionQueueItem[]` array
- `asyncLockQueues` manages concurrent access to queue files via file locks

</codebase_context>

<specifics>
## Specific Ideas

- `vi.useFakeTimers()` must be called in `beforeEach`, `vi.useRealTimers()` in `afterEach` to avoid timer bleed between tests
- `legacy-queue-v1.json` should contain an array of legacy queue items WITHOUT the `taskKind` field to test the backward-compatibility migration path
- Race detection: use `Promise.all` with two concurrent `asyncLockQueues` operations starting simultaneously, verify only one succeeds

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope
</deferred>

