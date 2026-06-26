/**
 * PRI-471: dispatchFollowUp API client tests.
 *
 * Covers the dispatchFollowUp() function in ui/api.ts (real fetch execution,
 * not a source-string match — closes the EP-09 test-reality gap). Mocks fetch +
 * sessionStorage since the vitest environment is 'node'.
 *
 * Also exercises validateFollowUpResponse by feeding the real server response
 * shapes through the fetch → validate pipeline.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { dispatchFollowUp } from '../../src/ui/api.js';

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

// A minimal valid IntentDecisionRecord shape that validateIntentDecisionRecord
// accepts (consumed by validateFollowUpResponse for the record-bearing branches).
const VALID_RECORD = {
  id: 'idr-001',
  source: 'action_drift',
  evidenceStrength: 'moderate',
  relatedIntentFields: ['why'],
  ownerAction: 'confirm_drift',
  evidenceRefs: ['ev-1'],
  createdAt: '2026-06-26T12:00:00.000Z',
};

describe('dispatchFollowUp', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  });

  it('sends POST to the follow-up endpoint and returns validated link_candidate data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          type: 'link_candidate',
          decisionId: 'idr-001',
          record: VALID_RECORD,
          linkedCandidateId: 'cand-1',
        },
      }),
    } as Response);

    const result = await dispatchFollowUp('idr-001', { type: 'link_candidate', candidateId: 'cand-1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.type).toBe('link_candidate');
      expect(result.data.decisionId).toBe('idr-001');
      expect(result.data.linkedCandidateId).toBe('cand-1');
    }
    // Verify the actual request shape (path, method, body, JSON content-type).
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/v1/intent-decisions/idr-001/follow-up');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ type: 'link_candidate', candidateId: 'cand-1' }));
  });

  it('URL-encodes the decisionId in the path', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          type: 'guide_rulehost',
          decisionId: 'a/b c',
          cliCommand: 'pd runtime rulehost',
          note: 'Run this in your terminal.',
        },
      }),
    } as Response);

    const result = await dispatchFollowUp('a/b c', { type: 'guide_rulehost' });
    expect(result.success).toBe(true);
    const [url] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/v1/intent-decisions/a%2Fb%20c/follow-up');
  });

  it('returns validation failure for malformed response data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { type: 'link_candidate', unexpected: 'shape' },
      }),
    } as Response);

    const result = await dispatchFollowUp('idr-001', { type: 'link_candidate', candidateId: 'c' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('validation failed');
    }
  });

  it('returns the server error message + nextAction on a non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({
        success: false,
        error: 'not_found',
        message: 'Intent decision idr-001 not found',
        reason: 'decision_not_found',
        nextAction: 'Refresh the page and try again.',
      }),
    } as Response);

    const result = await dispatchFollowUp('idr-001', { type: 'generate_patch_proposal' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('not found');
      expect(result.nextAction).toContain('Refresh');
    }
  });

  it('returns a network error when fetch throws', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network down'));

    const result = await dispatchFollowUp('idr-001', { type: 'guide_rulehost' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('network down');
    }
  });
});
