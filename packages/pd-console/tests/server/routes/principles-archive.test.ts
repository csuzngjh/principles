import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { handlePrinciplesRoute, disposePrinciplesModels } from "../../../src/server/routes/principles.js";
import { PrinciplesConsoleModel } from "../../../src/server/models/PrinciplesConsoleModel.js";

// ── Test utilities ───────────────────────────────────────────────────────────

function createMockRequest(
  method: string,
  options?: { body?: unknown; subPath?: string },
): IncomingMessage {
  const req = {
    method,
    url: `/api/principles${options?.subPath ?? ""}`,
  } as unknown as IncomingMessage;
  return req;
}

function createMockResponse(): ServerResponse & { _body: string; statusCode: number } {
  const res = {
    headersSent: false,
    statusCode: 200,
    _headers: {} as Record<string, string>,
    _body: "",
    writeHead: vi.fn(function (this: unknown, statusCode: number, headers?: Record<string, string>) {
      (this as { statusCode: number }).statusCode = statusCode;
      if (headers) {
        Object.assign((this as { _headers: Record<string, string> })._headers, headers);
      }
      return this;
    }),
    end: vi.fn(function (this: unknown, data?: string) {
      if (data !== undefined) {
        (this as { _body: string })._body = data;
      }
      return this;
    }),
  } as unknown as ServerResponse & { _body: string; statusCode: number };
  return res;
}

function writeLedger(workspaceDir: string, tree: Record<string, unknown>): void {
  const stateDir = path.join(workspaceDir, ".state");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, "principle_training_state.json"),
    JSON.stringify({ _tree: tree }, null, 2),
    "utf8",
  );
}

function readLedger(workspaceDir: string): Record<string, unknown> | null {
  const ledgerPath = path.join(workspaceDir, ".state", "principle_training_state.json");
  if (!fs.existsSync(ledgerPath)) return null;
  const content = fs.readFileSync(ledgerPath, "utf8");
  const parsed = JSON.parse(content) as Record<string, unknown>;
  return (parsed._tree ?? parsed.tree) as Record<string, unknown>;
}

