/**
 * Deadline and orphan-lifecycle tests — SPEC-PD-MCP-GATE4-001 §4.7.
 *
 * Pins: timeout returns tool_execution_failed (never a later success), late
 * results are suppressed AND observed (no unhandled rejections, orphan set
 * drains = resource release), saturation refuses new work while ≥
 * MAX_TRACKED_ORPHANS stragglers run, and the deadline window is enforced on
 * the Adapter side without claiming underlying cancellation.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { createPdMcpServer, TOOL_NAME } from '../server.js';
import {
  AdmissionLimiter,
  OrphanLimiter,
  runWithDeadline,
  MAX_CONCURRENT_CALLS,
  MAX_TRACKED_ORPHANS,
} from '../deadline.js';
import type { PainRecallCapabilityResult } from '@principles/core/runtime-v2/pain-recall-capability';

const OK_ENVELOPE: PainRecallCapabilityResult = {
  schemaVersion: 'pd.capability.v1',
  capability: 'pd_recall_principle_pains',
  disclosureProfile: 'od-a-v1',
  status: 'ok',
  data: null,
  provenance: { workspaceBinding: 'configured', sources: [] },
  warnings: [],
  error: null,
  nextAction: null,
};

function envelopeOf(result: CallToolResult): PainRecallCapabilityResult {
  const [block] = result.content;
  if (block === undefined || block.type !== 'text') throw new Error('expected text block');
  return JSON.parse(block.text) as PainRecallCapabilityResult;
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function makeClient(
  capability: (input: { principleId: string }) => Promise<PainRecallCapabilityResult>,
  deadlineMs: number
) {
  const handle = createPdMcpServer({
    workspaceDir: 'C:\\pd-test-workspace',
    deadlineMs,
    callCapability: capability,
    logSink: () => undefined,
  });
  const client = new Client({ name: 'deadline-test-client', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), handle.mcpServer.connect(st)]);
  return { client, handle };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached before timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('runWithDeadline primitive', () => {
  it('returns the value when fn finishes in time', async () => {
    const outcome = await runWithDeadline(async () => 42, 1000);
    expect(outcome).toEqual({ ok: true, value: 42 });
  });

  it('a value assembled after the deadline is a timeout, not a late success', async () => {
    // The timer cannot fire while synchronous assembly blocks the loop, so
    // without the elapsed re-check this would resolve `ok` past the deadline.
    let orphanSeen = false;
    const outcome = await runWithDeadline(async () => {
      const until = Date.now() + 40;
      while (Date.now() < until) { /* block the loop past the deadline */ }
      return 'assembled-late';
    }, 10, () => {
      orphanSeen = true;
      return true;
    });
    expect(outcome).toEqual({ ok: false, timedOut: true });
    // The underlying promise already settled: nothing is orphaned.
    expect(orphanSeen).toBe(false);
  });

  it('times out and hands the still-running promise to onOrphan', async () => {
    const d = deferred<string>();
    let seen: Promise<string> | undefined;
    const outcome = await runWithDeadline(() => d.promise, 20, (orphan) => {
      seen = orphan;
      return true;
    });
    expect(outcome).toEqual({ ok: false, timedOut: true });
    expect(seen).toBeDefined();
    d.resolve('late');
    await expect(seen).resolves.toBe('late');
  });

  it('a rejected orphan does not become an unhandled rejection (observed internally)', async () => {
    const d = deferred<string>();
    const outcome = await runWithDeadline(() => d.promise, 20);
    expect(outcome.ok).toBe(false);
    d.reject(new Error('late failure'));
    await new Promise((r) => setTimeout(r, 10));
    // Reaching here without an unhandled rejection is the assertion.
  });
});

describe('OrphanLimiter', () => {
  it('refuses registration when saturated and drains on settlement', async () => {
    const limiter = new OrphanLimiter(2);
    const d1 = deferred<number>();
    const d2 = deferred<number>();
    expect(limiter.register(d1.promise)).toBe(true);
    expect(limiter.register(d2.promise)).toBe(true);
    expect(limiter.saturated).toBe(true);
    expect(limiter.register(Promise.resolve(9))).toBe(false);
    d1.resolve(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.size).toBe(1);
    expect(limiter.saturated).toBe(false);
    d2.resolve(2);
    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.size).toBe(0);
  });
});

