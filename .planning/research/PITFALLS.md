# Pitfalls Research: Tech Debt Remediation -- God Classes, `as any`, Queue Tests, Native Modules

**Domain:** TypeScript plugin tech debt: file splitting, type safety, integration tests, native module portability
**Researched:** 2026-04-15
**Confidence:** MEDIUM-HIGH (code analysis + established patterns; limited web search due to tool availability)

---

## Executive Summary

Four categories of tech debt remediation for the nocturnal pipeline plugin. Each has distinct runtime breakage patterns. File splitting breaks at module boundaries (shared mutable state, singleton patterns, import order) not type boundaries. Removing `as any` casts requires fixing the underlying type architecture, not just the casts. Queue integration tests are brittle when they test timing rather than behavior. Native module replacement (better-sqlite3) introduces platform and performance dimensions that are absent from pure TypeScript refactoring.

---

## Category 1: Splitting Large TypeScript Files

Splitting `evolution-worker.ts` (2689L) and `nocturnal-trinity.ts` (2429L) can break at runtime despite TypeScript compilation passing. The breakage vectors are structural, not syntactic.

### Pitfall 1A: Shared Mutable Module-Level State

**What goes wrong:** Module-level variables in the original file become cross-module references after splitting. If two extracted modules both mutate a shared variable, or if one module expects to initialize state that another module's import order prevents, runtime behavior diverges from the monolithic file.

**Evidence from codebase:** `file-lock.ts` (line 325) has `const asyncLockQueues = new Map<string, Promise<void>>()` at module level. If this were split across files, the Map instance identity must be preserved -- a new import would get a different Map reference, breaking all queue operations.

**Warning signs:**
- Any `const/let` declarations at module scope (not inside classes/functions)
- Module-level caches, registries, or state maps
- Singleton patterns with `instance` fields

**Prevention:** Before splitting, identify all module-level mutable state. Extract it into a shared `state.ts` or pass it as a context object. Do not scatter mutable module state across split boundaries.

**Which phase:** Pre-splitting phase (Phase 0 -- inventory module state before making any cuts).

---

### Pitfall 1B: Circular Import Dependencies

**What goes wrong:** The original file may have implicit import ordering. Splitting creates explicit import edges that can form cycles: `a.ts` imports `b.ts` which imports `c.ts` which imports `a.ts`. Node.js handles some cycles via partial module evaluation, but the behavior is fragile and often causes `undefined` at runtime.

**Warning signs:**
- Import statements that reference types from other files without explicit forward declarations
- `import type` mixed with value imports in ways that create coupling
- Any `../core/` or `../service/` relative paths that cross split boundaries

**Prevention:** Draw the import graph before splitting. Every cycle must be broken by extracting shared types into a third module that neither split module depends on transitively.

**Which phase:** Pre-splitting phase (Phase 0).

---

### Pitfall 1C: Implicit Execution Order Dependencies

**What goes wrong:** Code in a single large file executes in a predictable top-to-bottom order. After splitting, different modules may initialize at different times. Initialization side effects (registering handlers, populating caches, setting up hooks) may fire in a different order, causing failures that only manifest at runtime.

**Example scenario:** `evolution-worker.ts` line 1-45 imports all modules. If `runWorkflowWatchdog` registers itself with a global registry on import, and a split module's import fires before that registration, calls to the registry fail silently or throw.

**Warning signs:**
- Code that runs on `import` (top-level `await`, side-effecting initializations)
- Registration patterns: `Registry.register(X)` at module scope
- Event emitter `.on()` calls at module scope

**Prevention:** Convert all module-scope side effects into explicit initialization calls that run after all imports resolve. Consider an `initialize()` function per module that is called explicitly, in dependency order, from a single bootstrap file.

**Which phase:** Pre-splitting phase (Phase 0).

---

### Pitfall 1D: Type-Only Sharing vs Value Sharing Confusion

**What goes wrong:** When a large file is split, types may be moved to a shared `types.ts` but the values (functions, classes) remain in one split. Callers that imported both the type and the implementation from the original file now get partial imports. TypeScript may not catch this if the imports use `import type`.

**Warning signs:**
- `import type` used alongside `import { fn }` from the same module
- Re-exports via `export type { X } from './y'` that do not also re-export the value

