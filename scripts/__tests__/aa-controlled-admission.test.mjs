import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BudgetExceededError,
  createExperimentLedger,
  createRunIdentity,
  fixtureBytes,
  sha256Hex,
} from '../dev/aa-controlled-admission/lib/ledger.mjs';
import { startFakeProvider } from '../dev/aa-controlled-admission/lib/fake-provider.mjs';

const openProviders = [];
afterEach(async () => {
  while (openProviders.length > 0) await openProviders.pop().close();
});

function makeLedger(runId = 'aa-test') {
  return createExperimentLedger({ runId, fixtureId: `AA-FIXTURE-${runId}` });
}

async function post(baseUrl, body) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text.startsWith('data:') ? text : JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload, text };
}

describe('experiment ledger — one numbering source', () => {
  it('allocates ids from the global sequence across both arms', () => {
    const ledger = makeLedger();
    expect(ledger.hostTurn('positive').id).toBe('turn-001');
    expect(ledger.hostTurn('control').id).toBe('turn-002');
    expect(ledger.http('positive').id).toBe('http-001');
    expect(ledger.http('positive').id).toBe('http-002');
    const controlRequest = ledger.http('control');
    expect(controlRequest.id).toBe('http-003');
    expect(controlRequest.endpointRequestId).toBe('http-003');
    expect(ledger.tool('positive', { name: 'read' }).id).toBe('tool-001');
    const snapshot = ledger.snapshot();
    expect(snapshot.used).toMatchObject({ hostTurns: 2, httpRequests: 3, toolCalls: 1, paidCalls: 0 });
    expect(snapshot.usedByArm.positive.httpRequests).toBe(2);
    expect(snapshot.usedByArm.control.httpRequests).toBe(1);
    expect(snapshot.withinBudget).toBe(true);
  });

  it('fails closed on the fourth HTTP request and the second control request', () => {
    const ledger = makeLedger();
    ledger.http('positive');
    ledger.http('positive');
    ledger.http('control');
    expect(() => ledger.http('control')).toThrow(BudgetExceededError);
    const afterArmViolation = makeLedger();
    afterArmViolation.http('control');
    expect(() => afterArmViolation.http('control')).toThrow(BudgetExceededError);
    expect(afterArmViolation.snapshot().violations).toHaveLength(1);
  });

  it('never records a paid call and refuses a second tool call', () => {
    const ledger = makeLedger();
    expect(() => ledger.paidCall('positive')).toThrow(BudgetExceededError);
    ledger.tool('positive');
    expect(() => ledger.tool('positive')).toThrow(BudgetExceededError);
    expect(ledger.snapshot().paidCalls).toEqual([]);
  });

  it('keeps one fixture id and one byte sequence', () => {
    const identity = createRunIdentity(new Date('2026-11-06T08:00:00.000Z'));
    expect(identity.runId).toBe('aa-20261106T080000Z');
    expect(identity.fixtureId).toBe('AA-FIXTURE-aa-20261106T080000Z');
    const bytes = fixtureBytes(identity.fixtureId);
    expect(bytes.toString('utf8')).toBe(`${identity.fixtureId}\n`);
    expect(sha256Hex(bytes)).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('fake provider — budget enforced before the response', () => {
  it('serves the positive arm: tool call, then tool result, then stop', async () => {
    const ledger = makeLedger();
    const fixtureId = 'AA-FIXTURE-aa-test';
    const fixtureFile = join(mkdtempSync(join(tmpdir(), 'aa-fixture-')), 'fixture.txt');
    writeFileSync(fixtureFile, fixtureBytes(fixtureId));
    const provider = await startFakeProvider({
      ledger, arm: 'positive', fixtureFile, fixtureId, expectedToolName: 'read',
    });
    openProviders.push(provider);
    expect(provider.baseUrl.startsWith('http://127.0.0.1:')).toBe(true);

    const first = await post(provider.baseUrl, {
      model: 'local-fake-model',
      stream: false,
      messages: [{ role: 'user', content: 'read the fixture' }],
    });
    expect(first.status).toBe(200);
    const body = JSON.parse(first.text);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('read');

    const second = await post(provider.baseUrl, {
      model: 'local-fake-model',
      stream: false,
      messages: [
        { role: 'user', content: 'read the fixture' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'call_1', name: 'read', content: fixtureId },
      ],
    });
    expect(second.status).toBe(200);
    expect(JSON.parse(second.text).choices[0].finish_reason).toBe('stop');

    const third = await post(provider.baseUrl, { messages: [{ role: 'user', content: 'again' }] });
    expect(third.status).toBe(429);
    expect(JSON.parse(third.text).error.type).toBe('aa_budget_exceeded');

    const snapshot = ledger.snapshot();
    expect(snapshot.httpRequests.map((row) => row.id)).toEqual(['http-001', 'http-002']);
    expect(snapshot.httpRequests[0].userMessageSha256).toBe(sha256Hex('read the fixture'));
    expect(snapshot.toolCalls.map((row) => row.id)).toEqual(['tool-001']);
    expect(snapshot.violations).toHaveLength(1);
  });

  it('serves the control arm with one request only', async () => {
    const ledger = makeLedger();
    const provider = await startFakeProvider({ ledger, arm: 'control' });
    openProviders.push(provider);
    const first = await post(provider.baseUrl, { messages: [{ role: 'user', content: 'AA-DONE' }] });
    expect(first.status).toBe(200);
    const second = await post(provider.baseUrl, { messages: [{ role: 'user', content: 'again' }] });
    expect(second.status).toBe(429);
    expect(ledger.snapshot().httpRequests.map((row) => row.id)).toEqual(['http-001']);
  });

  it('requires the P0 tool name for the positive arm and records unknown hashes as null', async () => {
    const ledger = makeLedger();
    await expect(startFakeProvider({ ledger, arm: 'positive' })).rejects.toThrow(/tool name/);
    const provider = await startFakeProvider({
      ledger, arm: 'positive', fixtureFile: 'C:\\nope.txt', fixtureId: 'AA-FIXTURE-x', expectedToolName: 'read',
    });
    openProviders.push(provider);
    await post(provider.baseUrl, { messages: [{ role: 'assistant', content: 'no user message' }] });
    expect(ledger.snapshot().httpRequests[0].userMessageSha256).toBeNull();
  });
});
