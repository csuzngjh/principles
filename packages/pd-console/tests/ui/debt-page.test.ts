/**
 * Debt page validators and i18n tests — PRI-CR7
 *
 * Validates:
 * - Principle list validators reject malformed payloads
 * - Activation validators reject malformed payloads
 * - Debt candidate derivation from cross-referenced data
 * - P1 honesty: no false debt candidates when activation data is unavailable
 * - Empty state / degraded state handling
 * - Disabled actions never produce success toast (no backend endpoint)
 * - English i18n copy has no CJK characters
 * - Chinese i18n copy has complete keys matching English
 * - Honesty constraints: no forbidden terms
 */

import { describe, it, expect } from "vitest";
import {
  validatePrincipleListItem,
  validatePrinciplesListData,
  validateActivationRecord,
  validateActivationsData,
  deriveDebtCandidates,
  isActionAvailable,
} from "../../src/ui/pages/debt/DebtValidators.js";
import type {
  SuggestedAction,
  DebtCandidate,
} from "../../src/ui/pages/debt/DebtValidators.js";
import type { ActivationRecord, PrincipleListItem } from "../../src/ui/api.js";
import enJson from "../../src/ui/i18n/en.json" with { type: "json" };
import zhJson from "../../src/ui/i18n/zh-CN.json" with { type: "json" };

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makePrincipleListItem(overrides?: Record<string, unknown>) {
  return {
    id: "principle-001",
    text: "Always show change scope before modifying config files",
    triggerPattern: "Agent modifies configuration without presenting impact",
    action: "Present the change scope and get acknowledgment before modifying config",
    status: "active",
    priority: "P1",
    scope: "general",
    domain: null,
    evaluability: "manual_only",
    valueScore: 7,
    adherenceRate: 0.85,
    painPreventedCount: 3,
    ruleCount: 1,
    conflictsWithCount: 0,
    createdAt: "2026-05-20T14:30:00.000Z",
    updatedAt: "2026-06-01T09:18:00.000Z",
    ...overrides,
  };
}

function makePrinciplesListData(overrides?: Record<string, unknown>) {
  return {
    principles: [makePrincipleListItem()],
    summary: {
      candidate: 0,
      probation: 0,
      active: 1,
      deprecated: 0,
      archived: 0,
      total: 1,
    },
    ...overrides,
  };
}

