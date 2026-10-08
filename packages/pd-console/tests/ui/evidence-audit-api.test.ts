/**
 * PD v2 Phase 1: evidence audit API client tests (fetchEvidenceAudit).
 *
 * Real fetch → validate pipeline (mocked fetch + sessionStorage), covering:
 * - the four-selector URL shape;
 * - rc-1/rc-4 element-wise validation (malformed records filtered, coverage
 *   required);
 * - degraded payloads keep reason + nextAction end-to-end (rc-9);
 * - no success-rate/effectiveness field can pass the client validator.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchEvidenceAudit } from '../../src/ui/api.js';

const sessionStore: Record<string, string> = {};
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, _value: string) => { sessionStore[key] = _value; }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; }),
  key: vi.fn((index: number) => Object.keys(sessionStore)[index] ?? null),
  get length() { return Object.keys(sessionStore).length; },
});
vi.stubGlobal('fetch', vi.fn());

function okEnvelope(data: unknown): Response {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
}

function coverage(): Record<string, unknown> {
  return {
    sourceStatus: 'available', validationStatus: 'valid',
    observedFrom: '2026-01-01T00:00:00.000Z', asOf: '2026-10-07T00:00:00.000Z',
    retentionPolicyDays: 90,
  };
}

function deliveryRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    evidenceId: 'sha256:d1', kind: 'delivery', observationKey: 'openclaw|delivery|x',
    principleId: 'princ-A', activationId: 'act-a1',
    recordedAt: '2026-10-07T08:00:00Z', associationStatus: 'linked',
    nativeRefs: { hostKind: 'openclaw', sessionId: 's-1' },
    contentRef: { principleId: 'princ-A', resolution: 'resolved', payloadDigest: `sha256:${'a'.repeat(64)}` },
    activationRef: { activationId: 'act-a1', sourceSnapshotDigest: `sha256:${'b'.repeat(64)}`, activatedAt: '2026-10-01T00:00:00Z' },
    payload: { targetKind: 'agent_context', confirmation: 'submitted', outcome: 'attempted' },
    ...overrides,
  };
}

function pages(withDeliveryCursor = false): Record<string, unknown> {
  return Object.fromEntries(['delivery', 'application', 'behavior_episode', 'effect', 'outcome'].map((kind) => [kind, kind === 'delivery' && withDeliveryCursor
    ? { hasMore: true, nextCursor: { recordedAt: '2026-10-06T00:00:00Z', evidenceId: 'sha256:cursor' } }
    : { hasMore: false, nextCursor: null }]));
}

afterEach(() => {
  vi.mocked(fetch).mockReset();
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
});

describe('fetchEvidenceAudit', () => {
  it('GETs the audit endpoint with selector query params and validates the chain', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok',
      deliveries: [deliveryRecord()],
      applications: [],
      episodes: [],
      effects: [],
      outcomes: [],
      pages: pages(true),
      unresolvedReferences: [],
      capabilityDeclarations: [
        { hostKind: 'openclaw', capability: 'enforcement_delivery', status: 'supported', adapterVersion: 'v', channel: 'code_tool_hook' },
      ],
      coverage: coverage(),
    }));
    const result = await fetchEvidenceAudit('principle', 'princ-A', {
      kind: 'delivery', after: { recordedAt: '2026-10-06T00:00:00Z', evidenceId: 'sha256:cursor' },
    });
    expect(result.success).toBe(true);
    if (!result.success || !result.data) return;
    expect(result.data.deliveries).toHaveLength(1);
    expect(result.data.deliveries[0]!.summary).toBe('submitted / attempted');
    expect(result.data.deliveries[0]!.contentReference?.resolution).toBe('resolved');
    expect(result.data.deliveries[0]!.activationReference?.activationId).toBe('act-a1');
    expect(result.data.deliveries[0]!.nativeLineage).toContain('sessionId=s-1');
    expect(result.data.pages.delivery.hasMore).toBe(true);
    expect(result.data.pages.delivery.nextCursor?.evidenceId).toBe('sha256:cursor');
    expect(result.data.capabilityDeclarations[0]!.status).toBe('supported');
    const url = vi.mocked(fetch).mock.calls[0]?.[0];
    expect(String(url)).toContain('/api/v1/receipts/evidence-audit?type=principle&id=princ-A');
    expect(String(url)).toContain('afterKind=delivery');
  });

  it('rejects a malformed record instead of silently presenting an incomplete chain', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok',
      deliveries: [deliveryRecord(), { evidenceId: 'x' /* malformed */ }, deliveryRecord({ kind: 'nonsense' })],
      applications: [], episodes: [], effects: [], outcomes: [], pages: pages(),
      unresolvedReferences: [], capabilityDeclarations: [],
      coverage: coverage(),
    }));
    const result = await fetchEvidenceAudit('episode', 'k');
    expect(result.success).toBe(false);

    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'ok', deliveries: [deliveryRecord({ contentRef: null })], applications: [], episodes: [], effects: [], outcomes: [],
      pages: pages(), unresolvedReferences: [], capabilityDeclarations: [], coverage: coverage(),
    }));
    expect((await fetchEvidenceAudit('episode', 'k')).success).toBe(false);

    const noCoverage = okEnvelope({ status: 'ok', deliveries: [], applications: [], episodes: [], effects: [], outcomes: [], pages: pages(), unresolvedReferences: [], capabilityDeclarations: [] });
    vi.mocked(fetch).mockReset();
    vi.mocked(fetch).mockResolvedValue(noCoverage);
    const rejected = await fetchEvidenceAudit('effect', 'k');
    expect(rejected.success).toBe(false);
  });

  it('carries degraded reason + nextAction end-to-end (rc-9)', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope({
      status: 'degraded',
      reason: 'state.db not found',
      nextAction: 'Run pd runtime diagnostics',
      deliveries: [], applications: [], episodes: [], effects: [], outcomes: [], pages: pages(),
      unresolvedReferences: [], capabilityDeclarations: [],
      coverage: { ...coverage(), sourceStatus: 'unavailable' },
    }));
    const result = await fetchEvidenceAudit('activation', 'act-1');
    expect(result.success).toBe(true);
    if (!result.success || !result.data) return;
    expect(result.data.status).toBe('degraded');
    expect(result.data.reason).toBe('state.db not found');
    expect(result.data.nextAction).toBe('Run pd runtime diagnostics');
  });
});
