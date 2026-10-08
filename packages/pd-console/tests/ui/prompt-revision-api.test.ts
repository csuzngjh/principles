/**
 * PD_PROMPT_CAPACITY_V1 R-B3: proposePromptRevision API client tests
 * (mocked fetch/sessionStorage — same harness as intent-api.test.ts).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { proposePromptRevision } from '../../src/ui/api.js';

const sessionStore: Record<string, string> = {};
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { sessionStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; }),
  key: vi.fn((index: number) => Object.keys(sessionStore)[index] ?? null),
  get length() { return Object.keys(sessionStore).length; },
});
vi.stubGlobal('window', { location: { hash: '' } });
vi.stubGlobal('fetch', vi.fn());

describe('proposePromptRevision', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  });

  it('sends the statement (+ optional host) and returns the queued result', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ok: true,
          alreadyPending: false,
          newArtifactId: 'pi-art-x',
          approvalId: 'apr-1',
          supersededActivationId: 'act-1',
          oldStatement: 'old',
          newStatement: 'new',
          title: 'T',
        },
      }),
    });
    const res = await proposePromptRevision('act-1', 'new statement', 'codex');
    expect(res.success).toBe(true);
    expect(res.data?.ok).toBe(true);
    expect(res.data?.approvalId).toBe('apr-1');
    const [path, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe('/api/v1/activations/act-1/propose-revision');
    expect(JSON.parse(String(init.body))).toEqual({ statement: 'new statement', host: 'codex' });
  });

  it('surfaces the structured refusal (success HTTP, ok=false) with reason', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { ok: false, error: 'revision_validation_failed', reason: 'statement_unchanged', nextAction: 'change the statement' },
      }),
    });
    const res = await proposePromptRevision('act-1', 'same');
    expect(res.success).toBe(true);
    expect(res.data?.ok).toBe(false);
    expect(res.data?.reason).toBe('statement_unchanged');
  });

  it('maps the 422 capacity refusal to success=false with reason + nextAction', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        success: false,
        error: 'prompt_capacity_refused',
        message: 'single_item_exceeds_budget: 2314 > 2000',
        reason: 'capacity',
        nextAction: 'shorten the statement',
      }),
    });
    const res = await proposePromptRevision('act-1', 'huge');
    expect(res.success).toBe(false);
    expect(res.error).toBe('single_item_exceeds_budget: 2314 > 2000');
    expect(res.reason).toBe('capacity');
    expect(res.nextAction).toBe('shorten the statement');
  });

  it('maps a malformed payload (non-object) to success=false without throwing', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => 'not-an-object',
    });
    const res = await proposePromptRevision('act-1', 'x');
    expect(res.success).toBe(false);
  });
});
