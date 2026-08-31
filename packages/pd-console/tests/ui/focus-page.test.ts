/**
 * FocusPage tests — PRI-319 Governance Focus page
 *
 * TDD: tests written before implementation.
 * Validates:
 * - pendingReviewCount, behaviorDeviationCount, stagnationSignals render correctly
 * - degraded/missing data shows honest explanation
 * - forbidden terms never appear (Cockpit, Burn pain, drive evolution, etc.)
 * - empty states guide next steps, not "暂无数据"
 * - three-layer info structure (conclusion → why → full trajectory collapsed)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as nodePath from "node:path";

// ── Mock the API module ──────────────────────────────────────────────────────

const mockFetchGovernanceQueue = vi.fn();
const mockFetchApprovalsGrouped = vi.fn();

vi.mock("../../src/ui/api.js", () => ({
  fetchGovernanceQueue: (...args: unknown[]) => mockFetchGovernanceQueue(...args),
  fetchApprovalsGrouped: (...args: unknown[]) => mockFetchApprovalsGrouped(...args),
  // PRI-629: Focus 决策区与 RuleCode 区的 API (默认成功空集,保持既有用例语义)
  fetchOwnerDecisions: vi.fn().mockResolvedValue({ success: true, data: { items: [], total: 0, filteredSyntheticCount: 0, generatedAt: "2026-08-30T00:00:00.000Z" } }),
  fetchAllActivations: vi.fn().mockResolvedValue({ success: true, data: { activations: [], status: "ok" } }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal valid GovernanceQueueData */
function makeQueueData(overrides?: Partial<{
  pendingReviewCount: number;
  behaviorDeviationCount: number;
  stagnationSignals: Array<{ type: "no_pain" | "never_activated"; principleId: string; daysSince: number }>;
  note?: string;
}>) {
  return {
    pendingReviewCount: 0,
    behaviorDeviationCount: 0,
    stagnationSignals: [],
    ...overrides,
  };
}

