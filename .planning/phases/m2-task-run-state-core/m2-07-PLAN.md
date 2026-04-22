---
phase: m2-task-run-state-core
plan: m2-07
title: Runtime Integration + Event Emission + CLI Inspection
wave: 1
type: execute
depends_on:
  - m2-01
  - m2-02
  - m2-03
  - m2-04
  - m2-05
  - m2-06
autonomous: true
files_modified:
  - packages/principles-core/src/runtime-v2/store/event-emitter.ts
  - packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts
  - packages/principles-core/src/runtime-v2/store/lease-manager.ts
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
  - packages/principles-core/src/telemetry-event.ts
  - packages/principles-core/src/runtime-v2/index.ts
  - packages/pd-cli/src/commands/task.ts
  - packages/pd-cli/src/commands/run.ts
  - packages/pd-cli/src/index.ts
requirements_addressed:
  - REQ-M2-TaskStore
  - REQ-M2-RunStore
  - REQ-M2-Lease
  - REQ-M2-Retry
  - REQ-M2-Recovery
---

<objective>
Wire M2 store components into a RuntimeStateManager integration layer with event emission on all state transitions, and add CLI inspection commands (task list/show, run list/show) for debugging and manual intervention.
</objective>

<context>
@packages/principles-core/src/runtime-v2/store/lease-manager.ts
@packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
@packages/principles-core/src/runtime-v2/store/sqlite-task-store.ts
@packages/principles-core/src/runtime-v2/store/sqlite-run-store.ts
@packages/principles-core/src/telemetry-event.ts
@packages/pd-cli/src/index.ts
</context>

<tasks>

## Task 1: Extend TelemetryEvent schema with M2 state transition events and create EventEmitter infrastructure
type: execute
files:
  - packages/principles-core/src/telemetry-event.ts
  - packages/principles-core/src/runtime-v2/store/event-emitter.ts
<read_first>
- `packages/principles-core/src/telemetry-event.ts` — Existing TelemetryEvent schema (DO NOT MODIFY existing event types)
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` — State transitions to emit events for
- `packages/principles-core/src/runtime-v2/store/recovery-sweep.ts` — Recovery events to emit
</read_first>
<action>
**Step 1a:** Add M2 state transition event types to `telemetry-event.ts`. Add these new event types to the `TelemetryEventType` union (DO NOT modify existing types):

```typescript
// M2 Store Events — extend the union
export const TelemetryEventType = Type.Union([
  Type.Literal('pain_detected'),
  Type.Literal('principle_candidate_created'),
  Type.Literal('principle_promoted'),
  // M2: Task/Run state transition events
  Type.Literal('lease_acquired'),
  Type.Literal('lease_released'),
  Type.Literal('lease_renewed'),
  Type.Literal('lease_expired'),
  Type.Literal('task_retried'),
  Type.Literal('task_failed'),
  Type.Literal('task_succeeded'),
  Type.Literal('run_started'),
  Type.Literal('run_completed'),
]);
```

**Step 1b:** Create `packages/principles-core/src/runtime-v2/store/event-emitter.ts`:

```typescript
import { EventEmitter } from 'events';
import { validateTelemetryEvent, type TelemetryEvent } from '../../telemetry-event.js';

/**
 * Typed event emitter for M2 store state transitions.
 * Wraps Node's EventEmitter with TelemetryEvent validation.
 */
export class StoreEventEmitter extends EventEmitter {
  /**
   * Emit a telemetry event after validating it conforms to TelemetryEventSchema.
   * Returns true if the event was validated and emitted, false if validation failed.
   */
  emitTelemetry(event: TelemetryEvent): boolean {
    const result = validateTelemetryEvent(event);
    if (!result.valid) {
      console.error('[StoreEventEmitter] Invalid telemetry event:', result.errors);
      return false;
    }
    // Also emit on the generic 'event' channel for generic handlers
    this.emit('telemetry', result.event);
    // Emit on the specific eventType channel for typed handlers
    this.emit(result.event!.eventType, result.event!);
    return true;
  }

