/**
 * PRI-447 TDD tests — Edit action must be exposed in the real Console UI.
 *
 * These tests fail before implementation because FocusPage.tsx,
 * PrincipleDetailPage.tsx, and api.ts do not expose an edit approval path.
 * They verify production wiring (EP-02 / ERR-025), not isolated helper
 * behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Source-level helpers ─────────────────────────────────────────────────────

function readSrc(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, relativePath), "utf-8");
}

const focusSrc = () => readSrc("../../src/ui/pages/focus/FocusPage.tsx");
const detailSrc = () => readSrc("../../src/ui/pages/principles/PrincipleDetailPage.tsx");

// ── API client tests ─────────────────────────────────────────────────────────

describe("approval edit API client (PRI-447)", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal(
      "sessionStorage",
      {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      } as Storage,
    );
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exports editApproval from api.js", async () => {
    const api = await import("../../src/ui/api.js");
    expect(typeof api.editApproval).toBe("function");
  });

  it("posts to /api/v1/approvals/:id/edit with newArtifactId and editReason", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: {
          approvalId: "apr-1",
          artifactId: "art-v2",
          channel: "prompt",
          riskLevel: "low",
          status: "pending",
          requestedAt: "2026-06-22T00:00:00Z",
        },
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { editApproval } = await import("../../src/ui/api.js");
    const result = await editApproval("apr-1", "art-v2", "Refined wording");

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.artifactId).toBe("art-v2");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledPath, calledInit] = mockFetch.mock.calls[0];
    expect(calledPath).toBe("/api/v1/approvals/apr-1/edit");
    expect(calledInit?.method).toBe("POST");
    const body = JSON.parse(calledInit?.body as string);
    expect(body.newArtifactId).toBe("art-v2");
    expect(body.editReason).toBe("Refined wording");
  });

  it("surfaces backend refusal reason and nextAction", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: "artifact_lineage_mismatch",
        message: "Artifact does not reference original",
        nextAction: "Create a validated revision first",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const { editApproval } = await import("../../src/ui/api.js");
    const result = await editApproval("apr-1", "art-v2", "reason");

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("Artifact does not reference original");
    expect(result.nextAction).toBe("Create a validated revision first");
  });
});

// ── FocusPage wiring tests ───────────────────────────────────────────────────

describe("FocusPage exposes edit action (PRI-447)", () => {
  it("contains an Edit button/action label", () => {
    const src = focusSrc();
    expect(src).toMatch(/editAction|pages\.focus\.editAction/);
  });

  it("contains edit form state and handler wiring", () => {
    const src = focusSrc();
    expect(src).toMatch(/showEditInput|handleEdit|editReason|newArtifactId/);
  });

  it("imports editApproval from the API client", () => {
    const src = focusSrc();
    expect(src).toContain("editApproval");
  });

  it("disables edit for processed records by gating on pending status", () => {
    const src = focusSrc();
    // The edit action must not be reachable for already-decided groups.
    expect(src).toMatch(/isActionable|status === "pending"|status === 'pending'/);
  });
});

// ── PrincipleDetailPage wiring tests ─────────────────────────────────────────

describe("PrincipleDetailPage exposes edit action (PRI-447)", () => {
  it("contains an Edit button/action label", () => {
    const src = detailSrc();
    expect(src).toMatch(/editAction|principles\.detail\.editAction/);
  });

  it("contains edit form state and handler wiring", () => {
    const src = detailSrc();
    expect(src).toMatch(/showEditInput|handleEdit|editReason|newArtifactId/);
  });

  it("imports editApproval from the API client", () => {
    const src = detailSrc();
    expect(src).toContain("editApproval");
  });
});