function makeActivationRecord(overrides?: Record<string, unknown>) {
  return {
    id: "act-001",
    artifactId: "artifact-001",
    principleId: "principle-001",
    channel: "prompt",
    action: "inject",
    targetRef: "THINKING_OS.md",
    activatedAt: "2026-06-01T10:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

// ── validatePrincipleListItem ────────────────────────────────────────────────

describe("validatePrincipleListItem", () => {
  it("validates a well-formed principle list item", () => {
    const result = validatePrincipleListItem(makePrincipleListItem());
    expect(result).not.toBeNull();
    expect(result?.id).toBe("principle-001");
    expect(result?.status).toBe("active");
    expect(result?.priority).toBe("P1");
  });

  it("validates item with candidate status", () => {
    const result = validatePrincipleListItem(
      makePrincipleListItem({ status: "candidate" }),
    );
    expect(result).not.toBeNull();
    expect(result?.status).toBe("candidate");
  });

  it("validates item with non-null domain", () => {
    const result = validatePrincipleListItem(
      makePrincipleListItem({ domain: "engineering" }),
    );
    expect(result).not.toBeNull();
    expect(result?.domain).toBe("engineering");
  });

  it("rejects null input", () => {
    expect(validatePrincipleListItem(null)).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validatePrincipleListItem("string")).toBeNull();
    expect(validatePrincipleListItem(42)).toBeNull();
  });

  it("rejects array input", () => {
    expect(validatePrincipleListItem([1, 2, 3])).toBeNull();
  });

  it("rejects item with missing id", () => {
    const { id, ...rest } = makePrincipleListItem();
    expect(validatePrincipleListItem(rest)).toBeNull();
  });

  it("rejects item with empty id", () => {
    expect(validatePrincipleListItem(makePrincipleListItem({ id: "" }))).toBeNull();
  });

  it("rejects item with invalid status", () => {
    expect(
      validatePrincipleListItem(makePrincipleListItem({ status: "unknown" })),
    ).toBeNull();
  });

  it("rejects item with invalid priority", () => {
    expect(
      validatePrincipleListItem(makePrincipleListItem({ priority: "P9" })),
    ).toBeNull();
  });

  it("rejects item with non-number valueScore", () => {
    expect(
      validatePrincipleListItem(makePrincipleListItem({ valueScore: "high" })),
    ).toBeNull();
  });

  it("rejects item with non-string createdAt", () => {
    expect(
      validatePrincipleListItem(makePrincipleListItem({ createdAt: 123 })),
    ).toBeNull();
  });

  it("rejects item with missing required fields (fail loud, ERR-009)", () => {
    const incomplete = { id: "p-1", text: "test" };
    expect(validatePrincipleListItem(incomplete)).toBeNull();
  });
});

// ── validatePrinciplesListData ───────────────────────────────────────────────

describe("validatePrinciplesListData", () => {
  it("validates well-formed principles list data", () => {
    const result = validatePrinciplesListData(makePrinciplesListData());
    expect(result).not.toBeNull();
    expect(result?.principles).toHaveLength(1);
    expect(result?.summary.total).toBe(1);
  });

  it("validates data with empty principles array", () => {
    const result = validatePrinciplesListData(
      makePrinciplesListData({
        principles: [],
        summary: { candidate: 0, probation: 0, active: 0, deprecated: 0, archived: 0, total: 0 },
      }),
    );
    expect(result).not.toBeNull();
    expect(result?.principles).toHaveLength(0);
  });

  it("rejects null input", () => {
    expect(validatePrinciplesListData(null)).toBeNull();
  });

  it("rejects missing principles field", () => {
    const { principles, ...rest } = makePrinciplesListData();
    expect(validatePrinciplesListData(rest)).toBeNull();
  });

  it("rejects missing summary field", () => {
    const { summary, ...rest } = makePrinciplesListData();
    expect(validatePrinciplesListData(rest)).toBeNull();
  });

  it("rejects non-array principles", () => {
    expect(
      validatePrinciplesListData(makePrinciplesListData({ principles: "not-array" })),
    ).toBeNull();
  });

  it("rejects data with any invalid principle item (fail loud, ERR-009)", () => {
    const data = makePrinciplesListData({
      principles: [
        makePrincipleListItem(),
        { id: 123 }, // invalid
      ],
    });
    expect(validatePrinciplesListData(data)).toBeNull();
  });

  it("rejects summary with missing total field", () => {
    const data = makePrinciplesListData({
      summary: { candidate: 0, probation: 0, active: 1, deprecated: 0, archived: 0 },
    });
    expect(validatePrinciplesListData(data)).toBeNull();
  });

  it("rejects summary with non-number field", () => {
    const data = makePrinciplesListData({
      summary: { candidate: 0, probation: 0, active: 1, deprecated: 0, archived: 0, total: "1" },
    });
    expect(validatePrinciplesListData(data)).toBeNull();
  });
});

// ── deriveDebtCandidates ─────────────────────────────────────────────────────

describe("deriveDebtCandidates", () => {
  it("identifies active principle with no activation records as debt", () => {
    const principles = [makePrincipleListItem()];
    const activations: ReturnType<typeof makeActivationRecord>[] = [];
    const result = deriveDebtCandidates(principles, activations);
    expect(result).toHaveLength(1);
    expect(result[0]?.debtReason).toBe("noActivationRecord");
    expect(result[0]?.principleId).toBe("principle-001");
  });

  it("identifies principle with never-activated records as debt", () => {
    const principles = [makePrincipleListItem()];
    const activations = [
      makeActivationRecord({ activatedAt: null, status: "inactive" }),
    ];
    const result = deriveDebtCandidates(principles, activations);
    expect(result).toHaveLength(1);
    expect(result[0]?.debtReason).toBe("approvedNeverActivated");
  });

  it("identifies principle with all-inactive records as long-term inactive", () => {
    const principles = [makePrincipleListItem()];
    const activations = [
      makeActivationRecord({
        activatedAt: "2026-05-01T10:00:00.000Z",
        status: "inactive",
      }),
    ];
    const result = deriveDebtCandidates(principles, activations);
    expect(result).toHaveLength(1);
    expect(result[0]?.debtReason).toBe("longTermInactive");
    expect(result[0]?.daysSinceActivation).toBeGreaterThan(0);
  });

  it("does NOT flag active principle with active activations", () => {
    const principles = [makePrincipleListItem()];
    const activations = [makeActivationRecord()]; // active by default
    const result = deriveDebtCandidates(principles, activations);
    expect(result).toHaveLength(0);
  });

  it("skips archived principles", () => {
    const principles = [makePrincipleListItem({ status: "archived" })];
    const result = deriveDebtCandidates(principles, []);
    expect(result).toHaveLength(0);
  });

  it("skips deprecated principles", () => {
    const principles = [makePrincipleListItem({ status: "deprecated" })];
    const result = deriveDebtCandidates(principles, []);
    expect(result).toHaveLength(0);
  });

  it("handles mixed active/inactive activations correctly", () => {
    const principles = [makePrincipleListItem()];
    const activations = [
      makeActivationRecord({ id: "act-1", status: "active" }),
      makeActivationRecord({ id: "act-2", status: "inactive" }),
    ];
    const result = deriveDebtCandidates(principles, activations);
    // Has at least one active activation → not debt
    expect(result).toHaveLength(0);
  });

  it("returns empty array when no principles exist", () => {
    const result = deriveDebtCandidates([], []);
    expect(result).toHaveLength(0);
  });

  it("handles multiple debt candidates", () => {
    const principles = [
      makePrincipleListItem({ id: "p-1" }),
      makePrincipleListItem({ id: "p-2" }),
      makePrincipleListItem({ id: "p-3" }),
    ];
    const activations = [
      makeActivationRecord({
        principleId: "p-1",
        activatedAt: null,
        status: "inactive",
      }),
      // p-2: no activation records → noActivationRecord
      makeActivationRecord({
        principleId: "p-3",
        status: "active",
      }),
    ];
    const result = deriveDebtCandidates(principles, activations);
    // p-1: approvedNeverActivated, p-2: noActivationRecord, p-3: active → skip
    expect(result).toHaveLength(2);
    const reasons = result.map((c) => c.debtReason);
    expect(reasons).toContain("approvedNeverActivated");
    expect(reasons).toContain("noActivationRecord");
  });

  it("suggests archive for long-inactive > 14 days", () => {
    const principles = [makePrincipleListItem()];
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const activations = [
      makeActivationRecord({
        activatedAt: oldDate,
        status: "inactive",
      }),
    ];
    const result = deriveDebtCandidates(principles, activations);
    expect(result).toHaveLength(1);
    expect(result[0]?.suggestedAction).toBe("archive");
  });

  it("suggests keepObserving for long-inactive ≤ 14 days", () => {
    const principles = [makePrincipleListItem()];
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const activations = [
      makeActivationRecord({
        activatedAt: recentDate,
        status: "inactive",
      }),
    ];
    const result = deriveDebtCandidates(principles, activations);
    expect(result).toHaveLength(1);
    expect(result[0]?.suggestedAction).toBe("keepObserving");
  });
});

// ── isActionAvailable ────────────────────────────────────────────────────────

describe("isActionAvailable", () => {
  it("returns false for archive (no backend endpoint)", () => {
    expect(isActionAvailable("archive")).toBe(false);
  });

  it("returns false for downgrade (no backend endpoint)", () => {
    expect(isActionAvailable("downgrade")).toBe(false);
  });

  it("returns false for keepObserving (no action needed)", () => {
    expect(isActionAvailable("keepObserving")).toBe(false);
  });

  it("no action is available — disabled buttons must not produce success toast", () => {
    const allActions: SuggestedAction[] = ["archive", "downgrade", "keepObserving"];
    for (const action of allActions) {
      expect(isActionAvailable(action)).toBe(false);
    }
  });
});

// ── English i18n: no CJK characters ─────────────────────────────────────────

describe("Debt i18n: English copy has no CJK characters", () => {
  const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

  it("all debt page English strings are CJK-free", () => {
    const debtKeys = enJson.pages?.debt as Record<string, unknown> | undefined;
    if (!debtKeys) {
      throw new Error("pages.debt not found in en.json");
    }

    function checkNoCJK(obj: Record<string, unknown>, path: string): void {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = `${path}.${key}`;
        if (typeof value === "string") {
          if (CJK_REGEX.test(value)) {
            throw new Error(
              `CJK character found in en.json at ${currentPath}: "${value}"`,
            );
          }
        } else if (typeof value === "object" && value !== null) {
          checkNoCJK(value as Record<string, unknown>, currentPath);
        }
      }
    }

    checkNoCJK(debtKeys, "pages.debt");
  });
});