  /**
   * Subscribe to all telemetry events.
   */
  onTelemetry(handler: (event: TelemetryEvent) => void): void {
    this.on('telemetry', handler);
  }

  /**
   * Subscribe to a specific event type.
   */
  onEventType(eventType: string, handler: (event: TelemetryEvent) => void): void {
    this.on(eventType, handler);
  }
}

/**
 * Singleton event emitter for the store layer.
 * Modules can import and use this shared emitter for cross-cutting telemetry.
 */
export const storeEmitter = new StoreEventEmitter();
```

**Step 1c:** Add exports to `packages/principles-core/src/runtime-v2/index.ts`:

```typescript
// Event emitter
export { StoreEventEmitter, storeEmitter } from './store/event-emitter.js';
export type { TelemetryEvent } from '../telemetry-event.js';
```
</action>
<acceptance_criteria>
- [ ] TelemetryEventType union has 11 event types (3 original + 8 M2 events)
- [ ] StoreEventEmitter extends EventEmitter
- [ ] emitTelemetry calls validateTelemetryEvent before emitting
- [ ] storeEmitter singleton is exported
- [ ] `npx tsc --noEmit` passes for principles-core
</acceptance_criteria>

## Task 2: Wire event emission into LeaseManager state transitions
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/lease-manager.ts
  - packages/principles-core/src/runtime-v2/store/event-emitter.ts
  - packages/principles-core/src/runtime-v2/index.ts
<read_first>
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` — acquireLease, releaseLease, renewLease, forceExpire methods
- `packages/principles-core/src/runtime-v2/store/event-emitter.ts` — StoreEventEmitter API
</read_first>
<action>
Modify `lease-manager.ts` to accept a `StoreEventEmitter` and emit events on all state transitions:

**Step 2a:** Add emitter parameter to `DefaultLeaseManager` constructor:

```typescript
import { storeEmitter } from './event-emitter.js';

export interface LeaseManagerOptions {
  taskStore: TaskStore;
  runStore: RunStore;
  connection: SqliteConnection;
  emitter?: StoreEventEmitter; // optional — defaults to storeEmitter singleton
}

export class DefaultLeaseManager implements LeaseManager {
  private readonly emitter: StoreEventEmitter;

  constructor(private options: LeaseManagerOptions) {
    this.emitter = options.emitter ?? storeEmitter;
    // ... existing initialization
  }
```

**Step 2b:** In `acquireLease`, after successfully acquiring the lease, emit `lease_acquired` event:

```typescript
// After: const task = await this.options.taskStore.updateTask(...)
this.emitter.emitTelemetry({
  eventType: 'lease_acquired',
  traceId: taskId,
  timestamp: new Date().toISOString(),
  sessionId: owner,
  payload: {
    taskId,
    owner,
    durationMs,
    runtimeKind,
    attemptNumber: task.attemptCount,
  },
});
```

**Step 2c:** In `releaseLease`, after successfully releasing, emit `lease_released`:

```typescript
this.emitter.emitTelemetry({
  eventType: 'lease_released',
  traceId: taskId,
  timestamp: new Date().toISOString(),
  sessionId: owner,
  payload: {
    taskId,
    owner,
    executionStatus: task.status, // 'pending' after release
  },
});
```

**Step 2d:** In `renewLease`, emit `lease_renewed`:

```typescript
this.emitter.emitTelemetry({
  eventType: 'lease_renewed',
  traceId: taskId,
  timestamp: new Date().toISOString(),
  sessionId: owner,
  payload: {
    taskId,
    owner,
    newExpiresAt: task.leaseExpiresAt,
  },
});
```

**Step 2e:** In `forceExpire`, emit `lease_expired`:

```typescript
this.emitter.emitTelemetry({
  eventType: 'lease_expired',
  traceId: taskId,
  timestamp: new Date().toISOString(),
  sessionId: 'system',
  payload: {
    taskId,
    reason: 'force_expire',
  },
});
```