// Runtime type narrowing helper (rc-2-no-as-bypass: no `as any` on untrusted
// parsed JSON). Narrows unknown → Record for nested ledger field access.
function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Principles archive and unarchive routes", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-principles-test-"));
  });

  afterEach(() => {
    disposePrinciplesModels();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("POST /api/principles/:id/archive changes status to archived", async () => {
    writeLedger(tempDir, {
      principles: {
        p1: {
          id: "p1",
          status: "active",
          text: "Test Rule",
          triggerPattern: "t1",
          action: "a1",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: "2026-05-01T00:00:00Z",
    });

    const req = createMockRequest("POST", { subPath: "/p1/archive" });
    const res = createMockResponse();

    await handlePrinciplesRoute({
      req,
      res,
      workspaceDir: tempDir,
      subPath: "/p1/archive",
    });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed.success).toBe(true);
    expect(parsed.data.principleId).toBe("p1");

    // Verify DB state
    const ledger = readLedger(tempDir);
    expect(ledger).not.toBeNull();
    if (!ledger) throw new Error("ledger should not be null");
    const principles = asRecord(ledger.principles);
    const p = asRecord(principles.p1);
    expect(p.status).toBe("archived");
  });

  it("POST /api/principles/:id/unarchive changes status to active", async () => {
    writeLedger(tempDir, {
      principles: {
        p1: {
          id: "p1",
          status: "archived",
          text: "Test Rule",
          triggerPattern: "t1",
          action: "a1",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      },
      rules: {},
      implementations: {},
      metrics: {},
      lastUpdated: "2026-05-01T00:00:00Z",
    });

    const req = createMockRequest("POST", { subPath: "/p1/unarchive" });
    const res = createMockResponse();

    await handlePrinciplesRoute({
      req,
      res,
      workspaceDir: tempDir,
      subPath: "/p1/unarchive",
    });

    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res._body);
    expect(parsed.success).toBe(true);
    expect(parsed.data.principleId).toBe("p1");

    // Verify DB state
    const ledger = readLedger(tempDir);
    expect(ledger).not.toBeNull();
    if (!ledger) throw new Error("ledger should not be null");
    const principles = asRecord(ledger.principles);
    const p = asRecord(principles.p1);
    expect(p.status).toBe("active");
  });

  it("model archive/unarchive returns false when file system fails", async () => {
    // Passing null/empty/invalid directory to trigger fs error
    const badModel = new PrinciplesConsoleModel("\0");
    const archiveResult = await badModel.archivePrinciple("p1");
    expect(archiveResult).toBe(false);

    const unarchiveResult = await badModel.unarchivePrinciple("p1");
    expect(unarchiveResult).toBe(false);
  });

  it("POST /api/principles//archive returns 400 when ID is missing", async () => {
    const req = createMockRequest("POST", { subPath: "//archive" });
    const res = createMockResponse();

    await handlePrinciplesRoute({
      req,
      res,
      workspaceDir: tempDir,
      subPath: "//archive",
    });

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res._body);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("invalid_principle_id");
  });

  it("POST /api/principles/:id/archive returns 400 when ID is invalid URL encoded", async () => {
    const req = createMockRequest("POST", { subPath: "/%E0%A0/archive" });
    const res = createMockResponse();

    await handlePrinciplesRoute({
      req,
      res,
      workspaceDir: tempDir,
      subPath: "/%E0%A0/archive",
    });

    expect(res.statusCode).toBe(400);
    const parsed = JSON.parse(res._body);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("invalid_principle_id");
  });

  it("POST /api/principles/:id/archive returns 500 when model returns false", async () => {
    const req = createMockRequest("POST", { subPath: "/p1/archive" });
    const res = createMockResponse();

    // Use bad workspace directory to trigger model failure (returns false)
    await handlePrinciplesRoute({
      req,
      res,
      workspaceDir: "\0",
      subPath: "/p1/archive",
    });

    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res._body);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("archive_failed");
  });

  it("POST /api/principles/:id/unarchive returns 500 when model returns false", async () => {
    const req = createMockRequest("POST", { subPath: "/p1/unarchive" });
    const res = createMockResponse();

    // Use bad workspace directory to trigger model failure (returns false)
    await handlePrinciplesRoute({
      req,
      res,
      workspaceDir: "\0",
      subPath: "/p1/unarchive",
    });

    expect(res.statusCode).toBe(500);
    const parsed = JSON.parse(res._body);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("unarchive_failed");
  });

  it("POST /api/principles/:id/archive returns 500 when model throws error", async () => {
    const req = createMockRequest("POST", { subPath: "/p1/archive" });
    const res = createMockResponse();

    const spy = vi.spyOn(PrinciplesConsoleModel.prototype, "archivePrinciple")
      .mockRejectedValue(new Error("forced archive error"));

    try {
      await handlePrinciplesRoute({
        req,
        res,
        workspaceDir: tempDir,
        subPath: "/p1/archive",
      });

      expect(res.statusCode).toBe(500);
      const parsed = JSON.parse(res._body);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toBe("forced archive error");
    } finally {
      spy.mockRestore();
    }
  });

  it("POST /api/principles/:id/unarchive returns 500 when model throws error", async () => {
    const req = createMockRequest("POST", { subPath: "/p1/unarchive" });
    const res = createMockResponse();

    const spy = vi.spyOn(PrinciplesConsoleModel.prototype, "unarchivePrinciple")
      .mockRejectedValue(new Error("forced unarchive error"));

    try {
      await handlePrinciplesRoute({
        req,
        res,
        workspaceDir: tempDir,
        subPath: "/p1/unarchive",
      });

      expect(res.statusCode).toBe(500);
      const parsed = JSON.parse(res._body);
      expect(parsed.success).toBe(false);
      expect(parsed.message).toBe("forced unarchive error");
    } finally {
      spy.mockRestore();
    }
  });
});
