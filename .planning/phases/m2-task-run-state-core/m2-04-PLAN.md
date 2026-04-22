---
phase: m2
plan: 04
title: Recovery Sweep
wave: 4
type: execute
depends_on:
  - m2-03
autonomous: true
files_modified:
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
  - packages/principles-core/src/runtime-v2/index.ts
requirements_addressed:
  - REQ-M2-Recovery
---

<objective>
Implement expired lease recovery sweep: detect expired leases, recover tasks to pending/retry_wait, emit telemetry events, idempotent operation.
</objective>

<tasks>

## Task 1: Implement RecoverySweep
type: execute
files:
  - packages/principles-core/src/runtime-v2/store/recovery-sweep.ts
  - packages/principles-core/src/runtime-v2/store/task-store.ts
  - packages/principles-core/src/runtime-v2/store/lease-manager.ts
  - packages/principles-core/src/runtime-v2/task-status.ts
  - packages/principles-core/src/telemetry-event.ts
<read_first>
- `packages/principles-core/src/runtime-v2/task-status.ts` — PDTaskStatus, TaskRecord (DO NOT MODIFY)
- `packages/principles-core/src/telemetry-event.ts` — TelemetryEvent pattern to follow
- `packages/principles-core/src/runtime-v2/store/task-store.ts` — TaskStore interface
- `packages/principles-core/src/runtime-v2/store/lease-manager.ts` — LeaseManager (Plan 03 output)
- `packages/principles-core/src/runtime-v2/store/retry-policy.ts` — RetryPolicy (Plan 03 output)
</read_first>
<action>
Create `packages/principles-core/src/runtime-v2/store/recovery-sweep.ts`:

```typescript
import type { TaskStore } from './task-store.js';
import type { LeaseManager } from './lease-manager.js';
import type { RetryPolicy } from './retry-policy.js';
import type { TaskRecord, PDTaskStatus, PDErrorCategory } from '../task-status.js';

export interface RecoveryResult {
  taskId: string;
  recoveredAt: string;
  previousStatus: PDTaskStatus;
  newStatus: PDTaskStatus;
  wasLeaseExpired: boolean;
}

export interface RecoverySweep {
  detectExpiredLeases(): Promise<string[]>;
  recoverTask(taskId: string): Promise<RecoveryResult | null>;
  recoverAll(): Promise<{ recovered: number; errors: string[] }>;
}

export class DefaultRecoverySweep implements RecoverySweep {
  constructor(
    private taskStore: TaskStore,
    private leaseManager: LeaseManager,
    private retryPolicy: RetryPolicy
  ) {}

  async detectExpiredLeases(): Promise<string[]> {
    const tasks = await this.taskStore.listTasks({ status: 'leased' });
    return tasks
      .filter(task => this.leaseManager.isLeaseExpired(task))
      .map(task => task.taskId);
  }

  async recoverTask(taskId: string): Promise<RecoveryResult | null> {
    const task = await this.taskStore.getTask(taskId);
    if (!task) return null;

    const wasLeaseExpired = this.leaseManager.isLeaseExpired(task);
    if (!wasLeaseExpired) return null;

    const previousStatus = task.status;
    let newStatus: PDTaskStatus;

    if (this.retryPolicy.shouldRetry(task)) {
      const backoffMs = this.retryPolicy.calculateBackoff(task.attemptCount + 1);
      const retryExpiresAt = new Date(Date.now() + backoffMs).toISOString();
      await this.taskStore.updateTask(taskId, {
        status: 'retry_wait',
        leaseOwner: undefined,
        leaseExpiresAt: retryExpiresAt,
        lastError: 'lease_expired',
      });
      newStatus = 'retry_wait';
    } else {
      await this.taskStore.updateTask(taskId, {
        status: 'failed',
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: 'max_attempts_exceeded',
      });
      newStatus = 'failed';
    }

    this.emitTelemetryEvent({
      eventType: 'lease_recovered',
      traceId: taskId,
      timestamp: new Date().toISOString(),
      sessionId: 'system',
      payload: { taskId, previousStatus, newStatus },
    });

    return {
      taskId,
      recoveredAt: new Date().toISOString(),
      previousStatus,
      newStatus,
      wasLeaseExpired,
    };
  }

  async recoverAll(): Promise<{ recovered: number; errors: string[] }> {
    const expiredIds = await this.detectExpiredLeases();
    let recovered = 0;
    const errors: string[] = [];

    for (const taskId of expiredIds) {
      try {
        const result = await this.recoverTask(taskId);
        if (result) recovered++;
      } catch (err) {
        errors.push(`${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { recovered, errors };
  }

  private emitTelemetryEvent(event: {
    eventType: string;
    traceId: string;
    timestamp: string;
    sessionId: string;
    payload: Record<string, unknown>;
  }): void {
    // Emit via console.log in structured format for now
    // In production, this would use the existing TelemetryEvent system
    console.log(JSON.stringify({ type: 'telemetry_event', event }));
  }
}
```
</action>
<acceptance_criteria>
- [ ] `detectExpiredLeases` queries tasks with status='leased' and filters by isLeaseExpired
- [ ] `recoverTask` is idempotent — returns null if task not leased or not expired
- [ ] `recoverTask` transitions to retry_wait if attempts remain
- [ ] `recoverTask` transitions to failed if maxAttempts exceeded
- [ ] `recoverTask` sets lastError to 'lease_expired' or 'max_attempts_exceeded'
- [ ] `recoverAll` calls detectExpiredLeases then recoverTask for each
- [ ] `recoverAll` collects errors without stopping recovery of other tasks
- [ ] Telemetry event emitted on every recovery
- [ ] Recovery is idempotent — safe to run multiple times
</acceptance_criteria>

## Task 2: Export RecoverySweep from runtime-v2/index.ts
type: execute
files:
  - packages/principles-core/src/runtime-v2/index.ts
<read_first>
- `packages/principles-core/src/runtime-v2/index.ts` — Barrel exports (M1 frozen — add only new exports)
</read_first>
<action>
Add to the exports in `packages/principles-core/src/runtime-v2/index.ts`:

```typescript
// Lease & Recovery
export { DefaultLeaseManager } from './store/lease-manager.js';
export type { LeaseManager, AcquireLeaseOptions } from './store/lease-manager.js';
export { DefaultRetryPolicy } from './store/retry-policy.js';
export type { RetryPolicy, RetryPolicyConfig } from './store/retry-policy.js';
export { DefaultRecoverySweep } from './store/recovery-sweep.js';
export type { RecoverySweep, RecoveryResult } from './store/recovery-sweep.js';
```
</action>
<acceptance_criteria>
- [ ] `DefaultLeaseManager` is exported
- [ ] `LeaseManager` and `AcquireLeaseOptions` types are exported
- [ ] `DefaultRetryPolicy` is exported
- [ ] `RetryPolicy` and `RetryPolicyConfig` types are exported
- [ ] `DefaultRecoverySweep` is exported
- [ ] `RecoverySweep` and `RecoveryResult` types are exported
- [ ] `npx tsc --noEmit` passes for packages/principles-core
</acceptance_criteria>

</tasks>

<verification>
1. Run `npx tsc --noEmit` in packages/principles-core
2. Verify `recoverTask` is idempotent — grep for "wasLeaseExpired" guard
3. Verify `recoverAll` uses detectExpiredLeases — grep for "detectExpiredLeases"
4. Verify telemetry event emitted — grep for "emitTelemetryEvent"
5. Verify retry_wait vs failed branch — grep for "shouldRetry"
</verification>

<success_criteria>
- [ ] RecoverySweep detects expired leases correctly
- [ ] Recovery transitions to retry_wait when attempts remain
- [ ] Recovery transitions to failed when maxAttempts exceeded
- [ ] Recovery emits telemetry event for each recovered task
- [ ] Recovery is idempotent (safe to run multiple times)
- [ ] All new exports added to runtime-v2/index.ts
- [ ] TypeScript compiles without errors
</success_criteria>