**Step 2f:** In `markTaskSucceeded` (if it exists) or when setting status to 'succeeded', emit `task_succeeded`:

```typescript
this.emitter.emitTelemetry({
  eventType: 'task_succeeded',
  traceId: taskId,
  timestamp: new Date().toISOString(),
  sessionId: owner ?? 'system',
  payload: { taskId, resultRef: task.resultRef },
});
```

**Step 2g:** In `markTaskFailed` (if it exists) or when setting status to 'failed', emit `task_failed`:

```typescript
this.emitter.emitTelemetry({
  eventType: 'task_failed',
  traceId: taskId,
  timestamp: new Date().toISOString(),
  sessionId: owner ?? 'system',
  payload: { taskId, lastError: task.lastError, attemptCount: task.attemptCount },
});
```

Note: Use optional chaining and nullish coalescing for owner/sessionId fields since some methods may be called without an owner context.
</action>
<acceptance_criteria>
- [ ] DefaultLeaseManager constructor accepts optional emitter parameter
- [ ] acquireLease emits 'lease_acquired' event with taskId, owner, durationMs, runtimeKind, attemptNumber
- [ ] releaseLease emits 'lease_released' event with taskId, owner, executionStatus
- [ ] renewLease emits 'lease_renewed' event with taskId, owner, newExpiresAt
- [ ] forceExpire emits 'lease_expired' event with taskId, reason
- [ ] markTaskSucceeded emits 'task_succeeded' event
- [ ] markTaskFailed emits 'task_failed' event with lastError, attemptCount
- [ ] `npx tsc --noEmit` passes for principles-core
</acceptance_criteria>

## Task 3: Create RuntimeStateManager — integration layer wiring all M2 components
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts
  - packages/principles-core/src/runtime-v2/store/lease-manager.ts
  - packages/principles-core/src/runtime-v2/store/retry-policy.ts
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
  - packages/principles-core/src/runtime-v2/index.ts
<read_first>
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` — DefaultLeaseManager API
- `packages/principles-core/src/runtime-v2/store/retry-policy.ts` — DefaultRetryPolicy API
- `packages/principles-core/src/runtime-v2/store/recovery-sweep.ts` — DefaultRecoverySweep API
- `packages/principles-core/src/runtime-v2/store/task-store.ts` — TaskStore interface
- `packages/principles-core/src/runtime-v2/store/run-store.ts` — RunStore interface
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts`:

