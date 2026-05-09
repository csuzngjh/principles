# Plan: PRI-82 → PRI-86 Sequential Execution

## Summary

Execute 5 Linear issues sequentially (PRI-82 → 83 → 84 → 85 → 86), each on its own branch with its own PR. Strict TDD: failing test first, then implementation. No scope expansion, no cross-issue mixing. PRI-85 depends on PRI-84 merge; PRI-86 depends on PRI-85 merge.

## Current State Analysis

### Monorepo Structure
- **`packages/principles-core/`** — Pure domain logic (`@principles/core`), framework-agnostic
  - `src/runtime-v2/` — Runtime V2 foundation (task store, run store, runners, orchestrator)
  - `src/runtime-v2/internalization/` — Internalization Engine contracts (peer-runner-contracts, dreamer-runner, orchestrator)
  - `src/runtime-v2/gfi/` — GFI kernel + read model
  - `src/runtime-v2/store/artifact/` — Existing ArtifactStore (Diagnostician-oriented)
  - `src/runtime-v2/__tests__/` — Core tests including dreamer-runner.test.ts, architecture-regression.test.ts
  - Test runner: vitest
- **`packages/openclaw-plugin/`** — OpenClaw plugin (thin adapter)
  - `src/core/focus-history.ts` — autoCompressFocus() implementation
  - `tests/` — Plugin tests
  - Test runner: vitest
- **`packages/pd-cli/`** — CLI tool (`@principles/pd-cli`)
  - `src/commands/runtime-health-snapshot.ts` — Health snapshot command
  - `src/commands/runtime-gfi-snapshot.ts` — GFI snapshot command (reads session files directly)
  - `src/commands/runtime-internalization-wake-once.ts` — Wake-once (dry-run only)
  - `src/commands/runtime-internalization-queue.ts` — Queue visibility
  - `src/index.ts` — Commander registration
  - Test runner: vitest

### Key Existing Patterns
- **Store pattern**: Interface in `store/xxx/xxx-store.ts`, Memory impl + SQLite impl
- **Runner pattern**: `DreamerRunner` with deps injection (`DreamerRunnerDeps`), `RunnerPhase` state machine
- **CLI pattern**: Handler function in `src/commands/`, registered in `src/index.ts`, tests mock `@principles/core/runtime-v2`
- **Read model pattern**: `OperatorHealthReadModel` aggregates multiple read models, `getSnapshot()` returns typed snapshot
- **GFI pattern**: `buildGfiWorkspaceSnapshot()` is a pure function taking `GfiReadModelInput`

---

## PRI-82: Post-PRI-81 Prompt Compression E2E Guard

### Goal
Add one focused E2E regression proving `autoCompressFocus()` preserves PRI-81 behavior after core migration.

### Branch: `pri-82/auto-compress-focus-e2e`

### TDD Steps

#### RED: Write failing test
- **File**: `packages/openclaw-plugin/src/core/__tests__/focus-history.test.ts` (new)
- Test: `autoCompressFocus() E2E — existing artifact preserved, missing artifact removed, core compression path used`
  1. Create temp workspace with CURRENT_FOCUS.md containing artifact table rows:
     - One row referencing an existing file
     - One row referencing a missing file
  2. Set content above line threshold (100 lines) to trigger compression
  3. Call `autoCompressFocus(focusPath, workspaceDir, stateDir)`
  4. Assert: `result.compressed === true`
  5. Assert: existing artifact row present in result.newContent
  6. Assert: missing artifact row absent from result.newContent
  7. Assert: result goes through core `compressFocusContent()` path (output is compressed, not just filtered)

#### GREEN: Implement
- No new implementation code expected — the test should pass against existing `autoCompressFocus()` logic
- If testability seam needed (e.g., injecting threshold config), add minimal seam to `focus-history.ts`

### Files Changed
| File | Action | Why |
|------|--------|-----|
| `packages/openclaw-plugin/src/core/__tests__/focus-history.test.ts` | CREATE | E2E regression test |
| `packages/openclaw-plugin/src/core/focus-history.ts` | EDIT (if needed) | Testability seam only |

### Verification
```bash
npx vitest run packages/openclaw-plugin/src/core/__tests__/focus-history.test.ts
npm run typecheck:openclaw-plugin
```

---

## PRI-83: Runtime Health Snapshot GFI Summary Integration

### Goal
Make `pd runtime health snapshot` surface authoritative GFI state so operators don't need a second command.