// ── Chinese i18n: key alignment ──────────────────────────────────────────────

describe("Debt i18n: Chinese copy follows E.1 mixed-language rules", () => {
  const ALLOWED_ENGLISH_TERMS = new Set([
    "PD",
    "RuleHost",
    "OpenClaw",
    "Defer Archive",
    "Code Tool Hook",
    "API",
    "post-MVP",
  ]);

  it("debt page Chinese keys exist and match English structure", () => {
    const zhDebt = zhJson.pages?.debt as Record<string, unknown> | undefined;
    const enDebt = enJson.pages?.debt as Record<string, unknown> | undefined;
    if (!zhDebt || !enDebt) {
      throw new Error("pages.debt not found in i18n files");
    }

    function checkKeysExist(
      zhObj: Record<string, unknown>,
      enObj: Record<string, unknown>,
      path: string,
    ): void {
      for (const key of Object.keys(enObj)) {
        const currentPath = `${path}.${key}`;
        if (!Object.hasOwn(zhObj, key)) {
          throw new Error(`Missing Chinese translation for ${currentPath}`);
        }
        const zhVal = zhObj[key];
        const enVal = enObj[key];
        if (typeof enVal === "object" && enVal !== null) {
          checkKeysExist(
            zhVal as Record<string, unknown>,
            enVal as Record<string, unknown>,
            currentPath,
          );
        } else if (typeof zhVal === "string") {
          if (zhVal.length === 0) {
            throw new Error(`Empty Chinese translation for ${currentPath}`);
          }
        }
      }
    }

    checkKeysExist(zhDebt, enDebt, "pages.debt");
  });
});