```typescript
import type { SqliteConnection } from './sqlite-connection.js';
import type { TaskStore, TaskStoreFilter } from './task-store.js';
import type { RunStore } from './run-store.js';
import type { LeaseManager, AcquireLeaseOptions } from './lease-manager.js';
import type { RetryPolicy, RetryPolicyConfig } from './retry-policy.js';
import type { RecoverySweep, RecoveryResult } from './recovery-sweep.js';
import type { TaskRecord } from '../task-status.js';
import type { RunRecord } from './run-store.js';
import { storeEmitter, type StoreEventEmitter } from './event-emitter.js';

export interface RuntimeStateManagerOptions {
  workspaceDir: string;
  emitter?: StoreEventEmitter;
  retryPolicyConfig?: RetryPolicyConfig;
}

export interface TaskSummary {
  taskId: string;
  taskKind: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
}

/**
 * RuntimeStateManager — Integration layer wiring all M2 store components.
 * 
 * This is the single entry point for the PD CLI and diagnostician runner to interact
 * with task/run state. It owns the lifecycle of:
 * - SqliteConnection (shared by TaskStore + RunStore)
 * - SqliteTaskStore + SqliteRunStore
 * - DefaultLeaseManager
 * - DefaultRetryPolicy
 * - DefaultRecoverySweep
 * 
 * Usage:
 * ```typescript
 * const stateManager = new RuntimeStateManager({ workspaceDir: process.cwd() });
 * await stateManager.initialize();
 * 
 * // Acquire a lease
 * const task = await stateManager.acquireLease({
 *   taskId: 'my-task',
 *   owner: 'diagnostician-1',
 *   durationMs: 300_000,
 *   runtimeKind: 'openclaw',
 * });
 * 
 * // Release on completion
 * await stateManager.releaseLease('my-task', 'diagnostician-1');
 * 
 * // On shutdown
 * await stateManager.close();
 * ```
 */
export class RuntimeStateManager {
  private connection!: SqliteConnection;
  private taskStore!: TaskStore;
  private runStore!: RunStore;
  private leaseManager!: LeaseManager;
  private retryPolicy!: RetryPolicy;
  private recoverySweep!: RecoverySweep;
  private _initialized = false;

  constructor(private options: RuntimeStateManagerOptions) {}

  /**
   * Initialize all store components. Must be called before any other method.
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    const emitter = this.options.emitter ?? storeEmitter;

    // Create shared connection
    this.connection = new SqliteConnection(this.options.workspaceDir);

    // Create stores
    this.taskStore = new (await import('./sqlite-task-store.js')).SqliteTaskStore(this.connection);
    this.runStore = new (await import('./sqlite-run-store.js')).SqliteRunStore(this.connection);

    // Create retry policy
    this.retryPolicy = new (await import('./retry-policy.js')).DefaultRetryPolicy(
      this.options.retryPolicyConfig ?? {
        baseDelayMs: 30_000,
        maxDelayMs: 60_000,
        multiplier: 2,
        jitterFactor: 0.2,
      }
    );

    // Create lease manager with emitter
    const { DefaultLeaseManager } = await import('./lease-manager.js');
    this.leaseManager = new DefaultLeaseManager({
      taskStore: this.taskStore,
      runStore: this.runStore,
      connection: this.connection,
      emitter,
    });

    // Create recovery sweep
    const { DefaultRecoverySweep } = await import('./recovery-sweep.js');
    this.recoverySweep = new DefaultRecoverySweep(this.taskStore, this.leaseManager, this.retryPolicy);

    this._initialized = true;
  }

  /**
   * Check if initialized.
   */
  get isInitialized(): boolean {
    return this._initialized;
  }

  // -------------------------------------------------------------------------
  // Task operations
  // -------------------------------------------------------------------------

  /**
   * Create a new task.
   */
  async createTask(record: Omit<TaskRecord, 'createdAt' | 'updatedAt'>): Promise<TaskRecord> {
    this.assertInitialized();
    return this.taskStore.createTask(record);
  }

  /**
   * Get a task by ID.
   */
  async getTask(taskId: string): Promise<TaskRecord | null> {
    this.assertInitialized();
    return this.taskStore.getTask(taskId);
  }

  /**
   * List tasks with optional filter.
   */
  async listTasks(filter?: TaskStoreFilter): Promise<TaskRecord[]> {
    this.assertInitialized();
    return this.taskStore.listTasks(filter);
  }

  /**
   * Update task fields.
   */
  async updateTask(taskId: string, patch: Parameters<TaskStore['updateTask']>[1]): Promise<TaskRecord> {
    this.assertInitialized();
    return this.taskStore.updateTask(taskId, patch);
  }

  /**
   * Delete a task.
   */
  async deleteTask(taskId: string): Promise<boolean> {
    this.assertInitialized();
    return this.taskStore.deleteTask(taskId);
  }

  // -------------------------------------------------------------------------
  // Run operations
  // -------------------------------------------------------------------------

  /**
   * Get runs for a task.
   */
  async getRunsByTask(taskId: string): Promise<RunRecord[]> {
    this.assertInitialized();
    return this.runStore.listRunsByTask(taskId);
  }

  /**
   * Get a specific run.
   */
  async getRun(runId: string): Promise<RunRecord | null> {
    this.assertInitialized();
    return this.runStore.getRun(runId);
  }

  // -------------------------------------------------------------------------
  // Lease operations
  // -------------------------------------------------------------------------

  /**
   * Acquire a lease on a task.
   */
  async acquireLease(options: AcquireLeaseOptions): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.acquireLease(options);
  }

  /**
   * Release a lease on a task.
   */
  async releaseLease(taskId: string, owner: string): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.releaseLease(taskId, owner);
  }

  /**
   * Renew an existing lease.
   */
  async renewLease(taskId: string, owner: string, durationMs?: number): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.renewLease(taskId, owner, durationMs);
  }

  /**
   * Force-expire a lease (system recovery).
   */
  async forceExpireLease(taskId: string): Promise<TaskRecord> {
    this.assertInitialized();
    return this.leaseManager.forceExpire(taskId);
  }

  /**
   * Check if a task's lease is expired.
   */
  isLeaseExpired(task: TaskRecord): boolean {
    return this.leaseManager.isLeaseExpired(task);
  }

  // -------------------------------------------------------------------------
  // Retry/Recovery operations
  // -------------------------------------------------------------------------

  /**
   * Run recovery sweep — recover all expired leases.
   */
  async runRecoverySweep(): Promise<RecoveryResult> {
    this.assertInitialized();
    return this.recoverySweep.recoverAll();
  }

  /**
   * Get retry policy instance.
   */
  getRetryPolicy(): RetryPolicy {
    return this.retryPolicy;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close the state manager and release resources.
   */
  async close(): Promise<void> {
    if (this.connection) {
      this.connection.close();
    }
    this._initialized = false;
  }

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new Error('RuntimeStateManager not initialized — call initialize() first');
    }
  }
}
```

