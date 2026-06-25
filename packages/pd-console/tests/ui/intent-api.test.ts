/**
 * PRI-466: fetchIntentSummary API client tests.
 *
 * Covers the fetchIntentSummary() function in ui/api.ts (lines 402-404).
 * Mocks fetch + sessionStorage since the vitest environment is 'node'.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchIntentSummary } from '../../src/ui/api.js';

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

describe('fetchIntentSummary', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
    for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  });

  it('returns validated summary on successful response', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          ok: true,
          found: true,
          flagEnabled: true,
          warnings: [],
        },
      }),
    } as Response);

    const result = await fetchIntentSummary();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ok).toBe(true);
      expect(result.data.found).toBe(true);
      expect(result.data.flagEnabled).toBe(true);
      expect(result.data.warnings).toEqual([]);
    }
  });

  it('returns validation failure for malformed response data', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { unexpected: 'shape' },
      }),
    } as Response);

    const result = await fetchIntentSummary();
    expect(result.success).toBe(false);
  });
});