describe('AdmissionLimiter', () => {
  it('reserves synchronously, refuses at the bound, and releases one slot per acquire', () => {
    const limiter = new AdmissionLimiter(2);
    expect(limiter.active).toBe(0);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.active).toBe(2);
    expect(limiter.saturated).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);
    expect(limiter.active).toBe(2);
    limiter.release();
    expect(limiter.active).toBe(1);
    expect(limiter.saturated).toBe(false);
    expect(limiter.tryAcquire()).toBe(true);
  });

  it('fails loud on release without a matching acquire', () => {
    const limiter = new AdmissionLimiter(1);
    expect(() => limiter.release()).toThrow(/without a matching acquire/);
  });
});

describe('deadline behavior through the MCP surface (§4.7)', () => {
  it('timeout returns tool_execution_failed with isError; late success is suppressed, orphan released', async () => {
    const d = deferred<PainRecallCapabilityResult>();
    const { client, handle } = await makeClient(() => d.promise, 60);
    const result = await client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    expect(result.isError).toBe(true);
    const envelope = envelopeOf(result);
    expect(envelope.error?.code).toBe('tool_execution_failed');
    // The late capability result must never surface anywhere; the orphan is
    // tracked while pending…
    expect(handle.orphans.size).toBe(1);
    d.resolve({ ...OK_ENVELOPE, status: 'ok' });
    await new Promise((r) => setTimeout(r, 30));
    // …and released once it settles (resource release, §4.7).
    expect(handle.orphans.size).toBe(0);
    await client.close();
  });

  it('in-time call completes normally', async () => {
    const { client } = await makeClient(async () => OK_ENVELOPE, 5000);
    const result = await client.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    expect(result.isError).toBeFalsy();
    expect(envelopeOf(result).status).toBe('ok');
    await client.close();
  });

  it('saturation: timed-out stragglers are bounded; excess calls fail fast; set drains after release', async () => {
    const gates = Array.from({ length: MAX_TRACKED_ORPHANS + 2 }, () => deferred<PainRecallCapabilityResult>());
    let callIndex = 0;
    const { client, handle } = await makeClient(() => {
      const gate = gates[callIndex];
      callIndex += 1;
      if (!gate) throw new Error('more calls than gates');
      return gate.promise;
    }, 50);
    const results = await Promise.all(
      gates.map((_, i) => client.callTool({ name: TOOL_NAME, arguments: { principleId: `p-${i}` } }))
    );
    const failureCodes = results.map((r) => envelopeOf(r).error?.code);
    for (const code of failureCodes) expect(code).toBe('tool_execution_failed');
    // Every call timed out or was refused while saturated.
    expect(results.every((r) => r.isError === true)).toBe(true);
    // Orphans bounded at MAX_TRACKED_ORPHANS.
    expect(handle.orphans.size).toBeLessThanOrEqual(MAX_TRACKED_ORPHANS);
    // Release all stragglers → orphan set drains to zero (resource release).
    for (const g of gates) g.resolve(OK_ENVELOPE);
    await new Promise((r) => setTimeout(r, 30));
    expect(handle.orphans.size).toBe(0);
    // After draining, a fresh call proceeds (not saturated).
    const { client: c2 } = await makeClient(async () => OK_ENVELOPE, 5000);
    const fresh = await c2.callTool({ name: TOOL_NAME, arguments: { principleId: 'p-1' } });
    expect(fresh.isError).toBeFalsy();
    await c2.close();
    await client.close();
  }, 20000);
});