**Step 3b:** Export from `runtime-v2/index.ts`:

```typescript
// Runtime integration layer
export { RuntimeStateManager } from './store/runtime-state-manager.js';
export type { RuntimeStateManagerOptions, TaskSummary } from './store/runtime-state-manager.js';
```
</action>
<acceptance_criteria>
- [ ] RuntimeStateManager class exists in runtime-state-manager.ts
- [ ] constructor accepts workspaceDir and optional emitter/retryPolicyConfig
- [ ] initialize() creates all store components in correct dependency order
- [ ] close() calls connection.close()
- [ ] All task store operations (createTask, getTask, listTasks, updateTask, deleteTask) are wired
- [ ] All run store operations (getRunsByTask, getRun) are wired
- [ ] All lease operations (acquireLease, releaseLease, renewLease, forceExpireLease, isLeaseExpired) are wired
- [ ] runRecoverySweep() delegates to recoverySweep.recoverAll()
- [ ] getRetryPolicy() returns the retryPolicy instance
- [ ] assertInitialized() throws if not initialized
- [ ] RuntimeStateManager exported from runtime-v2/index.ts
- [ ] `npx tsc --noEmit` passes for principles-core
</acceptance_criteria>

## Task 4: Add CLI inspection commands — task list/show, run list/show
type: execute
files:
  - packages/pd-cli/src/commands/task.ts
  - packages/pd-cli/src/commands/run.ts
  - packages/pd-cli/src/index.ts
<read_first>
- `packages/pd-cli/src/index.ts` — Existing CLI structure (commander setup)
- `packages/pd-cli/src/commands/` — Existing command files for pattern reference
- `packages/principles-core/src/runtime-v2/store/runtime-state-manager.ts` — RuntimeStateManager API
</read_first>
<action>
**Step 4a:** Create `packages/pd-cli/src/commands/task.ts`:

```typescript
import { Command } from 'commander';
import { resolveWorkspace } from '../resolve-workspace.js';
import { RuntimeStateManager } from '@principles/core';

export function createTaskCommand(): Command {
  const cmd = new Command('task');
  cmd.description('Task inspection and management commands');

  // pd task list [--status <status>] [--kind <kind>]
  cmd
    .command('list')
    .description('List all tasks')
    .option('-s, --status <status>', 'Filter by status (pending, leased, retry_wait, succeeded, failed)')
    .option('-k, --kind <kind>', 'Filter by task kind')
    .option('-l, --limit <limit>', 'Limit number of results', '50')
    .action(async (opts) => {
      const workspaceDir = resolveWorkspace();
      const stateManager = new RuntimeStateManager({ workspaceDir });
      await stateManager.initialize();

      try {
        const filter: any = {};
        if (opts.status) filter.status = opts.status;
        if (opts.kind) filter.taskKind = opts.kind;
        if (opts.limit) filter.limit = parseInt(opts.limit, 10);

        const tasks = await stateManager.listTasks(filter);

        if (tasks.length === 0) {
          console.log('No tasks found.');
          return;
        }

        console.log(`\nTasks (${tasks.length}):\n`);
        console.log(
          '%s %-12s %-10s %-6s/%-6s %-15s %s',
          'TASK_ID',
          'KIND',
          'STATUS',
          'ATT',
          'MAX',
          'LEASE_OWNER',
          'LEASE_EXPIRES'
        );
        console.log('-'.repeat(90));

        for (const task of tasks) {
          const expiresAt = task.leaseExpiresAt
            ? new Date(task.leaseExpiresAt).toLocaleString()
            : '-';
          console.log(
            '%s %-12s %-10s %-6s %-6s %-15s %s',
            task.taskId.substring(0, 20),
            task.taskKind.substring(0, 12),
            task.status,
            task.attemptCount,
            task.maxAttempts,
            task.leaseOwner ?? '-',
            expiresAt.substring(0, 15)
          );
        }
        console.log('');
      } finally {
        await stateManager.close();
      }
    });

  // pd task show <taskId>
  cmd
    .command('show <taskId>')
    .description('Show detailed task information')
    .action(async (taskId) => {
      const workspaceDir = resolveWorkspace();
      const stateManager = new RuntimeStateManager({ workspaceDir });
      await stateManager.initialize();

      try {
        const task = await stateManager.getTask(taskId);

        if (!task) {
          console.error(`Task not found: ${taskId}`);
          process.exit(1);
        }

        console.log(`\nTask: ${task.taskId}\n`);
        console.log(`  Kind:         ${task.taskKind}`);
        console.log(`  Status:       ${task.status}`);
        console.log(`  Attempts:      ${task.attemptCount} / ${task.maxAttempts}`);
        if (task.leaseOwner) {
          console.log(`  Lease Owner:  ${task.leaseOwner}`);
          console.log(`  Lease Expires:${task.leaseExpiresAt ? new Date(task.leaseExpiresAt).toLocaleString() : '-'}`);
        }
        if (task.lastError) {
          console.log(`  Last Error:   ${task.lastError}`);
        }
        if (task.inputRef) {
          console.log(`  Input Ref:    ${task.inputRef}`);
        }
        if (task.resultRef) {
          console.log(`  Result Ref:   ${task.resultRef}`);
        }
        console.log(`  Created:      ${new Date(task.createdAt).toLocaleString()}`);
        console.log(`  Updated:      ${new Date(task.updatedAt).toLocaleString()}`);
        console.log('');

        // Also show runs for this task
        const runs = await stateManager.getRunsByTask(taskId);
        if (runs.length > 0) {
          console.log(`Runs (${runs.length}):`);
          console.log('  %s %-12s %-12s %-10s %s', 'RUN_ID', 'STATUS', 'STARTED', 'ATTEMPT', 'ENDED');
          console.log('  ' + '-'.repeat(65));
          for (const run of runs) {
            console.log(
              '  %s %-12s %-12s %-10s %s',
              run.runId.substring(0, 20),
              run.executionStatus,
              new Date(run.startedAt).toLocaleString().substring(0, 12),
              run.attemptNumber,
              run.endedAt ? new Date(run.endedAt).toLocaleString().substring(0, 12) : '-'
            );
          }
          console.log('');
        }
      } finally {
        await stateManager.close();
      }
    });

  return cmd;
}
```

