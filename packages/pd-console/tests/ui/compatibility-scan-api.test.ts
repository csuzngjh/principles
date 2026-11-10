/**
 * fetchCompatibilityScan API client tests (5B-F).
 *
 * The UI render tests mock `api.js`, so this file is the only place where the
 * real wire contract (`validateCompatibilityScanView`) runs against a server
 * payload. Without it a server/client skew would surface as an empty block with
 * no failing test.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { fetchCompatibilityScan } from "../../src/ui/api.js";

const sessionStore: Record<string, string> = {};
vi.stubGlobal('sessionStorage', {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { sessionStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; }),
  key: vi.fn((index: number) => Object.keys(sessionStore)[index] ?? null),
  get length() { return Object.keys(sessionStore).length; },
});

vi.stubGlobal("fetch", vi.fn());

function respond(data: unknown): void {
  vi.mocked(fetch).mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ success: true, data }),
  } as Response);
}

describe("fetchCompatibilityScan", () => {
  afterEach(() => vi.mocked(fetch).mockReset());

  it("requests the read-only scan endpoint and accepts an incomplete payload", async () => {
    respond({
      status: "incomplete",
      scannedActivations: 3,
      findingsTotal: 0,
      unscannable: [
        { reason: "unscannable_active_rows", count: 2, sampleActivationIds: ["act-1", "act-2"] },
      ],
      reason: "unscannable_active_rows",
      nextAction: "Inspect the skipped activations.",
    });

    const result = await fetchCompatibilityScan();

    expect(fetch).toHaveBeenCalledWith("/api/runtime/compatibility-scan", expect.anything());
    expect(result.success).toBe(true);
    expect(result.data?.status).toBe("incomplete");
    expect(result.data?.unscannable).toEqual([
      { reason: "unscannable_active_rows", count: 2, sampleActivationIds: ["act-1", "act-2"] },
    ]);
    expect(result.data?.reason).toBe("unscannable_active_rows");
    expect(result.data?.nextAction).toBe("Inspect the skipped activations.");
  });

  it("accepts a clean payload with no unscannable rows", async () => {
    respond({ status: "clean", scannedActivations: 0, findingsTotal: 0, unscannable: [] });

    const result = await fetchCompatibilityScan();

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ status: "clean", scannedActivations: 0, findingsTotal: 0, unscannable: [] });
  });

  it("rejects an unknown status instead of guessing", async () => {
    respond({ status: "probably_fine", scannedActivations: 1, findingsTotal: 0, unscannable: [] });

    const result = await fetchCompatibilityScan();

    expect(result.success).toBe(false);
    expect(result.error).toContain("validation failed");
  });

  it("rejects unscannable entries with a non-positive count", async () => {
    respond({
      status: "incomplete",
      scannedActivations: 1,
      findingsTotal: 0,
      unscannable: [{ reason: "unscannable_active_rows", count: 0, sampleActivationIds: [] }],
    });

    const result = await fetchCompatibilityScan();

    expect(result.success).toBe(false);
  });
});