**Prevention:** Distinguish type-only exports from value exports. After splitting, verify every import path resolves to both the type and the implementation. A type import alone compiles but returns `undefined` at runtime for value references.

**Which phase:** Post-splitting verification phase (Phase 2 -- after initial split).

---

### Pitfall 1E: Named vs Default Export Mismatches

**What goes wrong:** Large files may use a mix of named and default exports. When splitting, import sites in other files may reference the wrong export style. TypeScript accepts many combinations that fail at runtime (e.g., `import x from 'module'` where `module` exports only named exports).

**Warning signs:**
- Mixed `export default` and `export const/class function` in the same file
- Re-export patterns like `export { x } from './y'`

**Prevention:** Audit all export styles before splitting. Establish a consistent export convention (recommended: all named exports, no default exports for modules). Verify import sites match export styles.

**Which phase:** Pre-splitting audit phase (Phase 0).

---

## Category 2: Removing `as any` Casts

The codebase has 36+ `as any` casts across multiple files. Simply removing them without fixing the underlying type architecture creates new problems.

### Pitfall 2A: Removing Casts Without Fixing Source Types Breaks Runtime

**What goes wrong:** Most `as any` casts exist because the underlying types are too broad or missing. The cast is a symptom, not the disease. Removing the cast by widening the target type to accept the source is not a fix -- it postpones the problem.

**Specific evidence from codebase:**
- `prompt.ts:594, 630`: `subagent: runtimeSubagent as any` -- the plugin framework types `subagent` as `any`. Removing the cast requires either the plugin SDK to export a proper type, or defining a local type that captures the subagent contract.
- `message-sanitize.ts:30, 43`: `return { message: { ...msg, content: sanitized } as any }` -- the `msg` type apparently does not have a `content` field. Casting to `any` sidesteps a type mismatch that likely reflects a real API gap.

**Prevention strategy:** Categorize each `as any` cast by root cause:
1. **Plugin framework gap** (subagent type `any`): Define a local interface that captures the actual subagent contract used in the codebase. Do not cast to `any`; use the local interface.
2. **API extension gap** (adding fields to foreign types): Define a local extension interface with the extra fields and use that instead of `as any`.
3. **Internal type casting** (casting between internal types): Use proper type guards or branded types.

**Which phase:** Phase 1 (categorize and define proper types before removing any casts).

---

### Pitfall 2B: Over-Widening Types to Avoid Casts

**What goes wrong:** When a cast is removed by adding `content?: string` to a foreign interface, that change pollutes the type definition. If the foreign interface is shared across many call sites, the change has blast radius. If it lives in a third-party package, the change is impossible.

**Example:** Adding `content` to a `Message` type in `message-sanitize.ts` to avoid `as any` creates a field that may not exist on all `Message` objects in the system.

**Prevention strategy:** Create local extension interfaces. Never modify third-party or SDK types. Define:
```typescript
// local type that extends the framework type with our usage
interface SanitizedMessage extends Message {
  content: string;
}
```
Then use `as SanitizedMessage` instead of `as any`. The cast is now to a meaningful type that documents the extension.

**Which phase:** Phase 1.

---

### Pitfall 2C: Type Erasure at Runtime for Class Casts

**What goes wrong:** TypeScript type information is erased at runtime. `instance as SomeType` compiles but at runtime is a no-op if `instance` is not actually a `SomeType`. If the underlying value does not have the expected structure, the code fails later with a confusing error.

**Warning signs:**
- `as any` on object literals or class instances where the runtime shape may not match the declared type
- Casts inside error handlers where the error type is unknown

**Prevention:** Verify that every `as any` removal results in a runtime-safe cast. Add runtime validation (e.g., `zod` schema, `instanceof`, or explicit field checks) for casts that cannot be verified at compile time.

**Which phase:** Phase 2 (after types are defined, add runtime validation for edge cases).

---

## Category 3: Adding Queue Integration Tests

The `file-lock.ts` `asyncLockQueues` Map implements in-process queue serialization. Integration tests for this queue must avoid timing brittleness and state leakage.

### Pitfall 3A: Module-Level State Leaking Across Test Runs

**What goes wrong:** `asyncLockQueues` at `file-lock.ts:325` is a module-level `Map`. In tests, if the module is imported and the Map is populated, subsequent test runs in the same process may see stale queue entries. This causes tests to fail non-deterministically or pass when they should fail.

