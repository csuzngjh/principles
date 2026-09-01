/**
 * PRI-641 — Core Principles Console Boundary: browser-side contracts.
 *
 * Covers the fetchCorePrinciples API client, the network-shape validator,
 * the read-only Core page (no governance controls, no hardcoded registry
 * copy, no runtime-v2 import), App routing order, and the Debt regression
 * (DebtPage must rely on the server projection, not its own T-xx filter).
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fetchCorePrinciples } from "../../src/ui/api.js";
import {
  validateCorePrinciples,
  type CorePrinciplesData,
} from "../../src/ui/utils/validators.js";

// Mock sessionStorage (browser API not available in Node env)
const sessionStore: Record<string, string> = {};
vi.stubGlobal("sessionStorage", {
  getItem: vi.fn((key: string) => sessionStore[key] ?? null),
  setItem: vi.fn((key: string, value: string) => { sessionStore[key] = value; }),
  removeItem: vi.fn((key: string) => { delete sessionStore[key]; }),
  clear: vi.fn(() => { for (const k of Object.keys(sessionStore)) delete sessionStore[k]; }),
  key: vi.fn((index: number) => Object.keys(sessionStore)[index] ?? null),
  get length() { return Object.keys(sessionStore).length; },
});

vi.stubGlobal("fetch", vi.fn());

const PKG_ROOT = path.resolve(__dirname, "..", "..");
const UI_SRC = path.join(PKG_ROOT, "src", "ui");

function readUi(rel: string): string {
  return fs.readFileSync(path.join(UI_SRC, rel), "utf8");
}

const VALID_CORE_RESPONSE = {
  principles: [
    {
      id: "T-01",
      layer: "foundational",
      name: "Survey Before Acting",
      nameZh: "先梳理再行动",
      statement: "Build a sufficient model of the relevant system before making consequential changes.",
      statementZh: "在进行有后果的变更前，先建立对相关系统足够准确的理解。",
    },
    {
      id: "T-05",
      layer: "operating",
      name: "Safety Rails",
      nameZh: "安全护栏",
      statement: "Translate hard constraints into explicit guardrails.",
      statementZh: "在执行前，把不可突破的约束转化为明确的护栏。",
    },
  ],
};

// ── API client ───────────────────────────────────────────────────────────────

describe("fetchCorePrinciples", () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it("GETs /api/principles/core and returns validated data", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: VALID_CORE_RESPONSE }),
    } as Response);

    const result = await fetchCorePrinciples();

    expect(result.success).toBe(true);
    expect(fetch).toHaveBeenCalledWith("/api/principles/core", expect.anything());
    if (result.success) {
      expect(result.data.principles).toHaveLength(2);
      expect(result.data.principles[0]?.id).toBe("T-01");
    }
  });

  it("rejects a malformed core payload instead of falling back", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { principles: [{ id: "T-01", layer: "mystery", name: "x", nameZh: "x", statement: "x", statementZh: "x" }] },
      }),
    } as Response);

    const result = await fetchCorePrinciples();

    expect(result.success).toBe(false);
  });

  it("surfaces endpoint failure as an error result", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: "core_endpoint_failed" }),
    } as Response);

    const result = await fetchCorePrinciples();

    expect(result.success).toBe(false);
  });
});

// ── Network-shape validator ──────────────────────────────────────────────────

describe("validateCorePrinciples", () => {
  it("accepts a valid core payload", () => {
    const out = validateCorePrinciples(VALID_CORE_RESPONSE);
    expect(out).not.toBeNull();
    expect((out as CorePrinciplesData).principles).toHaveLength(2);
  });

  it("rejects non-object payloads", () => {
    expect(validateCorePrinciples(null)).toBeNull();
    expect(validateCorePrinciples("nope")).toBeNull();
    expect(validateCorePrinciples([])).toBeNull();
  });

  it("rejects a missing/non-array principles field", () => {
    expect(validateCorePrinciples({})).toBeNull();
    expect(validateCorePrinciples({ principles: "many" })).toBeNull();
  });

  it("rejects invalid layer values", () => {
    const bad = { ...VALID_CORE_RESPONSE, principles: [{ ...VALID_CORE_RESPONSE.principles[0]!, layer: "extra" }] };
    expect(validateCorePrinciples(bad)).toBeNull();
  });

  it("rejects empty required string fields", () => {
    for (const field of ["id", "name", "nameZh", "statement", "statementZh"] as const) {
      const bad = { ...VALID_CORE_RESPONSE, principles: [{ ...VALID_CORE_RESPONSE.principles[0]!, [field]: "" }] };
      expect(validateCorePrinciples(bad)).toBeNull();
    }
  });
});

// ── Core page source contracts ───────────────────────────────────────────────

describe("CorePrinciplesPage (source contract)", () => {
  const pageSrc = readUi(path.join("pages", "principles", "CorePrinciplesPage.tsx"));

  it("loads data via fetchCorePrinciples — no hardcoded principle registry", () => {
    expect(pageSrc).toContain("fetchCorePrinciples");
    expect(pageSrc).not.toContain("Survey Before Acting");
    expect(pageSrc).not.toContain("先梳理再行动");
    // No hardcoded registry entries (id literals in code; comments may mention the range)
    expect(pageSrc).not.toMatch(/id:\s*['"]T-\d/);
  });

  it("never runtime-imports the core runtime barrel", () => {
    expect(pageSrc).not.toContain("@principles/core/runtime-v2");
  });

  it("renders no governance/mutation controls", () => {
    expect(pageSrc).not.toContain("archivePrinciple");
    expect(pageSrc).not.toContain("unarchivePrinciple");
    expect(pageSrc).not.toContain("fetchApprovalsGrouped");
    expect(pageSrc).not.toMatch(/<Button[^>]*onClick=\{[^}]*archive/i);
  });

  it("groups by the two registry layers with derived counts", () => {
    expect(pageSrc).toContain('layer === "foundational"');
    expect(pageSrc).toContain('layer === "operating"');
    expect(pageSrc).toContain("principles.length");
  });

  it("localizes names/statements via the registry bilingual fields", () => {
    expect(pageSrc).toContain("nameZh");
    expect(pageSrc).toContain("statementZh");
  });

  it("shows an explicit load-failure state with retry", () => {
    expect(pageSrc).toContain("coreLoadFailed");
    expect(pageSrc).toContain("loadCore");
  });
});

describe("App routing (source contract)", () => {
  const appSrc = readUi("App.tsx");

  it("declares /principles/core before the /principles/:id catch-all", () => {
    const coreIdx = appSrc.indexOf('path="/principles/core"');
    const detailIdx = appSrc.indexOf('path="/principles/:id"');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(detailIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(detailIdx);
  });
});

describe("Workspace Principles page (source contract)", () => {
  const pageSrc = readUi(path.join("pages", "principles", "PrinciplesPage.tsx"));

  it("exposes the internal view nav to the Core reference surface", () => {
    expect(pageSrc).toContain("PrinciplesViewNav");
  });

  it("does not implement its own core-id filter (single boundary is the server projection)", () => {
    expect(pageSrc).not.toMatch(/startsWith\(['"]T-/);
    expect(pageSrc).not.toContain("isCorePrincipleId");
  });
});

describe("Debt regression (source contract)", () => {
  const debtSrc = readUi(path.join("pages", "debt", "DebtPage.tsx"));

  it("relies on the server workspace projection — no duplicated core filter", () => {
    // PRI-641: the boundary lives in the server read model; DebtPage must not
    // grow a second T-xx filter implementation.
    expect(debtSrc).toContain('fetchPrinciples("all")');
    expect(debtSrc).not.toMatch(/startsWith\(['"]T-/);
    expect(debtSrc).not.toContain("isCorePrincipleId");
  });
});

// ── i18n governance ──────────────────────────────────────────────────────────

describe("i18n keys for the Core surface", () => {
  const enJson = JSON.parse(fs.readFileSync(path.join(UI_SRC, "i18n", "en.json"), "utf8")) as {
    pages: { principles: Record<string, string> };
  };
  const zhJson = JSON.parse(fs.readFileSync(path.join(UI_SRC, "i18n", "zh-CN.json"), "utf8")) as {
    pages: { principles: Record<string, string> };
  };

  const REQUIRED_KEYS = [
    "viewNavLabel",
    "tabWorkspace",
    "tabCore",
    "coreTitle",
    "coreDescription",
    "coreReadOnly",
    "coreLayerFoundational",
    "coreLayerOperating",
    "coreLoadFailed",
    "coreRetry",
  ];

  for (const key of REQUIRED_KEYS) {
    it(`both locales define pages.principles.${key}`, () => {
      expect(enJson.pages.principles[key]).toBeTruthy();
      expect(zhJson.pages.principles[key]).toBeTruthy();
    });
  }

  it("i18n carries UI copy only — no core semantic content copy", () => {
    const enFlat = JSON.stringify(enJson.pages.principles);
    const zhFlat = JSON.stringify(zhJson.pages.principles);
    for (const banned of ["Survey Before Acting", "Evidence Over Assumption", "先梳理再行动", "证据优于假设"]) {
      expect(enFlat).not.toContain(banned);
      expect(zhFlat).not.toContain(banned);
    }
  });
});