describe('admission control (§4.7 real concurrency bound)', () => {
  it('starts at most MAX_CONCURRENT_CALLS capability calls and holds slots until underlying settlement', async () => {
    const gates = Array.from({ length: MAX_CONCURRENT_CALLS + 2 }, () => deferred<PainRecallCapabilityResult>());
    let started = 0;
    let running = 0;
    let maxRunning = 0;
    const { client, handle } = await makeClient(() => {
      const gate = gates[started];
      started += 1;
      if (!gate) return Promise.resolve(OK_ENVELOPE);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      return gate.promise.finally(() => {
        running -= 1;
      });
    }, 75);

    // Six simultaneous requests: only MAX_CONCURRENT_CALLS may reach the
    // capability; the rest are refused BEFORE any underlying work starts.
    const initial = gates.map((_, i) =>
      client.callTool({ name: TOOL_NAME, arguments: { principleId: `p-${i}` } })
    );
    const initialResults = await Promise.all(initial);
    expect(initialResults.every((r) => r.isError === true)).toBe(true);
    expect(started).toBe(MAX_CONCURRENT_CALLS);
    expect(maxRunning).toBe(MAX_CONCURRENT_CALLS);
    expect(handle.admissions.active).toBe(MAX_CONCURRENT_CALLS);
    expect(handle.orphans.size).toBe(MAX_TRACKED_ORPHANS);

    // All four admitted calls timed out; capacity is still reserved by the
    // underlying work, so a new request is refused without starting work.
    const whileSaturated = await client.callTool({ name: TOOL_NAME, arguments: { principleId: 'refused' } });
    expect(whileSaturated.isError).toBe(true);
    expect(envelopeOf(whileSaturated).error?.code).toBe('tool_execution_failed');
    expect(started).toBe(MAX_CONCURRENT_CALLS);
    expect(handle.admissions.active).toBe(MAX_CONCURRENT_CALLS);

    // Settle exactly two underlying promises → exactly two slots free up.
    gates[0].resolve(OK_ENVELOPE);
    gates[1].resolve(OK_ENVELOPE);
    await waitFor(() => handle.admissions.active === 2);
    expect(handle.orphans.size).toBe(2);
    expect(running).toBe(2);

    const admitted = [MAX_CONCURRENT_CALLS, MAX_CONCURRENT_CALLS + 1].map((i) =>
      client.callTool({ name: TOOL_NAME, arguments: { principleId: `admitted-${i}` } })
    );
    await waitFor(() => started === MAX_CONCURRENT_CALLS + 2);
    expect(handle.admissions.active).toBe(MAX_CONCURRENT_CALLS);
    expect(handle.orphans.size).toBe(2);

    // The freed capacity is fully re-reserved: a third new request is refused.
    const refusedAgain = await client.callTool({ name: TOOL_NAME, arguments: { principleId: 'refused-2' } });
    expect(refusedAgain.isError).toBe(true);
    expect(started).toBe(MAX_CONCURRENT_CALLS + 2);

    // Release everything → every slot and orphan returns to zero.
    for (const gate of gates.slice(2)) gate.resolve(OK_ENVELOPE);
    await Promise.all(admitted);
    await waitFor(() => handle.admissions.active === 0 && handle.orphans.size === 0);
    expect(running).toBe(0);

    // Capacity is usable again after a complete drain.
    const final = await client.callTool({ name: TOOL_NAME, arguments: { principleId: 'after-drain' } });
    expect(final.isError).toBeFalsy();
    expect(handle.admissions.active).toBe(0);
    await client.close();
  }, 20000);

  it('releases capacity on normal completion, capability rejection, and timeout followed by rejection', async () => {
    const ok = await makeClient(async () => OK_ENVELOPE, 5000);
    const okResult = await ok.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'ok' } });
    expect(okResult.isError).toBeFalsy();
    expect(ok.handle.admissions.active).toBe(0);
    expect(ok.handle.orphans.size).toBe(0);
    await ok.client.close();

    const failing = await makeClient(async () => {
      throw new Error('capability boom');
    }, 5000);
    const failResult = await failing.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'fail' } });
    expect(failResult.isError).toBe(true);
    expect(envelopeOf(failResult).error?.code).toBe('tool_execution_failed');
    expect(failing.handle.admissions.active).toBe(0);
    expect(failing.handle.orphans.size).toBe(0);
    await failing.client.close();

    const gate = deferred<PainRecallCapabilityResult>();
    const timed = await makeClient(() => gate.promise, 40);
    const timedResult = await timed.client.callTool({ name: TOOL_NAME, arguments: { principleId: 'late-reject' } });
    expect(timedResult.isError).toBe(true);
    // Timeout stopped the WAIT only: the slot is still held.
    expect(timed.handle.admissions.active).toBe(1);
    expect(timed.handle.orphans.size).toBe(1);
    gate.reject(new Error('late underlying failure'));
    await waitFor(() => timed.handle.admissions.active === 0 && timed.handle.orphans.size === 0);
    await timed.client.close();
  }, 20000);
});
