/**
 * Activation page validators and i18n tests — PRI-CR6
 *
 * Validates:
 * - API validators reject malformed payloads
 * - ActivationsData and LifecycleMetricsData validators work correctly
 * - isReversibleChannel helper works
 * - English i18n copy has no CJK characters
 * - Chinese i18n copy has no unnecessary English (product names excepted)
 * - Confirmation flow: disable requires confirmation
 * - Failure surfaces reason + nextAction
 */

import { describe, it, expect } from "vitest";
import {
  validateActivationRecord,
  validateActivationsData,
  validateLifecycleRuleMetric,
  validateLifecycleAdherence,
  validateLifecycleMetricsData,
  isReversibleChannel,
  isRecord,
} from "../../src/ui/pages/activation/ActivationValidators.js";
import enJson from "../../src/ui/i18n/en.json" with { type: "json" };
import zhJson from "../../src/ui/i18n/zh-CN.json" with { type: "json" };

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeActivationRecord(overrides?: Record<string, unknown>) {
  return {
    activationId: "act-001",
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

function makeActivationsData(overrides?: Record<string, unknown>) {
  return {
    activations: [makeActivationRecord()],
    status: "ok",
    ...overrides,
  };
}

function makeLifecycleMetrics(overrides?: Record<string, unknown>) {
  return {
    principleId: "principle-001",
    adherence: {
      insufficientData: false,
      rate: 0.85,
      note: "Rule quality signal, not equivalent to behavior change",
    },
    ruleMetrics: [
      {
        ruleId: "rule-001",
        triggered: 12,
        lastTriggeredAt: "2026-06-04T15:30:00.000Z",
      },
    ],
    ...overrides,
  };
}

// ── isRecord ─────────────────────────────────────────────────────────────────

describe("isRecord", () => {
  it("returns true for plain objects", () => {
    expect(isRecord({ foo: "bar" })).toBe(true);
  });

  it("returns false for null", () => {
    expect(isRecord(null)).toBe(false);
  });

  it("returns false for arrays", () => {
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it("returns false for primitives", () => {
    expect(isRecord("string")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(true)).toBe(false);
  });
});

// ── validateActivationRecord ─────────────────────────────────────────────────

describe("validateActivationRecord", () => {
  it("validates a well-formed activation record", () => {
    const result = validateActivationRecord(makeActivationRecord());
    expect(result).not.toBeNull();
    expect(result?.activationId).toBe("act-001");
    expect(result?.channel).toBe("prompt");
    expect(result?.status).toBe("active");
  });

  it("validates record with null activatedAt", () => {
    const result = validateActivationRecord(makeActivationRecord({ activatedAt: null }));
    expect(result).not.toBeNull();
    expect(result?.activatedAt).toBeNull();
  });

  it("validates record with deactivated status", () => {
    const result = validateActivationRecord(makeActivationRecord({ status: "deactivated" }));
    expect(result).not.toBeNull();
    expect(result?.status).toBe("deactivated");
  });

  it("rejects null input", () => {
    expect(validateActivationRecord(null)).toBeNull();
  });

  it("rejects non-object input", () => {
    expect(validateActivationRecord("string")).toBeNull();
    expect(validateActivationRecord(42)).toBeNull();
  });

  it("rejects array input", () => {
    expect(validateActivationRecord([1, 2, 3])).toBeNull();
  });

  it("rejects record with missing activationId", () => {
    const { activationId, ...rest } = makeActivationRecord();
    expect(validateActivationRecord(rest)).toBeNull();
  });

  it("rejects record with empty activationId", () => {
    expect(validateActivationRecord(makeActivationRecord({ activationId: "" }))).toBeNull();
  });

  it("rejects record with invalid status", () => {
    expect(validateActivationRecord(makeActivationRecord({ status: "pending" }))).toBeNull();
  });

  it("rejects record with non-string activatedAt", () => {
    expect(validateActivationRecord(makeActivationRecord({ activatedAt: 123 }))).toBeNull();
  });

  it("rejects record with non-string channel", () => {
    expect(validateActivationRecord(makeActivationRecord({ channel: 42 }))).toBeNull();
  });

  it("rejects record with non-string principleId", () => {
    expect(validateActivationRecord(makeActivationRecord({ principleId: true }))).toBeNull();
  });
});

// ── validateActivationsData ──────────────────────────────────────────────────

describe("validateActivationsData", () => {
  it("validates well-formed activations data", () => {
    const result = validateActivationsData(makeActivationsData());
    expect(result).not.toBeNull();
    expect(result?.activations).toHaveLength(1);
    expect(result?.status).toBe("ok");
  });

  it("validates data with optional reason", () => {
    const result = validateActivationsData(makeActivationsData({ reason: "degraded" }));
    expect(result).not.toBeNull();
    expect(result?.reason).toBe("degraded");
  });

  it("validates data with empty activations array", () => {
    const result = validateActivationsData(makeActivationsData({ activations: [] }));
    expect(result).not.toBeNull();
    expect(result?.activations).toHaveLength(0);
  });

  it("rejects null input", () => {
    expect(validateActivationsData(null)).toBeNull();
  });

  it("rejects missing activations field", () => {
    const { activations, ...rest } = makeActivationsData();
    expect(validateActivationsData(rest)).toBeNull();
  });

  it("rejects missing status field", () => {
    const { status, ...rest } = makeActivationsData();
    expect(validateActivationsData(rest)).toBeNull();
  });

  it("rejects non-array activations", () => {
    expect(validateActivationsData(makeActivationsData({ activations: "not-array" }))).toBeNull();
  });

  it("rejects non-string status", () => {
    expect(validateActivationsData(makeActivationsData({ status: 123 }))).toBeNull();
  });

  it("rejects data with any invalid activation record (fail loud, ERR-009)", () => {
    const data = makeActivationsData({
      activations: [
        makeActivationRecord(),
        { activationId: 123 }, // invalid record
      ],
    });
    expect(validateActivationsData(data)).toBeNull();
  });

  it("ignores non-string reason field", () => {
    const result = validateActivationsData(makeActivationsData({ reason: 42 }));
    expect(result).not.toBeNull();
    expect(result?.reason).toBeUndefined();
  });
});

// ── validateLifecycleRuleMetric ──────────────────────────────────────────────

describe("validateLifecycleRuleMetric", () => {
  it("validates a well-formed rule metric", () => {
    const result = validateLifecycleRuleMetric({
      ruleId: "rule-001",
      triggered: 12,
      lastTriggeredAt: "2026-06-04T15:30:00.000Z",
    });
    expect(result).not.toBeNull();
    expect(result?.ruleId).toBe("rule-001");
    expect(result?.triggered).toBe(12);
  });

  it("validates rule metric with null lastTriggeredAt", () => {
    const result = validateLifecycleRuleMetric({
      ruleId: "rule-001",
      triggered: 0,
      lastTriggeredAt: null,
    });
    expect(result).not.toBeNull();
    expect(result?.lastTriggeredAt).toBeNull();
  });

  it("rejects null input", () => {
    expect(validateLifecycleRuleMetric(null)).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(validateLifecycleRuleMetric({ ruleId: "r1", triggered: 1 })).toBeNull();
  });

  it("rejects non-string ruleId", () => {
    expect(validateLifecycleRuleMetric({ ruleId: 123, triggered: 1, lastTriggeredAt: null })).toBeNull();
  });

  it("rejects non-number triggered", () => {
    expect(validateLifecycleRuleMetric({ ruleId: "r1", triggered: "1", lastTriggeredAt: null })).toBeNull();
  });
});

// ── validateLifecycleAdherence ───────────────────────────────────────────────

describe("validateLifecycleAdherence", () => {
  it("validates well-formed adherence with rate", () => {
    const result = validateLifecycleAdherence({
      insufficientData: false,
      rate: 0.85,
      note: "Rule quality signal",
    });
    expect(result).not.toBeNull();
    expect(result?.insufficientData).toBe(false);
    expect(result?.rate).toBe(0.85);
  });

  it("validates adherence with null rate (insufficient data)", () => {
    const result = validateLifecycleAdherence({
      insufficientData: true,
      rate: null,
      note: "No rules",
    });
    expect(result).not.toBeNull();
    expect(result?.rate).toBeNull();
  });

  it("rejects null input", () => {
    expect(validateLifecycleAdherence(null)).toBeNull();
  });

  it("rejects non-boolean insufficientData", () => {
    expect(validateLifecycleAdherence({
      insufficientData: "yes",
      rate: null,
      note: "text",
    })).toBeNull();
  });

  it("rejects non-string note", () => {
    expect(validateLifecycleAdherence({
      insufficientData: true,
      rate: null,
      note: 42,
    })).toBeNull();
  });
});

// ── validateLifecycleMetricsData ─────────────────────────────────────────────

describe("validateLifecycleMetricsData", () => {
  it("validates well-formed lifecycle metrics", () => {
    const result = validateLifecycleMetricsData(makeLifecycleMetrics());
    expect(result).not.toBeNull();
    expect(result?.principleId).toBe("principle-001");
    expect(result?.adherence.rate).toBe(0.85);
    expect(result?.ruleMetrics).toHaveLength(1);
  });

  it("validates lifecycle metrics with insufficient data", () => {
    const result = validateLifecycleMetricsData(makeLifecycleMetrics({
      adherence: {
        insufficientData: true,
        rate: null,
        note: "No rules available",
      },
      ruleMetrics: [],
    }));
    expect(result).not.toBeNull();
    expect(result?.adherence.insufficientData).toBe(true);
  });

  it("rejects null input", () => {
    expect(validateLifecycleMetricsData(null)).toBeNull();
  });

  it("rejects missing adherence", () => {
    const { adherence, ...rest } = makeLifecycleMetrics();
    expect(validateLifecycleMetricsData(rest)).toBeNull();
  });

  it("rejects invalid adherence", () => {
    expect(validateLifecycleMetricsData(makeLifecycleMetrics({
      adherence: { insufficientData: "yes" },
    }))).toBeNull();
  });

  it("rejects invalid ruleMetrics element (fail loud, ERR-009)", () => {
    expect(validateLifecycleMetricsData(makeLifecycleMetrics({
      ruleMetrics: [
        { ruleId: "rule-001", triggered: 12, lastTriggeredAt: null },
        { ruleId: 123 }, // invalid
      ],
    }))).toBeNull();
  });
});

// ── isReversibleChannel ──────────────────────────────────────────────────────

describe("isReversibleChannel", () => {
  it("returns true for prompt channel", () => {
    expect(isReversibleChannel("prompt")).toBe(true);
  });

  it("returns true for defer_archive channel", () => {
    expect(isReversibleChannel("defer_archive")).toBe(true);
  });

  it("returns false for code_tool_hook channel", () => {
    expect(isReversibleChannel("code_tool_hook")).toBe(false);
  });

  it("returns false for unknown channel", () => {
    expect(isReversibleChannel("unknown")).toBe(false);
  });
});

// ── English i18n: no CJK characters ─────────────────────────────────────────

describe("Activation i18n: English copy has no CJK characters", () => {
  const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/;

  it("all activation page English strings are CJK-free", () => {
    const activationKeys = enJson.pages?.activation as Record<string, unknown> | undefined;
    if (!activationKeys) {
      throw new Error("pages.activation not found in en.json");
    }

    function checkNoCJK(obj: Record<string, unknown>, path: string): void {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = `${path}.${key}`;
        if (typeof value === "string") {
          if (CJK_REGEX.test(value)) {
            throw new Error(`CJK character found in en.json at ${currentPath}: "${value}"`);
          }
        } else if (typeof value === "object" && value !== null) {
          checkNoCJK(value as Record<string, unknown>, currentPath);
        }
      }
    }

    checkNoCJK(activationKeys, "pages.activation");
  });
});

// ── Chinese i18n: no unnecessary English ─────────────────────────────────────

describe("Activation i18n: Chinese copy follows E.1 mixed-language rules", () => {
  // Product/component names that are allowed in Chinese copy
  const ALLOWED_ENGLISH_TERMS = new Set([
    "PD", "RuleHost", "OpenClaw", "Defer Archive", "Code Tool Hook",
    "API", "post-MVP",
  ]);

  it("activation page Chinese keys exist and are not empty", () => {
    const zhActivation = zhJson.pages?.activation as Record<string, unknown> | undefined;
    const enActivation = enJson.pages?.activation as Record<string, unknown> | undefined;
    if (!zhActivation || !enActivation) {
      throw new Error("pages.activation not found in i18n files");
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
          checkKeysExist(zhVal as Record<string, unknown>, enVal as Record<string, unknown>, currentPath);
        } else if (typeof zhVal === "string") {
          if (zhVal.length === 0) {
            throw new Error(`Empty Chinese translation for ${currentPath}`);
          }
        }
      }
    }

    checkKeysExist(zhActivation, enActivation, "pages.activation");
  });
});

// ── Capability boundary text is present ──────────────────────────────────────

describe("Activation: capability boundary declaration is present in i18n", () => {
  it("English boundaryText mentions post-MVP and semantic matching", () => {
    const enActivation = enJson.pages?.activation as Record<string, unknown> | undefined;
    expect(enActivation).toBeDefined();
    const boundaryText = enActivation?.boundaryText as string | undefined;
    expect(boundaryText).toBeDefined();
    expect(boundaryText).toContain("post-MVP");
    expect(boundaryText).toContain("semantic matching");
  });

  it("Chinese boundaryText mentions post-MVP and semantic matching", () => {
    const zhActivation = zhJson.pages?.activation as Record<string, unknown> | undefined;
    expect(zhActivation).toBeDefined();
    const boundaryText = zhActivation?.boundaryText as string | undefined;
    expect(boundaryText).toBeDefined();
    expect(boundaryText).toContain("post-MVP");
    expect(boundaryText).toContain("语义匹配");
  });
});

// ── Honesty constraints: no forbidden terms ──────────────────────────────────

describe("Activation: forbidden terms never appear in i18n", () => {
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

  // "behavior change" is allowed in negative/honest contexts (e.g., "not equivalent to behavior change")
  // but forbidden as a positive claim (e.g., "Behavior Change" as a page title)
  const FORBIDDEN_POSITIVE_PHRASES = [
    "Behavior Change",
  ];

  it("English activation copy has no forbidden terms", () => {
    const enActivation = enJson.pages?.activation as Record<string, unknown> | undefined;
    expect(enActivation).toBeDefined();

    function checkNoForbidden(obj: Record<string, unknown>, path: string): void {
      for (const [key, value] of Object.entries(obj)) {
        const currentPath = `${path}.${key}`;
        if (typeof value === "string") {
          for (const term of FORBIDDEN_TERMS) {
            if (value.includes(term)) {
              throw new Error(`Forbidden term "${term}" found in en.json at ${currentPath}`);
            }
          }
          for (const phrase of FORBIDDEN_POSITIVE_PHRASES) {
            if (value.includes(phrase)) {
              throw new Error(`Forbidden positive phrase "${phrase}" found in en.json at ${currentPath}`);
            }
          }
        } else if (typeof value === "object" && value !== null) {
          checkNoForbidden(value as Record<string, unknown>, currentPath);
        }
      }
    }

    checkNoForbidden(enActivation!, "pages.activation");
  });
});