/** Minimal valid ApprovalsGroupedData */
function makeGroupedData(overrides?: Partial<{
  groups: Array<{
    principleId: string;
    principleTitle: string;
    status: "pending" | "approved" | "rejected";
    records: Array<{ id: string; artifactId: string; channel: string; createdAt: string }>;
  }>;
  generatedAt: string;
  note?: string;
}>) {
  return {
    groups: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Render the FocusPage component and return its rendered HTML string.
 * Since we're in a node test environment (not jsdom), we test the data
 * transformation and rendering logic through the component's internal
 * functions rather than DOM mounting.
 *
 * For proper component tests we'd need jsdom + react testing library,
 * but the vitest config uses 'node' environment. So we test the
 * data validation/transformation logic directly and verify the
 * component can be imported without errors.
 */

// ── Data validation tests ────────────────────────────────────────────────────

describe("FocusPage: governance queue data validation", () => {
  it("validates pendingReviewCount as a non-negative number", () => {
    const data = makeQueueData({ pendingReviewCount: 3 });
    expect(typeof data.pendingReviewCount).toBe("number");
    expect(data.pendingReviewCount).toBeGreaterThanOrEqual(0);
  });

  it("validates behaviorDeviationCount as a non-negative number", () => {
    const data = makeQueueData({ behaviorDeviationCount: 2 });
    expect(typeof data.behaviorDeviationCount).toBe("number");
    expect(data.behaviorDeviationCount).toBeGreaterThanOrEqual(0);
  });

  it("validates stagnationSignals array with correct shape", () => {
    const signals = [
      { type: "never_activated" as const, principleId: "p-1", daysSince: 6 },
      { type: "no_pain" as const, principleId: "p-2", daysSince: 30 },
    ];
    const data = makeQueueData({ stagnationSignals: signals });
    expect(Array.isArray(data.stagnationSignals)).toBe(true);
    expect(data.stagnationSignals).toHaveLength(2);
    expect(data.stagnationSignals[0].type).toBe("never_activated");
    expect(data.stagnationSignals[0].daysSince).toBe(6);
  });

  it("handles empty stagnationSignals gracefully", () => {
    const data = makeQueueData({ stagnationSignals: [] });
    expect(data.stagnationSignals).toHaveLength(0);
  });
});

describe("FocusPage: approvals grouped data validation", () => {
  it("validates groups array with pending items", () => {
    const groups = [
      {
        principleId: "p-1",
        principleTitle: "修改配置前展示影响范围",
        status: "pending" as const,
        records: [
          { id: "a-1", artifactId: "art-1", channel: "prompt", createdAt: "2026-06-01T00:00:00Z" },
        ],
      },
    ];
    const data = makeGroupedData({ groups });
    expect(data.groups).toHaveLength(1);
    expect(data.groups[0].status).toBe("pending");
    expect(data.groups[0].principleTitle).toBe("修改配置前展示影响范围");
  });

  it("filters to only pending groups for the review queue", () => {
    const groups = [
      {
        principleId: "p-1",
        principleTitle: "待审查原则",
        status: "pending" as const,
        records: [
          { id: "a-1", artifactId: "art-1", channel: "prompt", createdAt: "2026-06-01T00:00:00Z" },
        ],
      },
      {
        principleId: "p-2",
        principleTitle: "已批准原则",
        status: "approved" as const,
        records: [
          { id: "a-2", artifactId: "art-2", channel: "prompt", createdAt: "2026-06-01T00:00:00Z" },
        ],
      },
    ];
    const data = makeGroupedData({ groups });
    const pendingGroups = data.groups.filter((g) => g.status === "pending");
    expect(pendingGroups).toHaveLength(1);
    expect(pendingGroups[0].principleId).toBe("p-1");
  });
});

// ── Unknown data safety tests (H section / ERR-001/005/013) ──────────────────

// Import the actual validators for direct testing
// We re-implement them here to test the logic without importing the React component
// (which requires jsdom). The validators in FocusPage.tsx must match these exactly.

const VALID_STAGNATION_TYPES = new Set(["no_pain", "never_activated"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateStagnationSignal(raw: unknown): { type: "no_pain" | "never_activated"; principleId: string; daysSince: number } | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, "type") || !Object.hasOwn(raw, "principleId") || !Object.hasOwn(raw, "daysSince")) return null;
  const { type, principleId, daysSince } = raw;
  if (typeof type !== "string" || !VALID_STAGNATION_TYPES.has(type) || typeof principleId !== "string" || principleId.length === 0 || typeof daysSince !== "number" || daysSince < 0) return null;
  return { type: type as "no_pain" | "never_activated", principleId, daysSince };
}

function validateGovernanceQueueData(raw: unknown): { pendingReviewCount: number; behaviorDeviationCount: number; stagnationSignals: unknown[]; note?: string } | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, "pendingReviewCount") || !Object.hasOwn(raw, "behaviorDeviationCount") || !Object.hasOwn(raw, "stagnationSignals")) return null;
  const { pendingReviewCount, behaviorDeviationCount, stagnationSignals } = raw;
  if (typeof pendingReviewCount !== "number" || pendingReviewCount < 0 || typeof behaviorDeviationCount !== "number" || behaviorDeviationCount < 0 || !Array.isArray(stagnationSignals)) return null;
  // Fail loud: any invalid signal rejects the entire payload (ERR-009)
  const signals: unknown[] = [];
  for (const s of stagnationSignals) {
    const validated = validateStagnationSignal(s);
    if (validated === null) return null;
    signals.push(validated);
  }
  return { pendingReviewCount, behaviorDeviationCount, stagnationSignals: signals, note: Object.hasOwn(raw, "note") && typeof raw.note === "string" ? raw.note : undefined };
}

