/**
 * fetchPrinciples / archivePrinciple / unarchivePrinciple API client tests.
 *
 * Covers the archive/unarchive functions in ui/api.ts.
 * Mocks fetch since the vitest environment is 'node'.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { archivePrinciple, unarchivePrinciple, fetchPrinciples } from "../../src/ui/api.js";

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
vi.stubGlobal("fetch", vi.fn());

describe("archivePrinciple and unarchivePrinciple", () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it("archivePrinciple returns success: true on successful post", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { success: true, principleId: "p1" },
      }),
    } as Response);

    const result = await archivePrinciple("p1");
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/principles/p1/archive", expect.objectContaining({ method: "POST" }));
  });

  it("unarchivePrinciple returns success: true on successful post", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { success: true, principleId: "p1" },
      }),
    } as Response);

    const result = await unarchivePrinciple("p1");
    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/principles/p1/unarchive", expect.objectContaining({ method: "POST" }));
  });

  it("handles fetch error status gracefully", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({
        success: false,
        error: "server_error",
        message: "Internal server error",
      }),
    } as Response);

    const result = await archivePrinciple("p1");
    expect(result.success).toBe(false);
  });
});

describe("fetchPrinciples filter contract", () => {
  afterEach(() => vi.mocked(fetch).mockReset());

  it("requests filter=all when the review page says Show All", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true, data: { principles: [], summary: { candidate: 0, probation: 0, active: 0, deprecated: 0, archived: 0, total: 0 } } }) } as Response);
    await fetchPrinciples('all');
    expect(fetch).toHaveBeenCalledWith('/api/principles?filter=all', expect.anything());
  });
});