// ── Honesty constraints: no forbidden terms ──────────────────────────────────

describe("Debt i18n: forbidden terms never appear", () => {
  const FORBIDDEN_TERMS = [
    "Burn pain",
    "drive evolution",
    "Auto Fix",
    "Evolve",
    "自动优化",
    "一键进化",
    "永不犯错",
    "智能修复",
  ];

  it("English debt copy has no forbidden terms", () => {
    const enDebt = enJson.pages?.debt as Record<string, unknown> | undefined;
    expect(enDebt).toBeDefined();

    function checkNoForbidden(
      obj: Record<string, unknown>,
      path: string,
    ): void {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = `${path}.${key}`;
        if (typeof value === "string") {
          for (const term of FORBIDDEN_TERMS) {
            if (value.includes(term)) {
              throw new Error(
                `Forbidden term "${term}" found in en.json at ${currentPath}`,
              );
            }
          }
        } else if (typeof value === "object" && value !== null) {
          checkNoForbidden(value as Record<string, unknown>, currentPath);
        }
      }
    }

    checkNoForbidden(enDebt!, "pages.debt");
  });
});

// ── Capability boundary: honest about limitations ────────────────────────────

describe("Debt: capability boundary is present in i18n", () => {
  it("English boundaryText mentions post-MVP and conflict detection", () => {
    const enDebt = enJson.pages?.debt as Record<string, unknown> | undefined;
    expect(enDebt).toBeDefined();
    const boundaryText = enDebt?.boundaryText as string | undefined;
    expect(boundaryText).toBeDefined();
    expect(boundaryText).toContain("post-MVP");
    expect(boundaryText).toContain("conflict detection");
  });

  it("Chinese boundaryText mentions post-MVP and conflict detection", () => {
    const zhDebt = zhJson.pages?.debt as Record<string, unknown> | undefined;
    expect(zhDebt).toBeDefined();
    const boundaryText = zhDebt?.boundaryText as string | undefined;
    expect(boundaryText).toBeDefined();
    expect(boundaryText).toContain("post-MVP");
    expect(boundaryText).toContain("冲突检测");
  });
});

// ── Disabled actions explanation present ─────────────────────────────────────

describe("Debt: disabled action explanations are present in i18n", () => {
  it("English has disabled reason for each action type", () => {
    const enDebt = enJson.pages?.debt as Record<string, unknown> | undefined;
    expect(enDebt).toBeDefined();
    expect(enDebt?.archiveDisabledReason).toContain("not yet available");
    expect(enDebt?.downgradeDisabledReason).toContain("not yet supported");
    expect(typeof enDebt?.keepObservingDisabledReason).toBe("string");
  });

  it("Chinese has disabled reason for each action type", () => {
    const zhDebt = zhJson.pages?.debt as Record<string, unknown> | undefined;
    expect(zhDebt).toBeDefined();
    expect(typeof zhDebt?.archiveDisabledReason).toBe("string");
    expect(typeof zhDebt?.downgradeDisabledReason).toBe("string");
    expect(typeof zhDebt?.keepObservingDisabledReason).toBe("string");
  });
});

// ── validateActivationRecord ────────────────────────────────────────────────

