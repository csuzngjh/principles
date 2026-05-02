# m8-01-04 SUMMARY — PainSignalBridge Implementation

**Status**: SHIPPED
**Date**: 2026-04-28
**Wave**: 2 (parallel with plans 01-03)

## What was done

### 1. PainSignalBridge class (principles-core)

**File**: `packages/principles-core/src/runtime-v2/pain-signal-bridge.ts`

- Self-contained `PainDetectedData` interface (no openclaw-plugin imports)
- Receives `RuntimeStateManager`, `DiagnosticianRunner`, `CandidateIntakeService`, `LedgerAdapter` via constructor
- `onPainDetected(data: PainDetectedData)` method:
  1. Creates `diagnostician` task in SqliteTaskStore (taskId = painId)
  2. Invokes `runner.run(taskId)` — runner handles lease lifecycle
  3. On success: queries real candidateIds via `stateManager.getCandidatesByTaskId()`
  4. Calls `intakeService.intake(candidateId)` for each candidate
- `autoIntakeEnabled: false` (HG-4 debug mode — chain runs, no ledger entries)
- No `createRun()` call — runner manages run lifecycle via `acquireLease()`
- Export added to `runtime-v2/index.ts`

### 2. EvolutionReducerImpl.on() method (openclaw-plugin)

**File**: `packages/openclaw-plugin/src/core/evolution-reducer.ts`

- Added `private readonly _painCallbacks: Array<(event: EvolutionLoopEvent) => void>` field
- Added `on(callback)` method for registering pain_detected callbacks
- `_painCallbacks` invoked in `applyEvent()` for `pain_detected` case (fire-and-forget, resilient to errors)

### 3. PainSignalBridge wiring (openclaw-plugin)

**File**: `packages/openclaw-plugin/src/hooks/pain.ts`

- Lazy per-workspace `PainSignalBridge` cache (`painSignalBridges` Map)
- `getPainSignalBridge(wctx)` async function creates bridge with all runtime-v2 dependencies:
  - `RuntimeStateManager` with `initialize()` called before use
  - `SqliteConnection`, `SqliteHistoryQuery`, `SqliteDiagnosticianCommitter`, `DefaultDiagnosticianValidator`
  - `SqliteContextAssembler` (taskStore + historyQuery + runStore)
  - `OpenClawCliRuntimeAdapter` (runtimeMode: 'local')
  - `DiagnosticianRunner` (owner: 'pain-signal-bridge', runtimeKind: 'openclaw-cli')
  - `PrincipleTreeLedgerAdapter` + `CandidateIntakeService`
- `emitPainDetectedEvent()` now calls bridge after emitting (fire-and-forget)
- No WorkspaceContext mutation (no `_painSignalBridge` field, no `setPainSignalBridge` method)

### 4. Removed legacy .bak file

- Deleted `evolution-worker.ts.bak` (contained legacy heartbeat diagnostician code)

## Verification

```
✅ npm run verify:merge — PASSES (0 errors, 2 warnings)
   Warnings: unused 'e' in _painCallbacks catch (acceptable)
             unused 'EventLogService' in prompt.ts (pre-existing)
✅ No WorkspaceContext mutation (rg setPainSignalBridge|runtimeV2|_painSignalBridge → ZERO_RESULTS)
✅ PainSignalBridge wired in pain.ts via getPainSignalBridge()
✅ PainSignalBridge exported from runtime-v2/index.ts
✅ LEGACY PATH CHECK (VERIFY-01):
   - diagnostician_tasks.json: only in comments/tests (not execution path)
   - evolution_complete_: only in .bak file (deleted)
   - .diagnostician_report_: only in .bak file (deleted)
   - PD_LEGACY_PROMPT_DIAGNOSTICIAN_ENABLED: only in tests (not execution path)
   - <diagnostician_task>: only in tests (not execution path)
```

## Key architectural notes

- Bridge is created lazily on first pain_detected event per workspace
- `autoIntakeEnabled: false` means no ledger entries are created in debug mode (HG-4)
- Bridge errors are caught and logged via `SystemLogger` — do not propagate
- OpenClawCliRuntimeAdapter uses `runtimeMode: 'local'` — requires openclaw-cli in PATH
- `stateManager.initialize()` must be called before accessing `taskStore`/`runStore` getters
