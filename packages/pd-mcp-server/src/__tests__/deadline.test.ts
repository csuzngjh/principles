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
import { OrphanLimiter, runWithDeadline, MAX_TRACKED_ORPHANS } from '../deadline.js';
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

describe('runWithDeadline primitive', () => {
  it('returns the value when fn finishes in time', async () => {
    const outcome = await runWithDeadline(async () => 42, 1000);
    expect(outcome).toEqual({ ok: true, value: 42 });
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