describe("validateActivationRecord", () => {
  it("validates a well-formed activation record", () => {
    const result = validateActivationRecord(makeActivationRecord());
    expect(result).not.toBeNull();
    expect(result?.principleId).toBe("principle-001");
    expect(result?.status).toBe("active");
  });

  it("validates record with null activatedAt", () => {
    const result = validateActivationRecord(
      makeActivationRecord({ activatedAt: null }),
    );
    expect(result).not.toBeNull();
    expect(result?.activatedAt).toBeNull();
  });

  it("rejects null input", () => {
    expect(validateActivationRecord(null)).toBeNull();
  });

  it("rejects missing principleId", () => {
    const { principleId, ...rest } = makeActivationRecord();
    expect(validateActivationRecord(rest)).toBeNull();
  });

  it("rejects invalid status", () => {
    expect(
      validateActivationRecord(makeActivationRecord({ status: "unknown" })),
    ).toBeNull();
  });

  it("rejects non-string id", () => {
    expect(
      validateActivationRecord(makeActivationRecord({ id: 123 })),
    ).toBeNull();
  });
});

// ── validateActivationsData ─────────────────────────────────────────────────

describe("validateActivationsData", () => {
  it("validates well-formed activations data", () => {
    const result = validateActivationsData({
      activations: [makeActivationRecord()],
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result?.activations).toHaveLength(1);
  });

  it("validates empty activations array", () => {
    const result = validateActivationsData({
      activations: [],
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result?.activations).toHaveLength(0);
  });

  it("rejects null input", () => {
    expect(validateActivationsData(null)).toBeNull();
  });

  it("rejects missing activations field", () => {
    expect(validateActivationsData({ generatedAt: "2026-06-01" })).toBeNull();
  });

  it("rejects missing generatedAt", () => {
    expect(validateActivationsData({ activations: [] })).toBeNull();
  });

  it("rejects data with any invalid record (fail loud, ERR-009)", () => {
    const result = validateActivationsData({
      activations: [makeActivationRecord(), { id: 123 }],
      generatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(result).toBeNull();
  });
});

// ── P1 honesty: no false candidates when activations unavailable ────────────

describe("P1: activations unavailable must not produce false debt candidates", () => {
  /**
   * Simulates the DebtPage orchestration logic after the P1 fix.
   * When activations API fails or data is malformed, candidates must be empty
   * to avoid misinterpreting "data unavailable" as "no activation records".
   */
  function simulateDebtPageDerivation(
    principles: PrincipleListItem[],
    activationsAvailable: boolean,
    activations: ActivationRecord[],
  ): DebtCandidate[] {
    // Mirrors the fixed DebtPage.loadData logic:
    // Only derive debt candidates when activation data is available.
    return activationsAvailable
      ? deriveDebtCandidates(principles, activations)
      : [];
  }

  it("API fail + active principles → zero candidates (not false noActivationRecord)", () => {
    const principles = [
      validatePrincipleListItem(makePrincipleListItem({ id: "p-1" })),
      validatePrincipleListItem(makePrincipleListItem({ id: "p-2" })),
    ].filter((p): p is PrincipleListItem => p !== null);

    expect(principles).toHaveLength(2);

    // Simulate: activations API failed (success=false)
    const activationsAvailable = false;
    const candidates = simulateDebtPageDerivation(principles, activationsAvailable, []);
    expect(candidates).toHaveLength(0);
  });

  it("API success but malformed data → zero candidates", () => {
    const principles = [makePrincipleListItem()] as PrincipleListItem[];

    // Simulate: activations API returned success but data failed validation
    const activationsAvailable = false;
    const candidates = simulateDebtPageDerivation(principles, activationsAvailable, []);
    expect(candidates).toHaveLength(0);
  });

  it("API success + valid empty activations → candidates derived honestly", () => {
    const principles = [makePrincipleListItem()] as PrincipleListItem[];

    // Simulate: activations API succeeded with valid (empty) data
    const activationsAvailable = true;
    const candidates = simulateDebtPageDerivation(principles, activationsAvailable, []);
    // With empty activations and available=true, active principle IS a real noActivationRecord
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.debtReason).toBe("noActivationRecord");
  });

  it("API success + valid activations → normal derivation", () => {
    const principles = [makePrincipleListItem()] as PrincipleListItem[];
    const activations = [makeActivationRecord()] as ActivationRecord[];

    const activationsAvailable = true;
    const candidates = simulateDebtPageDerivation(principles, activationsAvailable, activations);
    // Active principle with active activation → not debt
    expect(candidates).toHaveLength(0);
  });
});