**Warning signs:**
- Any module-level `const` that is a `Map`, `Set`, array, or object that accumulates state
- Tests that pass in isolation but fail when run with other tests

**Prevention:**
- Export `asyncLockQueues` (or a reset function) so tests can clear it between runs
- Use `vi.resetModules()` in vitest to ensure clean module state per test
- Add an `_resetAsyncLockQueues()` internal function for testing only (documented as test-only)

**Which phase:** Phase 1 (add test infrastructure for state isolation before writing queue tests).

---

### Pitfall 3B: Timing-Dependent Tests (setTimeout, sleep, waitFor)

**What goes wrong:** Queue tests that wait for a specific duration (e.g., `await new Promise(r => setTimeout(r, 100))`) are inherently brittle. On slow CI systems, the timeout may be too short. On fast systems, the wait is wasted time.

**Warning signs:**
- `setTimeout` inside test logic
- `await new Promise(resolve => setTimeout(resolve, N))`
- `waitFor` loops that check a condition N times with sleep between checks

**Prevention:**
- Test queue semantics (ordering, concurrency limits, no duplicate processing) without timing dependencies
- Use callback or promise resolution to signal completion instead of arbitrary delays
- If timing must be tested (e.g., throttle behavior), use Vitest's fake timers (`vi.useFakeTimers()`)

**Which phase:** Phase 1 (establish test patterns before writing queue tests).

---

### Pitfall 3C: Over-Mocking in Integration Tests

**What goes wrong:** Integration tests that mock too heavily (mocking `fs`, `path`, `crypto`) test the mock behavior, not the actual queue behavior. The queue may work correctly against mocks but fail against real I/O.

**Warning signs:**
- `vi.mock('fs')` in integration tests for queue components
- Mock implementations that do not match real filesystem semantics (e.g., atomic rename, file locking)

**Prevention:**
- Integration tests for the queue should use real `asyncLockQueues` and real `Map` operations where possible
- Only mock external dependencies (filesystem, network) at the boundary, not the queue logic itself
- Create a `createInMemoryLockQueue()` factory for unit testing the queue algorithm with a fake Map

**Which phase:** Phase 1 (distinguish unit-testable queue logic from I/O-dependent queue logic).

---

### Pitfall 3D: Tests That Mutate Shared State Without Restoring It

**What goes wrong:** Tests that add entries to `asyncLockQueues` during execution but do not remove them leave the module dirty. Subsequent tests see a non-empty queue and either fail or exhibit incorrect behavior.

**Prevention:**
- Use `afterEach` to clear `asyncLockQueues` after every test
- Use `beforeEach` to assert `asyncLockQueues.size === 0` as a sanity check
- Consider wrapping `asyncLockQueues` in a getter function that can be intercepted by tests

**Which phase:** Phase 1.

---

### Pitfall 3E: Race Conditions in Queue Tests Not Caught by Sequential Test Runners

**What goes wrong:** The queue is designed to handle concurrent access. If a test suite runs tests sequentially, it may not catch race conditions that only manifest under concurrent access. The Vitest default runner may run describe blocks in sequence but `it` blocks within a describe in parallel.

**Warning signs:**
- `asyncLockQueues` Map access without synchronization in the queue implementation itself
- Tests that do not explicitly await all queue operations before asserting

**Prevention:**
- Add explicit concurrency tests: run N parallel operations and verify all complete without corruption
- Use `Promise.all` to create concurrent load in a dedicated test
- Verify the queue Map is never left in an inconsistent state (e.g., entry present but Promise never resolved)

**Which phase:** Phase 2 (after basic queue tests pass, add concurrency stress tests).

---

## Category 4: Replacing better-sqlite3 (Native Module)

Multiple files depend on `better-sqlite3`: `central-database.ts`, `control-ui-db.ts`, `workflow-store.ts`, `trajectory.ts`. Replacement options include `sql.js` (WebAssembly) and `bun:sqlite` (Bun built-in). Each introduces portability and performance pitfalls.

### Pitfall 4A: API Surface Differences (sync vs async, parameter types)

**What goes wrong:** `better-sqlite3` is synchronous. `sql.js` is also synchronous but has a different API. `bun:sqlite` is synchronous but has different prepared statement and binding semantics. Simply swapping the import breaks compilation and runtime behavior.