**Step 4b:** Create `packages/pd-cli/src/commands/run.ts`:

```typescript
import { Command } from 'commander';
import { resolveWorkspace } from '../resolve-workspace.js';
import { RuntimeStateManager } from '@principles/core';

export function createRunCommand(): Command {
  const cmd = new Command('run');
  cmd.description('Run inspection commands');

  // pd run list <taskId>
  cmd
    .command('list <taskId>')
    .description('List all runs for a task')
    .action(async (taskId) => {
      const workspaceDir = resolveWorkspace();
      const stateManager = new RuntimeStateManager({ workspaceDir });
      await stateManager.initialize();

      try {
        const runs = await stateManager.getRunsByTask(taskId);

        if (runs.length === 0) {
          console.log(`No runs found for task: ${taskId}`);
          return;
        }

        console.log(`\nRuns for ${taskId} (${runs.length}):\n`);
        console.log('  %s %-12s %-20s %-10s %s', 'RUN_ID', 'STATUS', 'STARTED', 'ATTEMPT', 'ENDED');
        console.log('  ' + '-'.repeat(75));

        for (const run of runs) {
          console.log(
            '  %s %-12s %-20s %-10s %s',
            run.runId.substring(0, 20),
            run.executionStatus,
            new Date(run.startedAt).toLocaleString(),
            run.attemptNumber,
            run.endedAt ? new Date(run.endedAt).toLocaleString() : '-'
          );
        }
        console.log('');
      } finally {
        await stateManager.close();
      }
    });

  // pd run show <runId>
  cmd
    .command('show <runId>')
    .description('Show detailed run information')
    .action(async (runId) => {
      const workspaceDir = resolveWorkspace();
      const stateManager = new RuntimeStateManager({ workspaceDir });
      await stateManager.initialize();

      try {
        const run = await stateManager.getRun(runId);

        if (!run) {
          console.error(`Run not found: ${runId}`);
          process.exit(1);
        }

        console.log(`\nRun: ${run.runId}\n`);
        console.log(`  Task ID:         ${run.taskId}`);
        console.log(`  Runtime Kind:   ${run.runtimeKind}`);
        console.log(`  Status:         ${run.executionStatus}`);
        console.log(`  Attempt Number: ${run.attemptNumber}`);
        console.log(`  Started:        ${new Date(run.startedAt).toLocaleString()}`);
        if (run.endedAt) {
          console.log(`  Ended:          ${new Date(run.endedAt).toLocaleString()}`);
          const duration = new Date(run.endedAt).getTime() - new Date(run.startedAt).getTime();
          console.log(`  Duration:       ${(duration / 1000).toFixed(1)}s`);
        }
        if (run.reason) {
          console.log(`  Reason:         ${run.reason}`);
        }
        if (run.errorCategory) {
          console.log(`  Error Category: ${run.errorCategory}`);
        }
        if (run.outputRef) {
          console.log(`  Output Ref:     ${run.outputRef}`);
        }
        console.log('');
      } finally {
        await stateManager.close();
      }
    });

  return cmd;
}
```

**Step 4c:** Register commands in `packages/pd-cli/src/index.ts`. Add these imports and register the commands:

```typescript
import { createTaskCommand } from './commands/task.js';
import { createRunCommand } from './commands/run.js';

// In the program setup (after existing command registrations):
program.addCommand(createTaskCommand());
program.addCommand(createRunCommand());
```
</action>
<acceptance_criteria>
- [ ] `packages/pd-cli/src/commands/task.ts` exists with list and show subcommands
- [ ] `packages/pd-cli/src/commands/run.ts` exists with list and show subcommands
- [ ] `pd task list` shows all tasks with status, attemptCount, leaseOwner, leaseExpiresAt
- [ ] `pd task show <id>` shows full task details plus its runs
- [ ] `pd run list <taskId>` shows all runs for a task
- [ ] `pd run show <runId>` shows full run details
- [ ] Commands use RuntimeStateManager with proper initialize/close lifecycle
- [ ] resolveWorkspace() is used to find workspace directory
- [ ] `npx tsc --noEmit` passes for pd-cli
</acceptance_criteria>