### Branch: `pri-83/health-gfi-summary`

### TDD Steps

#### RED: Write failing tests
- **File**: `packages/pd-cli/tests/commands/runtime-health-snapshot.test.ts` (extend existing)
- Test cases:
  1. JSON output includes `gfi` section with active stage, currentGfi, dominantSource, staleSessionCount, activeSessionCount, generatedAt
  2. Text output includes a compact GFI line
  3. When no session data: `gfi.active === null`, overallStatus not affected
  4. GFI data does not duplicate classification logic — reuses `buildGfiWorkspaceSnapshot`

- **File**: `packages/principles-core/src/runtime-v2/__tests__/operator-health-gfi.test.ts` (new)
- Test: `OperatorHealthSnapshot` includes `gfi` field of type `GfiWorkspaceSnapshot | { active: null }`

#### GREEN: Implement
1. Extend `OperatorHealthSnapshot` interface in `operator-health-read-model.ts`:
   ```ts
   gfi: GfiWorkspaceSnapshot | { active: null; staleSessionCount: 0; ... };
   ```
2. In `OperatorHealthReadModel.getSnapshot()`:
   - Read session files from `.state/sessions/` (reuse pattern from `runtime-gfi-snapshot.ts`)
   - Call `buildGfiWorkspaceSnapshot()` with session data
   - Include result in snapshot
   - If no sessions: return `gfi.active = null`
   - GFI missing data does NOT affect `overallStatus` (per Linear spec)
3. Update `formatTextOutput()` in `runtime-health-snapshot.ts` to add GFI line
4. Update CLI test mocks to include `gfi` field

### Files Changed
| File | Action | Why |
|------|--------|-----|
| `packages/principles-core/src/runtime-v2/operator-health-read-model.ts` | EDIT | Add GFI section to snapshot |
| `packages/pd-cli/src/commands/runtime-health-snapshot.ts` | EDIT | Add GFI text output line |
| `packages/pd-cli/tests/commands/runtime-health-snapshot.test.ts` | EDIT | Add GFI test cases |
| `packages/principles-core/src/runtime-v2/__tests__/operator-health-gfi.test.ts` | CREATE | Core GFI integration test |

