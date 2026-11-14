/**
 * Terminal writes are fenced (SPEC §5.3): `markTaskSucceeded` needs the lease
 * fence and the run to stamp. Host-runtime tests replace `Runner.prototype.run`
 * with a double, so nothing acquires the lease the production runner would
 * hold. The double must acquire it explicitly — weakening the writer to accept
 * an absent fence would remove the protection these tests exist to exercise.
 */
import type { RuntimeStateManager } from '@principles/core/runtime';

export interface FencedCompletionOptions {
  readonly owner?: string;
  readonly runtimeKind?: string;
}

export async function completeTaskAsFencedOwner(
  stateManager: RuntimeStateManager,
  taskId: string,
  resultRef: string | undefined,
  options: FencedCompletionOptions = {},
): Promise<void> {
  const owner = options.owner ?? 'test-scenario-double';
  const lease = await stateManager.acquireLeaseDetailed({
    taskId,
    owner,
    runtimeKind: options.runtimeKind ?? 'test-double',
  });
  await stateManager.markTaskSucceeded(
    taskId,
    resultRef,
    { taskId, owner, leaseGeneration: lease.leaseGeneration },
    lease.runId,
  );
}