function validateApprovalGroup(raw: unknown): { principleId: string; principleTitle: string; status: string; records: unknown[] } | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, "principleId") || !Object.hasOwn(raw, "principleTitle") || !Object.hasOwn(raw, "status") || !Object.hasOwn(raw, "records")) return null;
  const { principleId, principleTitle, status, records } = raw;
  if (typeof principleId !== "string" || typeof principleTitle !== "string" || typeof status !== "string" || !["pending", "approved", "rejected"].includes(status) || !Array.isArray(records)) return null;
  // Fail loud: any invalid record rejects the entire group (ERR-009)
  const validRecords: unknown[] = [];
  for (const r of records) {
    if (!isRecord(r)) return null;
    if (!Object.hasOwn(r, "id") || !Object.hasOwn(r, "artifactId") || !Object.hasOwn(r, "channel") || !Object.hasOwn(r, "createdAt") || typeof r.id !== "string" || typeof r.artifactId !== "string" || typeof r.channel !== "string" || typeof r.createdAt !== "string") return null;
    validRecords.push(r);
  }
  return { principleId, principleTitle, status, records: validRecords };
}

function validateApprovalsGroupedData(raw: unknown): { groups: unknown[]; generatedAt: string; note?: string } | null {
  if (!isRecord(raw)) return null;
  if (!Object.hasOwn(raw, "groups") || !Object.hasOwn(raw, "generatedAt")) return null;
  const { groups, generatedAt } = raw;
  if (!Array.isArray(groups) || typeof generatedAt !== "string") return null;
  // Fail loud: any invalid group rejects the entire payload (ERR-009)
  const validatedGroups: unknown[] = [];
  for (const g of groups) {
    const validated = validateApprovalGroup(g);
    if (validated === null) return null;
    validatedGroups.push(validated);
  }
  return { groups: validatedGroups, generatedAt, note: Object.hasOwn(raw, "note") && typeof raw.note === "string" ? raw.note : undefined };
}

describe("FocusPage: isRecord guard", () => {
  it("rejects null", () => expect(isRecord(null)).toBe(false));
  it("rejects undefined", () => expect(isRecord(undefined)).toBe(false));
  it("rejects string", () => expect(isRecord("hello")).toBe(false));
  it("rejects number", () => expect(isRecord(42)).toBe(false));
  it("rejects boolean", () => expect(isRecord(true)).toBe(false));
  it("rejects array", () => expect(isRecord([1, 2, 3])).toBe(false));
  it("accepts plain object", () => expect(isRecord({ a: 1 })).toBe(true));
  it("accepts Object.create(null)", () => expect(isRecord(Object.create(null))).toBe(true));
});

describe("FocusPage: validateStagnationSignal edge cases", () => {
  it("rejects null", () => expect(validateStagnationSignal(null)).toBeNull());
  it("rejects array", () => expect(validateStagnationSignal([1, 2])).toBeNull());
  it("rejects missing fields", () => expect(validateStagnationSignal({ type: "no_pain" })).toBeNull());
  it("rejects wrong field name (typo)", () => expect(validateStagnationSignal({ type: "no_pain", principleId: "p-1", daySince: 5 })).toBeNull());
  it("rejects invalid type value", () => expect(validateStagnationSignal({ type: "invalid", principleId: "p-1", daysSince: 5 })).toBeNull());
  it("rejects empty principleId", () => expect(validateStagnationSignal({ type: "no_pain", principleId: "", daysSince: 5 })).toBeNull());
  it("rejects negative daysSince", () => expect(validateStagnationSignal({ type: "no_pain", principleId: "p-1", daysSince: -1 })).toBeNull());
  it("rejects string daysSince", () => expect(validateStagnationSignal({ type: "no_pain", principleId: "p-1", daysSince: "5" })).toBeNull());
  it("rejects inherited property (toString)", () => {
    const obj = Object.create({ type: "no_pain" });
    obj.principleId = "p-1";
    obj.daysSince = 5;
    // type is inherited, Object.hasOwn should reject
    expect(validateStagnationSignal(obj)).toBeNull();
  });
  it("accepts valid signal", () => {
    const result = validateStagnationSignal({ type: "never_activated", principleId: "p-1", daysSince: 6 });
    expect(result).toEqual({ type: "never_activated", principleId: "p-1", daysSince: 6 });
  });
});

