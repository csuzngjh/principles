/**
 * PRI-533: receipts API client tests (fetchPrincipleReceipts / fetchReceiptCounts).
 *
 * Covers the two receipt fetch functions in ui/api.ts through the REAL
 * fetch → validate pipeline (not a source-string match — closes the EP-09
 * test-reality gap flagged by codecov/patch). Mocks fetch + sessionStorage
 * since the vitest environment is 'node'.
 *
 * ERR coverage:
 * - ERR-001/005 (rc-1/rc-2/rc-4): malformed events/counts elements are
 *   filtered element-wise, never trusted.
 * - ERR-002 (rc-9): degraded payloads keep reason + nextAction end-to-end.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchPrincipleReceipts, fetchReceiptCounts } from '../../src/ui/api.js';

// Mock sessionStorage (browser API not available in Node env)
const sessionStore: Record<string, string> = {};
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { sessionStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; }),
  key: vi.fn((index: number) => Object.keys(sessionStore)[index] ?? null),
  get length() { return Object.keys(sessionStore).length; },
});

// Mock fetch
vi.stubGlobal('fetch', vi.fn());

function okEnvelope(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  } as Response;
}

describe('fetchPrincipleReceipts', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  });

  it('GETs the per-principle endpoint with URL-encoded id and returns validated data', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok',
      principleId: 'princ-A',
      effectCount: 2,
      presenceCount: 1,
      lastEffectAt: '2026-08-15T11:00:00.000Z',
      events: [
        { kind: 'rule_blocked', level: 'effect', sessionId: 's1', toolName: 'write', filePath: '/a.md', digest: 'd1', createdAt: '2026-08-14T10:00:00.000Z' },
        { kind: 'prompt_injected', level: 'presence', sessionId: 's1', toolName: null, filePath: null, digest: null, createdAt: '2026-08-13T09:00:00.000Z' },
      ],
    }));

    const result = await fetchPrincipleReceipts('princ/A 1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('ok');
      expect(result.data.principleId).toBe('princ-A');
      expect(result.data.effectCount).toBe(2);
      expect(result.data.presenceCount).toBe(1);
      expect(result.data.events).toHaveLength(2);
    }
    // Verify the real request shape (path encoding).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/v1/receipts/principles/princ%2FA%201');
  });

  it('filters malformed event elements instead of failing the whole payload (rc-4)', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok',
      principleId: 'princ-A',
      effectCount: 1,
      presenceCount: 0,
      lastEffectAt: null,
      events: [
        { kind: 'rule_blocked', level: 'effect', createdAt: '2026-08-14T10:00:00.000Z' },
        { kind: 'weird-kind', level: 'effect', createdAt: '2026-08-14T10:01:00.000Z' }, // invalid kind → dropped
        { kind: 'auto_correct_applied', level: 'weird-level', createdAt: '2026-08-14T10:02:00.000Z' }, // invalid level → dropped
        { kind: 'self_reported', level: 'effect', createdAt: 42 }, // invalid createdAt → dropped
        'not-an-object', // dropped
      ],
    }));

    const result = await fetchPrincipleReceipts('princ-A');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events).toHaveLength(1);
      expect(result.data.events[0]?.kind).toBe('rule_blocked');
    }
  });

  it('passes degraded payloads through with reason + nextAction (ERR-002)', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'degraded',
      reason: 'principle_receipt_ledger flag is disabled',
      nextAction: 'Enable the flag in .pd/config.yaml',
      principleId: 'princ-A',
      effectCount: 0,
      presenceCount: 0,
      lastEffectAt: null,
      events: [],
    }));

    const result = await fetchPrincipleReceipts('princ-A');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('degraded');
      expect(result.data.reason).toContain('principle_receipt_ledger');
      expect(result.data.nextAction).toContain('.pd/config.yaml');
    }
  });

  it('returns a validation-failure envelope for a non-object payload', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope('not-an-object'));

    const result = await fetchPrincipleReceipts('princ-A');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('validation failed');
    }
  });

  it('surfaces HTTP errors with server-provided message', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'receipts_error', message: 'boom' }),
    } as Response);

    const result = await fetchPrincipleReceipts('princ-A');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('boom');
    }
  });
});

describe('fetchReceiptCounts', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  });

  it('GETs /api/v1/receipts/counts and returns validated per-principle entries', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok',
      counts: [
        { principleId: 'princ-A', effectCount: 2, presenceCount: 1, lastEffectAt: '2026-08-15T11:00:00.000Z' },
        { principleId: 'princ-B', effectCount: 0, presenceCount: 3, lastEffectAt: null },
      ],
    }));

    const result = await fetchReceiptCounts();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('ok');
      expect(result.data.counts).toHaveLength(2);
      expect(result.data.counts[0]?.principleId).toBe('princ-A');
      expect(result.data.counts[1]?.presenceCount).toBe(3);
    }
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/v1/receipts/counts');
  });

  it('skips count entries missing principleId (rc-4 element-wise validation)', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok',
      counts: [
        { principleId: 'princ-A', effectCount: 1, presenceCount: 0, lastEffectAt: null },
        { effectCount: 5, presenceCount: 0, lastEffectAt: null }, // no principleId → skipped
        { principleId: 42, effectCount: 1, presenceCount: 0, lastEffectAt: null }, // non-string id → skipped
        null, // skipped
      ],
    }));

    const result = await fetchReceiptCounts();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.counts).toHaveLength(1);
      expect(result.data.counts[0]?.principleId).toBe('princ-A');
    }
  });

  it('coerces malformed numeric fields to honest zeros instead of trusting them', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok',
      counts: [
        { principleId: 'princ-A', effectCount: 'many', presenceCount: null, lastEffectAt: 42 },
      ],
    }));

    const result = await fetchReceiptCounts();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.counts[0]?.effectCount).toBe(0);
      expect(result.data.counts[0]?.presenceCount).toBe(0);
      expect(result.data.counts[0]?.lastEffectAt).toBeNull();
    }
  });

  it('passes degraded payloads through with reason + nextAction (ERR-002)', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'degraded',
      reason: 'state.db not found — workspace may not be initialized',
      nextAction: 'Run pd runtime diagnostics to check workspace state',
      counts: [],
    }));

    const result = await fetchReceiptCounts();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('degraded');
      expect(result.data.reason).toContain('state.db not found');
      expect(result.data.nextAction).toContain('pd runtime diagnostics');
      expect(result.data.counts).toEqual([]);
    }
  });
});
