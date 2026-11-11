/**
 * Examiner eligibility API client tests (fetchExaminerEligibility).
 *
 * Covers the two behaviours that matter to the configure page:
 * - the query is only built from the options actually supplied, and the
 *   principle id / suite key are URL-encoded;
 * - a response that is not a verdict object is rejected instead of being
 *   rendered as eligibility (rc-1: treat untrusted payloads as unknown).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchExaminerEligibility } from '../../src/ui/api.js';

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

function eligibilityPayload(): Record<string, unknown> {
  return {
    status: 'ELIGIBLE',
    principleId: 'pri-1',
    reasonCode: null,
    blockingReasonCode: null,
    nextAction: null,
    summary: 'all checks passed',
    checks: [
      {
        id: 'experiment_mode',
        status: 'PASS',
        reasonCode: 'experiment_mode_ok',
        detail: null,
        evidence: ['mode:host-dry-run'],
        nextAction: null,
      },
    ],
    experimentMode: 'host-dry-run',
    suiteKey: 'default',
    productionSnapshotMarkers: [],
    note: 'read-only pre-check',
  };
}

afterEach(() => {
  vi.mocked(fetch).mockReset();
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
});

describe('fetchExaminerEligibility', () => {
  it('GETs the bare endpoint when no options are supplied', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope(eligibilityPayload()));

    const result = await fetchExaminerEligibility('pri-1');

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe('ELIGIBLE');
    expect(result.data.checks).toHaveLength(1);
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe('/api/examiner/principles/pri-1/eligibility');
  });

  it('encodes the principle id and both optional selectors into the query', async () => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope(eligibilityPayload()));

    await fetchExaminerEligibility('pri/1', { mode: 'host-dry-run', suiteKey: 'suite/key' });

    const url = String(vi.mocked(fetch).mock.calls[0]?.[0]);
    expect(url).toContain('/api/examiner/principles/pri%2F1/eligibility?');
    expect(url).toContain('mode=host-dry-run');
    expect(url).toContain('suite=suite%2Fkey');
  });

  it.each([
    ['null data', null],
    ['a non-object', 'not-a-verdict'],
    ['a missing status', { checks: [] }],
    ['non-array checks', { status: 'ELIGIBLE', checks: {} }],
  ])('rejects %s instead of rendering it as a verdict', async (_label, data) => {
    vi.mocked(fetch).mockResolvedValue(okEnvelope(data));

    const result = await fetchExaminerEligibility('pri-1');

    expect(result.success).toBe(false);
  });

  it('returns a failure envelope when the network call throws', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));

    const result = await fetchExaminerEligibility('pri-1');

    expect(result.success).toBe(false);
  });
});
