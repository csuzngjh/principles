/**
 * SPEC-PD-PIPELINE-RELIABILITY-AND-EFFICIENCY-001 §5.2 — lease heartbeat.
 *
 * Timers are injected: no test waits on wall-clock time.
 */
import { describe, it, expect, vi } from 'vitest';
import { LeaseHeartbeat } from './lease-heartbeat.js';

interface FakeTimers {
  readonly setTimeoutFn: (handler: () => void, ms: number) => unknown;
  readonly clearTimeoutFn: (handle: unknown) => void;
  readonly fire: (ms?: number) => Promise<void>;
  readonly pendingCount: () => number;
}

function createFakeTimers(): FakeTimers {
  let nextId = 1;
  const pending = new Map<number, { handler: () => void; ms: number }>();
  return {
    setTimeoutFn: (handler, ms) => {
      const id = nextId++;
      pending.set(id, { handler, ms });
      return id;
    },
    clearTimeoutFn: (handle) => {
      pending.delete(handle as number);
    },
    fire: async (ms) => {
      const entry = [...pending.entries()].at(0);
      if (!entry) return;
      const [id, pendingEntry] = entry;
      pending.delete(id);
      if (ms !== undefined) expect(pendingEntry.ms).toBe(ms);
      pendingEntry.handler();
      // Two microtask turns: the renewal promise and the .finally that clears
      // the in-flight marker.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
    pendingCount: () => pending.size,
  };
}

function createHarness(overrides: Partial<Parameters<typeof LeaseHeartbeat>[0]> = {}) {
  const timers = createFakeTimers();
  const events: { type: string; detail?: string }[] = [];
  const renewLease = vi.fn().mockResolvedValue({});
  const heartbeat = new LeaseHeartbeat({
    taskId: 'task-1',
    owner: 'worker-a',
    leaseTtlMs: 120_000,
    intervalMs: 40_000,
    renewLease,
    readOwnership: async () => ({ status: 'leased', leaseOwner: 'worker-a' }),
    emit: (event) => events.push({ type: event.type, ...(event.detail ? { detail: event.detail } : {}) }),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    now: () => new Date('2026-11-14T00:00:00.000Z'),
    ...overrides,
  });
  return { heartbeat, timers, events, renewLease };
}

describe('LeaseHeartbeat', () => {
  it('renews with the acquiring owner and the lease TTL on every interval', async () => {
    const { heartbeat, timers, renewLease } = createHarness();
    heartbeat.start();
    expect(heartbeat.status).toBe('running');

    await timers.fire(40_000);
    await timers.fire(40_000);

    expect(renewLease).toHaveBeenCalledTimes(2);
    expect(renewLease).toHaveBeenNthCalledWith(1, 'task-1', 'worker-a', 120_000);
    expect(renewLease).toHaveBeenNthCalledWith(2, 'task-1', 'worker-a', 120_000);
    expect(heartbeat.renewalCount).toBe(2);
    expect(heartbeat.lastRenewedAt).toBe('2026-11-14T00:00:00.000Z');
    await heartbeat.stop();
  });

  it('marks the lease lost when a renewal fails, emits, and stops renewing', async () => {
    const renewLease = vi.fn().mockRejectedValue(new Error('lease_conflict: not owner'));
    const { heartbeat, timers, events } = createHarness({ renewLease });

    heartbeat.start();
    await timers.fire();

    expect(heartbeat.lost).toBe(true);
    expect(heartbeat.status).toBe('lost');
    expect(heartbeat.lastError).toContain('lease_conflict');
    expect(events.some((event) => event.type === 'renewal_failed')).toBe(true);
    expect(timers.pendingCount()).toBe(0);
    expect(await heartbeat.assertOwned()).toBe(false);
  });

  it('reports ownership loss when the persisted row belongs to another worker', async () => {
    const { heartbeat, events } = createHarness({
      readOwnership: async () => ({ status: 'leased', leaseOwner: 'worker-b' }),
    });
    heartbeat.start();

    expect(await heartbeat.assertOwned()).toBe(false);
    expect(heartbeat.lost).toBe(true);
    expect(events.some((event) => event.type === 'ownership_lost')).toBe(true);
    await heartbeat.stop();
  });

  it('fails closed when the ownership probe itself errors', async () => {
    const { heartbeat } = createHarness({
      readOwnership: async () => { throw new Error('db unavailable'); },
    });
    heartbeat.start();
    expect(await heartbeat.assertOwned()).toBe(false);
    expect(heartbeat.lost).toBe(true);
    await heartbeat.stop();
  });

  it('reports ownership while the row is still leased by this worker', async () => {
    const { heartbeat } = createHarness();
    heartbeat.start();
    expect(await heartbeat.assertOwned()).toBe(true);
    expect(heartbeat.lost).toBe(false);
    await heartbeat.stop();
  });

  it('stop() clears the timer and awaits an in-flight renewal', async () => {
    let resolveRenewal: (() => void) | null = null;
    const renewLease = vi.fn().mockImplementation(
      () => new Promise<void>((resolve) => { resolveRenewal = resolve; }),
    );
    const { heartbeat, timers } = createHarness({ renewLease });

    heartbeat.start();
    await timers.fire();

    let stopped = false;
    const stopPromise = heartbeat.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolveRenewal?.();
    await stopPromise;
    expect(stopped).toBe(true);
    expect(timers.pendingCount()).toBe(0);
  });

  it('cannot be restarted after the lease was lost', async () => {
    const renewLease = vi.fn().mockRejectedValue(new Error('lease_conflict'));
    const { heartbeat, timers } = createHarness({ renewLease });
    heartbeat.start();
    await timers.fire();
    heartbeat.start();
    expect(heartbeat.status).toBe('lost');
    expect(timers.pendingCount()).toBe(0);
  });
});