## Task 5: Wire RecoverySweep event emission
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
  - packages/principles-core/src/runtime-v2/store/event-emitter.ts
<read_first>
- `packages/principles-core/src/runtime-v2/store/recovery-sweep.ts` — recoverTask, recoverAll methods
- `packages/principles-core/src/runtime-v2/store/event-emitter.ts` — StoreEventEmitter API
</read_first>
<action>
Modify `recovery-sweep.ts` to emit `task_retried` events when recovering to retry_wait:

In `recoverTask`, after successfully transitioning a task to `retry_wait` (has attempts remaining):

```typescript
import { storeEmitter } from './event-emitter.js';

// In recoverTask, after updating task to retry_wait:
const backoffMs = this.retryPolicy.calculateBackoff(task.attemptCount);
storeEmitter.emitTelemetry({
  eventType: 'task_retried',
  traceId: taskId,
  timestamp: new Date().toISOString(),
  sessionId: 'system',
  payload: {
    taskId,
    newStatus: 'retry_wait',
    attemptCount: task.attemptCount,
    backoffMs,
    previousLeaseExpired: true,
  },
});
```

Note: RecoverySweep is typically instantiated without constructor-injected emitter in m2-05 tests. Use the `storeEmitter` singleton directly (consistent with how LeaseManager falls back to the singleton).
</action>
<acceptance_criteria>
- [ ] recoverTask emits 'task_retried' event when recovering to retry_wait
- [ ] Payload includes taskId, newStatus, attemptCount, backoffMs, previousLeaseExpired
- [ ] `npx tsc --noEmit` passes for principles-core
</acceptance_criteria>

## Task 6: TypeScript check and verification
type: execute
files:
  - packages/principles-core
  - packages/pd-cli
<read_first>
- `packages/principles-core/tsconfig.json` — TypeScript config
- `packages/pd-cli/tsconfig.json` — TypeScript config
</read_first>
<action>
Run TypeScript checks on both packages:

```bash
cd packages/principles-core && npx tsc --noEmit
cd packages/pd-cli && npx tsc --noEmit
```

Then run the test suite to verify no regressions:

```bash
cd packages/principles-core && npx vitest run --reporter=verbose
```

All checks must pass.
</action>
<acceptance_criteria>
- [ ] `npx tsc --noEmit` passes for principles-core
- [ ] `npx tsc --noEmit` passes for pd-cli
- [ ] `npx vitest run` passes for principles-core (no regressions)
</acceptance_criteria>

</tasks>

<verification>
1. `cd packages/principles-core && npx tsc --noEmit` — must pass
2. `cd packages/pd-cli && npx tsc --noEmit` — must pass
3. `cd packages/principles-core && npx vitest run` — all tests pass (no regressions)
4. Verify RuntimeStateManager exports are correct in runtime-v2/index.ts
5. Verify CLI commands are registered in pd-cli/src/index.ts
</verification>

<success_criteria>
- [ ] StoreEventEmitter with TelemetryEvent validation exists
- [ ] TelemetryEventType union has 11 event types
- [ ] RuntimeStateManager wires all 5 store components (connection, taskStore, runStore, leaseManager, retryPolicy, recoverySweep)
- [ ] LeaseManager emits events on all state transitions (acquire, release, renew, expire, succeed, fail)
- [ ] RecoverySweep emits task_retried event on recovery
- [ ] CLI commands (pd task list, pd task show, pd run list, pd run show) are implemented
- [ ] TypeScript compiles cleanly for both packages
- [ ] All existing tests pass (no regressions)
</success_criteria>

<output>
After completion, create `.planning/phases/m2-task-run-state-core/m2-07-SUMMARY.md`
</output>