### Verification
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-health-snapshot.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/operator-health-gfi.test.ts
```

---

## PRI-84: Internalization Engine PIArtifact Durable Store Contract

### Goal
Define and implement the durable PIArtifact persistence contract before real peer runners write outputs.

### Branch: `pri-84/pi-artifact-store`

### TDD Steps

#### RED: Write failing tests
- **File**: `packages/principles-core/src/runtime-v2/__tests__/pi-artifact-store.test.ts` (new)
- Test cases:
  1. `createArtifact()` persists a PIArtifact and returns it
  2. `getArtifactById()` retrieves artifact by ID
  3. `listBySourceTaskId()` returns all artifacts for a source task
  4. `listLineage()` returns artifacts linked via lineageArtifactIds
  5. Idempotency: same `sourceTaskId` + `artifactKind` does not create duplicate active artifacts
  6. `upsertArtifact()` updates existing artifact if matching sourceTaskId+kind exists
  7. Memory store implementation works (for testing)
  8. Architecture regression: source file exists

#### GREEN: Implement
1. **Schema/Type** in `packages/principles-core/src/runtime-v2/internalization/pi-artifact.ts`:
   ```ts
   interface PIArtifactRecord {
     artifactId: string;
     artifactKind: PIArtifactKind;
     sourceTaskId: string;
     sourcePrincipleId?: string;
     sourceRuleId?: string;
     lineageArtifactIds: string[];
     validationStatus: PIArtifactValidationStatus;
     contentJson: string;
     createdAt: string;
     updatedAt: string;
   }

   interface PIArtifactStore {
     createArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord>;
     upsertArtifact(record: PIArtifactRecord): Promise<PIArtifactRecord>;
     getArtifactById(artifactId: string): Promise<PIArtifactRecord | null>;
     listBySourceTaskId(sourceTaskId: string): Promise<PIArtifactRecord[]>;
     listLineage(artifactId: string): Promise<PIArtifactRecord[]>;
   }
   ```

2. **Memory store** in `packages/principles-core/src/runtime-v2/internalization/pi-artifact-store.ts`:
   - `MemoryPIArtifactStore` implements `PIArtifactStore`
   - Map-based storage
   - Idempotency key: `sourceTaskId + artifactKind`

3. **SQLite store** in `packages/principles-core/src/runtime-v2/internalization/pi-artifact-store-sqlite.ts`:
   - `SqlitePIArtifactStore` implements `PIArtifactStore`
   - Uses existing `SqliteConnection` pattern
   - Table: `pi_artifacts` with columns matching PIArtifactRecord
   - UNIQUE constraint on `(source_task_id, artifact_kind)` for idempotency

4. **Export** from `internalization/index.ts` and `runtime-v2/index.ts`

5. **Architecture regression**: Add `internalization/pi-artifact.ts` and `internalization/pi-artifact-store.ts` to REQUIRED_SOURCE_FILES

### Files Changed
| File | Action | Why |
|------|--------|-----|
| `packages/principles-core/src/runtime-v2/internalization/pi-artifact.ts` | CREATE | PIArtifactRecord type + PIArtifactStore interface |
| `packages/principles-core/src/runtime-v2/internalization/pi-artifact-store.ts` | CREATE | MemoryPIArtifactStore implementation |
| `packages/principles-core/src/runtime-v2/internalization/pi-artifact-store-sqlite.ts` | CREATE | SqlitePIArtifactStore implementation |
| `packages/principles-core/src/runtime-v2/internalization/index.ts` | EDIT | Export new types + store |
| `packages/principles-core/src/runtime-v2/index.ts` | EDIT | Re-export from top-level |
| `packages/principles-core/src/runtime-v2/__tests__/pi-artifact-store.test.ts` | CREATE | Store contract tests |
| `packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts` | EDIT | Add new source files |

### Verification
```bash
npm run build --workspace=@principles/core
npx vitest run packages/principles-core/src/runtime-v2/__tests__/pi-artifact-store.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts
```

---

## PRI-85: Internalization Engine DreamerRunner Vertical Slice

### ⚠️ DEPENDS ON PRI-84 MERGE

### Goal
Implement the first real peer-runner vertical slice: DreamerRunner consumes a ready PI task, creates a RunRecord, and writes a PIArtifact through the artifact store.

### Branch: `pri-85/dreamer-runner-vertical-slice`

### TDD Steps

#### RED: Write failing tests
- **File**: `packages/principles-core/src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts` (new)
- Test cases:
  1. **Success path**: DreamerRunner.run() → PIArtifact created via PIArtifactStore, task marked succeeded with `dreamer://` resultRef
  2. **Adapter failure**: runtimeAdapter.startRun throws → task retried, no artifact created
  3. **Invalid output**: validation fails → task retried, no artifact created
  4. **Idempotent execution**: calling run() twice for same task → no duplicate artifacts
  5. **Artifact lineage**: artifact has correct lineageArtifactIds from predecessor context

#### GREEN: Implement
1. Extend `DreamerRunnerDeps` to include `PIArtifactStore`:
   ```ts
   interface DreamerRunnerDeps {
     stateManager: RuntimeStateManager;
     runtimeAdapter: PDRuntimeAdapter;
     eventEmitter: StoreEventEmitter;
     validator: DreamerValidator;
     artifactStore: PIArtifactStore;  // NEW
   }
   ```

2. In `DreamerRunner.succeedTask()`:
   - After `updateRunOutput()`, create PIArtifact via `artifactStore.upsertArtifact()`
   - Build `PIArtifactRecord` from DreamerOutput + context
   - Set `lineageArtifactIds` from predecessor artifact IDs
   - Set `artifactKind` based on DreamerOutput content (e.g., 'principle')

3. Update existing `dreamer-runner.test.ts` to include `artifactStore` in deps (backward compatible — MemoryPIArtifactStore)

### Files Changed
| File | Action | Why |
|------|--------|-----|
| `packages/principles-core/src/runtime-v2/internalization/dreamer-runner.ts` | EDIT | Add artifactStore dep, write artifact on success |
| `packages/principles-core/src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts` | CREATE | Vertical slice tests |
| `packages/principles-core/src/runtime-v2/__tests__/dreamer-runner.test.ts` | EDIT | Update deps to include artifactStore |

### Verification
```bash
npm run build --workspace=@principles/core
npx vitest run packages/principles-core/src/runtime-v2/__tests__/dreamer-runner-vslice.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/dreamer-runner.test.ts
npx vitest run packages/principles-core/src/runtime-v2/__tests__/architecture-regression.test.ts
```