**Specific API differences to watch for:**
- `new Database(path)` constructor options vary
- `stmt.run(params)` vs `stmt.bind(params)` vs `stmt.run(...params)`
- Transaction control (`db.transaction(() => {})` in better-sqlite3 vs manual `BEGIN/COMMIT`)
- Return value of `stmt.run()` (changesResult vs changes boolean)
- `db.pragma()` syntax and available pragmas

**Prevention:**
- Before replacing, create a compatibility shim/adapter that wraps the new library with the `better-sqlite3` interface
- Write integration tests that verify all SQL operations produce identical results
- Do not replace all usages at once; replace one file at a time with the adapter

**Which phase:** Phase 1 (build adapter shim before touching any SQLite-dependent file).

---

### Pitfall 4B: Binary Storage Incompatibility

**What goes wrong:** `better-sqlite3` stores data in a platform-specific binary format. An existing `.db` file created with `better-sqlite3` on Linux x64 cannot be directly opened by `sql.js` (WASM) without conversion. The file format may be incompatible across architectures.

**Warning signs:**
- Existing `.db` files in the codebase or user workspaces
- Tests that rely on pre-seeded database files

**Prevention:**
- Provide a migration path: export data from `better-sqlite3`, import into new library
- Or: use a conversion utility that reads the binary format and re-creates the DB in the new format
- Document that users may need to rebuild state on first run after migration

**Which phase:** Phase 1 (document migration path before making any changes).

---

### Pitfall 4C: Performance Regression (sql.js vs native)

**What goes wrong:** `sql.js` (WASM) is 2-10x slower than `better-sqlite3` for write workloads and large queries. `bun:sqlite` is comparable or faster for read-heavy workloads but may differ on write transactions.

**Warning signs:**
- Database operations in hot paths (every prompt hook, every tool call)
- Large result sets (trajectory queries can return thousands of rows)

**Prevention:**
- Benchmark the replacement library against the current `better-sqlite3` implementation with representative workloads before committing
- Set performance budgets: e.g., trajectory query must complete in <50ms for 10K rows
- If performance regresses, consider hybrid approach: use `sql.js` for read-only databases and `better-sqlite3` for write-heavy databases

**Which phase:** Phase 1 (benchmark before deciding on replacement library).

---

### Pitfall 4D: Memory Pressure from WASM (sql.js)

**What goes wrong:** `sql.js` runs SQLite in a WebAssembly虚拟机. It loads the entire database into memory. For large trajectory databases (>100MB), this causes memory pressure. `better-sqlite3` memory-maps the file, using far less RSS.

**Warning signs:**
- `trajectory.ts` can accumulate large databases over time
- User workspaces with long-running sessions produce large `.db` files

**Prevention:**
- Size-limit the in-memory database or use streaming queries for large result sets
- Consider `sql.js` only for workflow store (typically small) while keeping `better-sqlite3` for trajectory (typically large)
- Add a memory budget check: if DB file > 50MB, warn or use chunked loading

**Which phase:** Phase 1 (assess database sizes in production data).

---

### Pitfall 4E: Node.js Version and Platform Build Dependencies

**What goes wrong:** `better-sqlite3` requires native compilation. `sql.js` (WASM) has no native deps but requires the WASM binary to be loaded. `bun:sqlite` requires Bun runtime. The replacement affects the minimum Node.js version and may break Windows builds if the WASM path is not configured correctly.

**Warning signs:**
- `package.json` has `optionalDependencies` for `better-sqlite3`
- CI builds for multiple platforms (Linux, macOS, Windows)
- `.node` binary files in the repo

**Prevention:**
- `sql.js` requires bundling the WASM file and loading it at runtime via `fs.readFileSync` or fetch
- Ensure the WASM file path resolution works across all platforms (use `import.meta.url` or `require.resolve`)
- Test on all target platforms before merging

**Which phase:** Phase 1 (establish CI matrix for replacement library on all target platforms).

---

## Cross-Cutting Concerns

### Pitfall 5: Refactoring All Four Areas Simultaneously

**What goes wrong:** Splitting god classes, removing `as any`, adding queue tests, and replacing native modules are four independent refactoring axes. Doing them together creates compounded risk where failures in one axis mask failures in another.