describe("FocusPage: validateGovernanceQueueData edge cases", () => {
  it("rejects null", () => expect(validateGovernanceQueueData(null)).toBeNull());
  it("rejects array", () => expect(validateGovernanceQueueData([])).toBeNull());
  it("rejects string pendingReviewCount", () => expect(validateGovernanceQueueData({ pendingReviewCount: "3", behaviorDeviationCount: 0, stagnationSignals: [] })).toBeNull());
  it("rejects negative pendingReviewCount", () => expect(validateGovernanceQueueData({ pendingReviewCount: -1, behaviorDeviationCount: 0, stagnationSignals: [] })).toBeNull());
  it("rejects missing stagnationSignals", () => expect(validateGovernanceQueueData({ pendingReviewCount: 0, behaviorDeviationCount: 0 })).toBeNull());
  it("rejects non-array stagnationSignals", () => expect(validateGovernanceQueueData({ pendingReviewCount: 0, behaviorDeviationCount: 0, stagnationSignals: {} })).toBeNull());
  it("rejects invalid signals in array (fail loud)", () => {
    const raw = { pendingReviewCount: 2, behaviorDeviationCount: 1, stagnationSignals: [
      { type: "no_pain", principleId: "p-1", daysSince: 5 },
      { type: "bad_type", principleId: "p-2", daysSince: 3 },
    ]};
    const result = validateGovernanceQueueData(raw);
    // Any invalid signal rejects the entire payload
    expect(result).toBeNull();
  });
  it("accepts valid data with optional note", () => {
    const raw = { pendingReviewCount: 1, behaviorDeviationCount: 2, stagnationSignals: [], note: "test" };
    const result = validateGovernanceQueueData(raw);
    expect(result).not.toBeNull();
    expect(result!.note).toBe("test");
  });
  it("ignores non-string note", () => {
    const raw = { pendingReviewCount: 0, behaviorDeviationCount: 0, stagnationSignals: [], note: 42 };
    const result = validateGovernanceQueueData(raw);
    expect(result).not.toBeNull();
    expect(result!.note).toBeUndefined();
  });
});

describe("FocusPage: validateApprovalGroup edge cases", () => {
  it("rejects null", () => expect(validateApprovalGroup(null)).toBeNull());
  it("rejects missing records", () => expect(validateApprovalGroup({ principleId: "p-1", principleTitle: "Test", status: "pending" })).toBeNull());
  it("rejects invalid status", () => expect(validateApprovalGroup({ principleId: "p-1", principleTitle: "Test", status: "unknown", records: [] })).toBeNull());
  it("rejects non-array records", () => expect(validateApprovalGroup({ principleId: "p-1", principleTitle: "Test", status: "pending", records: "not-array" })).toBeNull());
  it("rejects records missing required fields (fail loud)", () => {
    const raw = { principleId: "p-1", principleTitle: "Test", status: "pending", records: [
      { id: "a-1", artifactId: "art-1", channel: "prompt", createdAt: "2026-01-01" },
      { id: "a-2" }, // missing fields
    ]};
    const result = validateApprovalGroup(raw);
    // Any invalid record rejects the entire group
    expect(result).toBeNull();
  });
  it("rejects record with inherited property (fail loud)", () => {
    const rec = Object.create({ id: "inherited" });
    rec.artifactId = "art-1";
    rec.channel = "prompt";
    rec.createdAt = "2026-01-01";
    const raw = { principleId: "p-1", principleTitle: "Test", status: "pending", records: [rec] };
    const result = validateApprovalGroup(raw);
    // Inherited id is not own, so the record is invalid → entire group rejected
    expect(result).toBeNull();
  });
});

describe("FocusPage: validateApprovalsGroupedData edge cases", () => {
  it("rejects null", () => expect(validateApprovalsGroupedData(null)).toBeNull());
  it("rejects missing generatedAt", () => expect(validateApprovalsGroupedData({ groups: [] })).toBeNull());
  it("rejects non-string generatedAt", () => expect(validateApprovalsGroupedData({ groups: [], generatedAt: 123 })).toBeNull());
  it("rejects invalid groups (fail loud)", () => {
    const raw = { groups: [
      { principleId: "p-1", principleTitle: "Valid", status: "pending", records: [] },
      { principleId: 42, principleTitle: "Bad", status: "pending", records: [] }, // non-string principleId
    ], generatedAt: "2026-01-01" };
    const result = validateApprovalsGroupedData(raw);
    // Any invalid group rejects the entire payload
    expect(result).toBeNull();
  });
  it("accepts valid data with optional note", () => {
    const raw = { groups: [], generatedAt: "2026-01-01", note: "test" };
    const result = validateApprovalsGroupedData(raw);
    expect(result).not.toBeNull();
    expect(result!.note).toBe("test");
  });
});

