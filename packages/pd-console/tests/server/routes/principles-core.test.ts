/**
 * PRI-641 — Core Principles Console Boundary: route-level contracts.
 *
 * Covers GET /api/principles/core (canonical registry serialization), the
 * 403 immutable_core_principle mutation contract (with no-write proof), the
 * 404 core_principle_not_owner_managed detail contract, and the dispatch
 * ordering guarantee that keeps "core" out of the /:id detail matcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { CORE_PRINCIPLES } from "@principles/core/runtime-v2";
import {
  handlePrinciplesRoute,
  handleCorePrinciplesRoute,
  disposePrinciplesModels,
} from "../../../src/server/routes/principles.js";

// ── Test utilities (same shape as principles-archive.test.ts) ────────────────

function createMockRequest(
  method: string,
  options?: { subPath?: string; url?: string },
): IncomingMessage {
  const req = {
    method,
    url: options?.url ?? `/api/principles${options?.subPath ?? ""}`,
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

function readLedgerRaw(workspaceDir: string): string {
  return fs.readFileSync(
    path.join(workspaceDir, ".state", "principle_training_state.json"),
    "utf8",
  );
}

function coreLedgerFixture(): Record<string, unknown> {
  return {
    principles: {
      "T-01": {
        id: "T-01",
        text: "Builtin axiom (experimental workspace copy)",
        triggerPattern: "always",
        action: "plan",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      "P-001": {
        id: "P-001",
        text: "Workspace principle",
        triggerPattern: "error",
        action: "fix",
        status: "active",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      },
    },
    rules: {},
    implementations: {},
    metrics: {},
    lastUpdated: "2026-05-01T00:00:00Z",
  };
}

function parseBody(res: { _body: string }): Record<string, unknown> {
  return JSON.parse(res._body) as Record<string, unknown>;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/principles/core — canonical registry endpoint", () => {
  it("returns exactly the 10 canonical core principles (6 foundational / 4 operating)", async () => {
    const req = createMockRequest("GET");
    const res = createMockResponse();

    await handleCorePrinciplesRoute(req, res);

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    expect(body.success).toBe(true);
    const data = body.data as { principles: Array<Record<string, unknown>> };
    expect(data.principles).toHaveLength(10);
    expect(data.principles.filter((p) => p.layer === "foundational")).toHaveLength(6);
    expect(data.principles.filter((p) => p.layer === "operating")).toHaveLength(4);
  });

  it("serves data identical to the canonical CORE_PRINCIPLES registry", async () => {
    const req = createMockRequest("GET");
    const res = createMockResponse();

    await handleCorePrinciplesRoute(req, res);

    const data = parseBody(res).data as { principles: unknown[] };
    expect(data.principles).toEqual(CORE_PRINCIPLES.map((p) => ({ ...p })));
  });

  it("returns only the minimal contract fields (no summary / readOnly)", async () => {
    const req = createMockRequest("GET");
    const res = createMockResponse();

    await handleCorePrinciplesRoute(req, res);

    const data = parseBody(res).data as { principles: Array<Record<string, unknown>> };
    const allowed = new Set(["id", "layer", "name", "nameZh", "statement", "statementZh"]);
    for (const p of data.principles) {
      expect(Object.keys(p).every((k) => allowed.has(k))).toBe(true);
    }
    expect(Object.hasOwn(data, "summary")).toBe(false);
    expect(Object.hasOwn(data, "readOnly")).toBe(false);
  });

  it("rejects non-GET methods", async () => {
    const req = createMockRequest("POST");
    const res = createMockResponse();

    await handleCorePrinciplesRoute(req, res);

    expect(res.statusCode).toBe(404);
    const body = parseBody(res);
    expect(body.success).toBe(false);
  });
});

describe("PRI-641: core principle mutation + detail boundaries (routes)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-principles-core-test-"));
  });

  afterEach(() => {
    disposePrinciplesModels();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("POST /api/principles/T-01/archive → 403 immutable_core_principle with nextAction", async () => {
    writeLedger(tempDir, coreLedgerFixture());
    const before = readLedgerRaw(tempDir);

    const req = createMockRequest("POST", { subPath: "/T-01/archive" });
    const res = createMockResponse();
    await handlePrinciplesRoute({ req, res, workspaceDir: tempDir, subPath: "/T-01/archive" });

    expect(res.statusCode).toBe(403);
    const body = parseBody(res);
    expect(body.success).toBe(false);
    expect(body.error).toBe("immutable_core_principle");
    expect(body.nextAction).toBe("View this principle under PD Core Principles.");
    // No-write proof: ledger bytes unchanged
    expect(readLedgerRaw(tempDir)).toBe(before);
  });

  it("POST /api/principles/T-01/unarchive → 403 immutable_core_principle with no write", async () => {
    writeLedger(tempDir, coreLedgerFixture());
    const before = readLedgerRaw(tempDir);

    const req = createMockRequest("POST", { subPath: "/T-01/unarchive" });
    const res = createMockResponse();
    await handlePrinciplesRoute({ req, res, workspaceDir: tempDir, subPath: "/T-01/unarchive" });

    expect(res.statusCode).toBe(403);
    const body = parseBody(res);
    expect(body.error).toBe("immutable_core_principle");
    expect(readLedgerRaw(tempDir)).toBe(before);
  });

  it("POST archive for a core id absent from the ledger is still refused (registry-driven)", async () => {
    writeLedger(tempDir, coreLedgerFixture());
    const before = readLedgerRaw(tempDir);

    const req = createMockRequest("POST", { subPath: "/T-07/archive" });
    const res = createMockResponse();
    await handlePrinciplesRoute({ req, res, workspaceDir: tempDir, subPath: "/T-07/archive" });

    expect(res.statusCode).toBe(403);
    expect(parseBody(res).error).toBe("immutable_core_principle");
    expect(readLedgerRaw(tempDir)).toBe(before);
  });

  it("POST archive/unarchive for an ordinary principle still succeeds", async () => {
    writeLedger(tempDir, coreLedgerFixture());

    const archiveReq = createMockRequest("POST", { subPath: "/P-001/archive" });
    const archiveRes = createMockResponse();
    await handlePrinciplesRoute({ req: archiveReq, res: archiveRes, workspaceDir: tempDir, subPath: "/P-001/archive" });
    expect(archiveRes.statusCode).toBe(200);
    expect(parseBody(archiveRes).success).toBe(true);

    const unarchiveReq = createMockRequest("POST", { subPath: "/P-001/unarchive" });
    const unarchiveRes = createMockResponse();
    await handlePrinciplesRoute({ req: unarchiveReq, res: unarchiveRes, workspaceDir: tempDir, subPath: "/P-001/unarchive" });
    expect(unarchiveRes.statusCode).toBe(200);
    expect(parseBody(unarchiveRes).success).toBe(true);
  });

  it("GET /api/principles/T-03 → 404 core_principle_not_owner_managed", async () => {
    writeLedger(tempDir, coreLedgerFixture());

    const req = createMockRequest("GET", { subPath: "/T-03" });
    const res = createMockResponse();
    await handlePrinciplesRoute({ req, res, workspaceDir: tempDir, subPath: "/T-03" });

    expect(res.statusCode).toBe(404);
    const body = parseBody(res);
    expect(body.error).toBe("core_principle_not_owner_managed");
    expect(body.nextAction).toBe("View this principle under PD Core Principles.");
  });

  it("GET /api/principles/P-001 → ordinary detail still works", async () => {
    writeLedger(tempDir, coreLedgerFixture());

    const req = createMockRequest("GET", { subPath: "/P-001" });
    const res = createMockResponse();
    await handlePrinciplesRoute({ req, res, workspaceDir: tempDir, subPath: "/P-001" });

    expect(res.statusCode).toBe(200);
    const body = parseBody(res);
    const detail = (body.data as { principle: { id: string } }).principle;
    expect(detail.id).toBe("P-001");
  });

  it("workspace list route no longer serves builtin principles under filter=all", async () => {
    writeLedger(tempDir, coreLedgerFixture());

    const req = createMockRequest("GET", { url: "/api/principles?filter=all" });
    const res = createMockResponse();
    await handlePrinciplesRoute({ req, res, workspaceDir: tempDir, subPath: "" });

    expect(res.statusCode).toBe(200);
    const data = parseBody(res).data as {
      principles: Array<{ id: string }>;
      summary: { total: number; active: number };
    };
    expect(data.principles.map((p) => p.id)).toEqual(["P-001"]);
    expect(data.summary.total).toBe(1);
    expect(data.summary.active).toBe(1);
  });

  it("dispatch guard: generic /:id matcher would treat 'core' as an id — index.ts must special-case it", async () => {
    // This documents WHY server/index.ts dispatches /api/principles/core to
    // handleCorePrinciplesRoute before the /api/principles prefix catch-all:
    // if it ever fell through to the generic handler, "core" would be parsed
    // as a principle id (404 not_found) instead of serving the core surface.
    writeLedger(tempDir, coreLedgerFixture());

    const req = createMockRequest("GET", { subPath: "/core" });
    const res = createMockResponse();
    await handlePrinciplesRoute({ req, res, workspaceDir: tempDir, subPath: "/core" });

    expect(res.statusCode).toBe(404);
    expect(parseBody(res).error).toBe("not_found");
  });
});

describe("PRI-641: /api/principles/core dispatch ordering (source contract)", () => {
  const serverIndexPath = path.resolve(__dirname, "..", "..", "..", "src", "server", "index.ts");

  it("index.ts dispatches /api/principles/core before the /api/principles catch-all", () => {
    const source = fs.readFileSync(serverIndexPath, "utf8");
    const coreIdx = source.indexOf("urlPath === '/api/principles/core'");
    const catchAllIdx = source.indexOf("urlPath.startsWith('/api/principles/')");
    expect(coreIdx).toBeGreaterThan(-1);
    expect(catchAllIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(catchAllIdx);
  });
});