---

## PRI-86: Internalization Engine Worker Wake-and-Run CLI

### ⚠️ DEPENDS ON PRI-85 MERGE

### Goal
Add CLI entry point that runs one Internalization Engine worker step end-to-end for DreamerRunner.

### Branch: `pri-86/internalization-run-once-cli`

### TDD Steps

#### RED: Write failing tests
- **File**: `packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts` (new)
- Test cases:
  1. `--runner dreamer` with ready task → leases task, runs DreamerRunner, outputs structured JSON
  2. `--runner dreamer --dry-run` → delegates to wake-once dry-run behavior
  3. `--runner philosopher` → returns `unsupported_runner` output
  4. No ready tasks → returns `no_ready_tasks` decision
  5. Lease conflict → returns `lease_conflict` with failure category
  6. RuntimeStateManager resources are closed in finally block

#### GREEN: Implement
1. **File**: `packages/pd-cli/src/commands/runtime-internalization-run-once.ts`
   - Handler: `handleRuntimeInternalizationRunOnce(opts)`
   - Options: `--workspace <path>`, `--runner <kind>`, `--dry-run`, `--json`
   - Validate runner kind: only 'dreamer' supported; others → `unsupported_runner`
   - If `--dry-run`: delegate to `InternalizationOrchestrator.wakeOnce()` with dryRun=true
   - If not dry-run:
     1. Initialize `RuntimeStateManager`
     2. Call `orchestrator.wakeOnce()` to find + lease candidate
     3. If leased: instantiate `DreamerRunner` with deps, call `runner.run(taskId)`
     4. Output structured JSON: `{ wakeDecision, taskId, runId, artifactId/resultRef, status, failureCategory? }`
     5. Close `RuntimeStateManager` in finally

2. **Register** in `packages/pd-cli/src/index.ts`:
   ```ts
   internalizationCmd
     .command('run-once')
     .description('Run one internalization worker step end-to-end')
     .option('-w, --workspace <path>', 'Workspace directory')
     .option('--runner <kind>', 'Runner kind (dreamer)', 'dreamer')
     .option('--dry-run', 'Evaluate without executing')
     .option('--json', 'Output raw JSON')
   ```

### Files Changed
| File | Action | Why |
|------|--------|-----|
| `packages/pd-cli/src/commands/runtime-internalization-run-once.ts` | CREATE | Run-once handler |
| `packages/pd-cli/src/index.ts` | EDIT | Register run-once command |
| `packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts` | CREATE | CLI tests |

### Verification
```bash
npm run build --workspace=@principles/core
npm run build --workspace=@principles/pd-cli
npx vitest run packages/pd-cli/tests/commands/runtime-internalization-run-once.test.ts
npx vitest run packages/pd-cli/tests/commands/runtime-internalization.test.ts
```

---

## Execution Order & Dependencies

```
PRI-82 ──→ PRI-83 ──→ PRI-84 ──→ PRI-85 ──→ PRI-86
  │            │          │          │          │
  │            │          │          │          └─ depends on PRI-85 merge
  │            │          │          └─ depends on PRI-84 merge
  │            │          └─ standalone
  │            └─ standalone
  └─ standalone
```

Each issue:
1. Create branch from main
2. Write failing test(s)
3. Implement until tests pass
4. Run verification commands
5. Create PR with verification results
6. Wait for merge before next issue (mandatory for PRI-84→85→86 chain)

## Assumptions & Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PRI-82 test location | `src/core/__tests__/` | User preference; Linear suggestion |
| PRI-83 GFI integration | Extend OperatorHealthSnapshot | Core read model owns the aggregation; CLI is thin |
| PRI-84 store location | `internalization/` directory | PIArtifact is internalization-domain; separate from Diagnostician ArtifactStore |
| PRI-84 idempotency key | `sourceTaskId + artifactKind` | Per Linear spec: same source + kind should not create duplicate |
| PRI-84 lineage fields | `lineageArtifactIds: string[]` | Per Linear spec: prefer over ambiguous string refs |
| PRI-85 artifact write | In `succeedTask()` after `updateRunOutput()` | Artifact must be written before task marked succeeded |
| PRI-86 unsupported runners | Return structured error, not throw | Operator-friendly; exit code 1 with clear message |
| Test framework | vitest | Existing project standard |
| No comments in code | Per project rules | Unless explicitly asked |