**Prevention:** Execute in phases:
1. Split files first (establishes new module boundaries)
2. Add queue tests second (validates the split modules' concurrency behavior)
3. Remove `as any` casts third (now that the module graph is stable)
4. Replace native modules last (after all type and behavior contracts are stable)

**Which phase:** Sequencing recommendation above; do not parallelize these four work items.

---

## Phase-Specific Warning Matrix

| Pitfall | Warning Sign | Prevention | Phase |
|---------|-------------|------------|-------|
| 1A: Shared mutable module state | Module-level `Map`/`Set`/array | Extract to shared state module | Phase 0 (pre-split) |
| 1B: Circular imports | Cross-split imports creating cycles | Draw import graph, break cycles | Phase 0 |
| 1C: Execution order | Side effects on import | Convert to explicit `initialize()` calls | Phase 0 |
| 1D: Type vs value sharing | `import type` without value export | Audit all exports after split | Phase 2 |
| 1E: Named/default export mismatch | Mixed export styles | Normalize export convention | Phase 0 |
| 2A: Removing casts without fixing types | Cast removed but type still wrong | Categorize casts by root cause first | Phase 1 |
| 2B: Over-widening types | Modifying third-party types | Use local extension interfaces | Phase 1 |
| 2C: Type erasure at runtime | Cast to interface without runtime check | Add `zod` or `instanceof` validation | Phase 2 |
| 3A: Module state leaking in tests | Tests pass in isolation, fail together | `vi.resetModules()`, clear `asyncLockQueues` | Phase 1 |
| 3B: Timing-dependent tests | `setTimeout` in test logic | Use fake timers or promise resolution | Phase 1 |
| 3C: Over-mocking | Mocking `fs` in integration tests | Test real queue logic, mock only I/O boundary | Phase 1 |
| 3D: Tests not restoring state | `asyncLockQueues.size` grows across tests | `afterEach` cleanup | Phase 1 |
| 3E: Race conditions not caught | No concurrency tests | Explicit `Promise.all` concurrency tests | Phase 2 |
| 4A: API surface differences | Different method signatures | Build compatibility adapter shim | Phase 1 |
| 4B: Binary storage incompatibility | Existing `.db` files unreadable | Provide migration/conversion path | Phase 1 |
| 4C: Performance regression | Queries slower after replacement | Benchmark before and after | Phase 1 |
| 4D: WASM memory pressure | Large DB loaded into memory | Size-limit or chunked loading | Phase 1 |
| 4E: Build/CI compatibility | WASM not loading on Windows | Test on all target platforms | Phase 1 |

---

## "Looks Done But Isn't" Checklist for This Refactoring

- [ ] All module-level mutable state extracted to explicit shared modules (no mutable state at module scope in split files)
- [ ] Import graph has no cycles after splitting
- [ ] All `as any` casts replaced with meaningful local type definitions
- [ ] Queue tests do not contain `setTimeout` or arbitrary sleep delays
- [ ] `asyncLockQueues` Map is cleared between tests
- [ ] `better-sqlite3` replacement has a compatibility shim with identical API surface
- [ ] Existing `.db` files can be migrated to new format without data loss
- [ ] Performance budget met on representative workloads for any SQLite replacement

---

## Sources

- Code analysis of `packages/openclaw-plugin/src/service/evolution-worker.ts` (first 100 lines, imports and structure)
- Code analysis of `packages/openclaw-plugin/src/core/nocturnal-trinity.ts` (export and import patterns)
- Code analysis of `packages/openclaw-plugin/src/utils/file-lock.ts` (asyncLockQueues Map, lines 320-362)
- Code analysis of `packages/openclaw-plugin/src/hooks/prompt.ts` (`as any` casts at lines 594, 630)
- Code analysis of `packages/openclaw-plugin/src/hooks/message-sanitize.ts` (`as any` casts at lines 30, 43)
- Code analysis of `packages/openclaw-plugin/tests/hooks/gate-pipeline-integration.test.ts` (test patterns, mocking)
- `packages/openclaw-plugin/vitest.config.ts` (test framework configuration)
- Vitest documentation (timing test patterns, fake timers)
- sql.js documentation (WASM constraints, memory model)
- TypeScript handbook (type erasure, `import type` vs `import`)

---

*Pitfalls research for: Tech debt remediation (god class split, as any removal, queue tests, native module replacement)*
*Researched: 2026-04-15*