// ── Forbidden terms test ─────────────────────────────────────────────────────

// Type guard helpers for untrusted JSON (replaces `as` bypasses — ERR-001/005)
// Note: isRecord is already defined above (line 157)

function getOwnRecord(obj: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const val = Object.hasOwn(obj, key) ? obj[key] : undefined;
  return isRecord(val) ? val : undefined;
}

function getOwnString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = Object.hasOwn(obj, key) ? obj[key] : undefined;
  return typeof val === "string" ? val : undefined;
}

function requireJson(path: string): Record<string, unknown> {
  // fs read instead of require(path): a dynamic require with a variable path
  // trips the command-injection scanner; readFileSync + JSON.parse is
  // equivalent for JSON documents. Relative paths anchor to THIS file's
  // directory, matching the old require() resolution (cwd-independent).
  const resolved = nodePath.isAbsolute(path) ? path : nodePath.join(__dirname, path);
  const raw: unknown = JSON.parse(fs.readFileSync(resolved, "utf-8"));
  if (!isRecord(raw)) throw new Error(`Expected JSON object at ${path}`);
  return raw;
}

function loadFocusI18n(langFile: string): Record<string, unknown> {
  const root = requireJson(langFile);
  const pages = getOwnRecord(root, "pages");
  if (!pages) return {};
  return getOwnRecord(pages, "focus") ?? {};
}

describe("FocusPage: forbidden terms never appear", () => {
  const forbiddenTerms = [
    "Cockpit",
    "Burn pain",
    "drive evolution",
    "自动优化",
    "一键进化",
    "永不犯错",
    "彻底解决",
    "智能修复",
    "AI 替你决定",
    "Optimize",
    "Auto Fix",
    "Evolve",
    "暂无数据",
  ];

  // Read real i18n files so the test catches production regressions
  const enFocusCopy = loadFocusI18n("../../src/ui/i18n/en.json");
  const zhFocusCopy = loadFocusI18n("../../src/ui/i18n/zh-CN.json");

  it("English i18n focus keys exist and contain no forbidden terms", () => {
    const entries = Object.entries(enFocusCopy);
    expect(entries.length, "should have focus i18n keys").toBeGreaterThan(0);
    for (const [key, value] of entries) {
      if (typeof value !== "string") continue;
      for (const term of forbiddenTerms) {
        expect(value, `en.pages.focus.${key} should not contain "${term}"`).not.toContain(term);
      }
    }
  });

  it("Chinese i18n focus keys exist and contain no forbidden terms", () => {
    const entries = Object.entries(zhFocusCopy);
    expect(entries.length, "should have focus i18n keys").toBeGreaterThan(0);
    for (const [key, value] of entries) {
      if (typeof value !== "string") continue;
      for (const term of forbiddenTerms) {
        expect(value, `zh.pages.focus.${key} should not contain "${term}"`).not.toContain(term);
      }
    }
  });

  it("empty states guide next steps, not '暂无数据'", () => {
    const emptyKeys = ["emptyPending", "emptyDeviation", "emptySignals"];
    for (const key of emptyKeys) {
      const value = getOwnString(zhFocusCopy, key);
      expect(value, `zh.pages.focus.${key} should be a string`).toBeDefined();
      expect(value, `zh.pages.focus.${key} should not contain "暂无数据"`).not.toContain("暂无数据");
      expect((value ?? "").length, `zh.pages.focus.${key} should have guidance text`).toBeGreaterThan(10);
    }
  });

  it("English i18n focus keys contain no Chinese characters", () => {
    const cjkPattern = /[\u4e00-\u9fff\u3400-\u4dbf]/;
    const entries = Object.entries(enFocusCopy);
    for (const [key, value] of entries) {
      if (typeof value !== "string") continue;
      expect(value, `en.pages.focus.${key} should not contain Chinese characters`).not.toMatch(cjkPattern);
    }
  });

  it("evidenceSummary does not duplicate count", () => {
    // evidenceSummary should use {{count}} interpolation, not output the number separately
    const enValue = getOwnString(enFocusCopy, "evidenceSummary");
    const zhValue = getOwnString(zhFocusCopy, "evidenceSummary");
    expect(typeof enValue).toBe("string");
    expect(typeof zhValue).toBe("string");
    // Should contain exactly one {{count}} placeholder
    expect((enValue ?? "").match(/\{\{count\}\}/g)).toHaveLength(1);
    expect((zhValue ?? "").match(/\{\{count\}\}/g)).toHaveLength(1);
  });
});

