# m2-07 SUMMARY — Runtime Integration + Event Emission + CLI Inspection

## Status: ✅ COMPLETE

## What Was Done

### 1. Telemetry Event Expansion (`telemetry-event.ts`)
- Added 8 new event types for M2 task/run lifecycle:
  - `lease_acquired`, `lease_released`, `lease_renewed`, `lease_expired`
  - `task_retried`, `task_failed`, `task_succeeded`
  - `run_started`, `run_completed`
- Validated with `validateTelemetryEvent` helper

### 2. EventEmitter Infrastructure (`event-emitter.ts`)
- `StoreEventEmitter` class that wraps Node's `EventEmitter` with `TelemetryEvent` validation.
- `storeEmitter` singleton exported for shared use.

### 3. Runtime Integration Layer (`runtime-state-manager.ts`)
- `RuntimeStateManager` class created as the single entry point for task/run state.
- Wires all M2 components: `SqliteConnection`, `SqliteTaskStore`, `SqliteRunStore`, `DefaultLeaseManager`, `DefaultRetryPolicy`, and `DefaultRecoverySweep`.
- Provides atomic `markTaskSucceeded` and `markTaskFailed` helpers that emit telemetry.

### 4. Event Emission Wiring
- `LeaseManager` now emits: `lease_acquired`, `lease_released`, `lease_renewed`, `lease_expired`.
- `RecoverySweep` now emits: `task_retried` and `task_failed`.

### 5. CLI Inspection Commands (`pd-cli`)
- `pd task list`: lists tasks with status, attempts, and lease info.
- `pd task show <taskId>`: shows full task details and its runs.
- `pd run list <taskId>`: lists all runs for a task.
- `pd run show <runId>`: shows full run details including duration and error category.
- Commands integrated into `pd-cli/src/index.ts`.

## Bug Fixes
- **isLeaseExpired Instance Method**: Fixed `TypeError: leaseManager.isLeaseExpired is not a function` by removing the `static` keyword in `DefaultLeaseManager`. This allows both tests and `RecoverySweep` to call the method on instances.

## Test Results
- All tests pass (185 tests, 17 test files).
- `npx tsc --noEmit` passes for both `principles-core` and `pd-cli`.

## Files Changed
- `packages/principles-core/src/runtime-v2/store/event-emitter.ts` (new)
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` (new)
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` (emitter and events added, fixed static)
- `packages/principles-core/src/runtime-v2/store/recovery-sweep.ts` (emitter and events added)
- `packages/principles-core/src/telemetry-event.ts` (new events added)
- `packages/principles-core/src/runtime-v2/index.ts` (re-exports added)
- `packages/pd-cli/src/commands/task.ts` (new)
- `packages/pd-cli/src/commands/run.ts` (new)
- `packages/pd-cli/src/index.ts` (commands registered)