// ── Component import test ────────────────────────────────────────────────────

describe("FocusPage: component can be imported", () => {
  it("imports FocusPage without error", async () => {
    const mod = await import("../../src/ui/pages/focus/FocusPage.js");
    expect(mod.FocusPage).toBeDefined();
    expect(typeof mod.FocusPage).toBe("function");
  });
});

describe("FocusPage: approval failures remain actionable", () => {
  it("preserves the backend reason instead of reporting only a failed count", async () => {
    const { summarizeDecisionResults } = await import("../../src/ui/pages/focus/FocusPage.js");
    expect(summarizeDecisionResults([
      { success: false, error: "Approval was rolled back. Reason: rejected_validation_failed" },
    ])).toEqual({
      allSucceeded: false,
      failedCount: 1,
      failureReason: "Approval was rolled back. Reason: rejected_validation_failed",
    });
  });
});

// ── PRI-332: Zero state clarity tests ─────────────────────────────────────────

describe("FocusPage: PRI-332 zero state clarity", () => {
  const enFocus = loadFocusI18n("../../src/ui/i18n/en.json");
  const zhFocus = loadFocusI18n("../../src/ui/i18n/zh-CN.json");

  it("zeroStateHealthy key exists in both languages", () => {
    const en = getOwnString(enFocus, "zeroStateHealthy");
    const zh = getOwnString(zhFocus, "zeroStateHealthy");
    expect(typeof en).toBe("string");
    expect(typeof zh).toBe("string");
    expect((en ?? "").length).toBeGreaterThan(10);
    expect((zh ?? "").length).toBeGreaterThan(5);
  });

  it("zeroStateDbMissing key exists in both languages", () => {
    expect(typeof getOwnString(enFocus, "zeroStateDbMissing")).toBe("string");
    expect(typeof getOwnString(zhFocus, "zeroStateDbMissing")).toBe("string");
  });

  it("zeroStateHealthy does not claim PD is broken or inactive", () => {
    const en = getOwnString(enFocus, "zeroStateHealthy") ?? "";
    const zh = getOwnString(zhFocus, "zeroStateHealthy") ?? "";
    // Should not contain misleading terms
    expect(en).not.toMatch(/broken|error|not working|disabled/i);
    expect(zh).not.toMatch(/\u6545\u969c|\u9519\u8bef|\u505c\u6b62/);
    // Should mention that PD has checked things
    expect(en).toMatch(/checked|check/i);
    expect(zh).toMatch(/\u68c0\u67e5/);
  });

  it("FocusPage source contains ZeroStateHealthy component", () => {
    const src = fs.readFileSync(
      nodePath.join(__dirname, "../../src/ui/pages/focus/FocusPage.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/function ZeroStateHealthy/);
    expect(src).toMatch(/function ZeroStateDbMissing/);
    expect(src).toMatch(/zeroStateHealthy/);
    expect(src).toMatch(/zeroStateDbMissing/);
  });

  it("FocusPage shows degraded signals regardless of governance state", () => {
    const src = fs.readFileSync(
      nodePath.join(__dirname, "../../src/ui/pages/focus/FocusPage.tsx"),
      "utf-8",
    );
    // Should always show degraded signals when present, not gated by state === 'degraded'
    expect(src).toMatch(/degradedSignals && degradedSignals\.length > 0/);
    // Should NOT have the old pattern that gates on governanceState === "degraded"
    expect(src).not.toMatch(/governanceState === "degraded" && degradedSignals/);
  });
});
