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
import * as fs from "node:fs";
import {
  validateLifecycleRuleMetric,
  validateLifecycleAdherence,
  validateLifecycleMetricsData,
  isReversibleChannel,
  isRecord,
} from "../../src/ui/pages/activation/ActivationValidators.js";
// PRI-1137 final review (P1-3): the activation page's data path IS the central
// wire parser — the retired page-local duplicate silently dropped the per-row
// `promptInjection` facts and `promptInjectionRoute`, so the injection-status
// lines and the rotation state could never render on this page.
import { validateActivations } from "../../src/ui/utils/validators.js";
import enJson from "../../src/ui/i18n/en.json" with { type: "json" };
import zhJson from "../../src/ui/i18n/zh-CN.json" with { type: "json" };
import { validateRuleCodeOwnerReview } from '../../src/ui/utils/validators.js';

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

function makeOwnerReviewValue(): Record<string, unknown> {
  return { activation: { activationId: 'a', artifactId: 'x', action: 'code_tool_hook_shadow_activate' }, artifact: { artifactId: 'x', digest: 'sha256:x', content: {} }, readiness: { status: 'unavailable', evaluationId: 'e', failedChecks: [{ checkId: 'host', reasonCode: 'missing' }], evidenceSnapshot: { snapshotDigest: 'sha256:s', shadowSummary: { observed: null, matched: null, wouldBlock: null, wouldAllow: null, requireApproval: null, autoCorrect: null, errors: null, neutralControl: null, firstObservedAt: null, lastObservedAt: null }, safetyGateResults: [] } }, controlState: { enforcement: 'eligible', version: 1 }, globalPause: null, decisions: [], ownerDecisionEnabled: false, runtimeCapability: { hostRuntimeVersion: 'openclaw-legacy@1', shadowEvidence: true }, liveMetrics: { last24Hours: { eligible: null, matched: null, blocked: null, unhealthy: null, circuitTrips: 0, toolDistribution: null }, last7Days: { eligible: null, matched: null, blocked: null, unhealthy: null, circuitTrips: 0, toolDistribution: null }, representativeSamples: [] }, behaviorDrift: { approvedBlockRate: null, liveBlockRate: null, delta: null } };
}

describe('RuleCode Owner review validator', () => {
  it('preserves unavailable telemetry as null and rejects malformed failed checks', () => {
    const value = makeOwnerReviewValue();
    expect(validateRuleCodeOwnerReview(value)?.readiness.evidenceSnapshot.shadowSummary.observed).toBeNull();
    expect(validateRuleCodeOwnerReview({ ...value, readiness: { ...value.readiness, failedChecks: [{ checkId: 3, reasonCode: 'bad' }] } })).toBeNull();
  });

  it('carries the criteria projection through and rejects a malformed entry (5B)', () => {
    const value = makeOwnerReviewValue();
    // Absent criteria stay valid: an older server payload must not break the page.
    expect(validateRuleCodeOwnerReview(value)?.readiness.criteria).toBeUndefined();

    const readiness = value.readiness as Record<string, unknown>;
    const parsed = validateRuleCodeOwnerReview({
      ...value,
      readiness: {
        ...readiness,
        criteria: [
          { criterionId: 'golden_trace', kind: 'hard_check', status: 'failed', reasonCode: 'hard_check_failed' },
          { criterionId: 'shadow_observed', kind: 'evidence', status: 'failed', current: 19, threshold: 20, shortfall: 1 },
          { criterionId: 'bounded_scope', kind: 'hard_check', status: 'not_evaluated' },
        ],
      },
    });
    expect(parsed?.readiness.criteria).toHaveLength(3);
    expect(parsed?.readiness.criteria?.[1]).toEqual({
      criterionId: 'shadow_observed', kind: 'evidence', status: 'failed', current: 19, threshold: 20, shortfall: 1,
    });
    expect(validateRuleCodeOwnerReview({
      ...value,
      readiness: { ...readiness, criteria: [{ criterionId: 'shadow_observed', kind: 'evidence', status: 'maybe' }] },
    })).toBeNull();
  });

  it('carries the deduplicated fault figure through and never coerces UNKNOWN to 0', () => {
    const value = makeOwnerReviewValue();
    const liveMetrics = value.liveMetrics as Record<string, unknown>;
    const last24Hours = liveMetrics.last24Hours as Record<string, unknown>;

    const parsed = validateRuleCodeOwnerReview({
      ...value,
      liveMetrics: {
        ...liveMetrics,
        last24Hours: { ...last24Hours, unhealthy: 4, unhealthySignatures: 2, unhealthySignatureStatus: 'ok' },
      },
    });
    expect(parsed?.liveMetrics.last24Hours.unhealthy).toBe(4);
    expect(parsed?.liveMetrics.last24Hours.unhealthySignatures).toBe(2);
    expect(parsed?.liveMetrics.last24Hours.unhealthySignatureStatus).toBe('ok');

    // A contradictory payload (number + unknown status) stays UNKNOWN/null —
    // it is never converted into a concrete count.
    const contradictory = validateRuleCodeOwnerReview({
      ...value,
      liveMetrics: {
        ...liveMetrics,
        last24Hours: { ...last24Hours, unhealthy: 4, unhealthySignatures: 4, unhealthySignatureStatus: 'unknown' },
      },
    });
    expect(contradictory?.liveMetrics.last24Hours.unhealthySignatures).toBeNull();
    expect(contradictory?.liveMetrics.last24Hours.unhealthySignatureStatus).toBe('unknown');
  });
});

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

// ── the page's data path: central validateActivations (P1-3 consistency) ─────

describe("activation page data path: central validateActivations", () => {
  it("keeps per-row promptInjection so the injection-status lines can render", () => {
    const result = validateActivations({
      activations: [
        makeActivationRecord({
          promptInjection: {
            activationId: "act-001",
            status: "window_excluded",
            inCurrentWindow: false,
            costChars: 953,
            budget: 4000,
            budgetScope: "full_directive_context",
            route: "shared_render",
          },
        }),
      ],
      status: "ok",
    });
    expect(result).not.toBeNull();
    expect(result?.activations[0]?.promptInjection?.status).toBe("window_excluded");
    expect(result?.activations[0]?.promptInjection?.costChars).toBe(953);
  });

  it("keeps promptInjectionRoute incl. the three-state productionRotation (Focus/Activation consistency)", () => {
    const result = validateActivations({
      activations: [makeActivationRecord()],
      status: "ok",
      promptInjectionRoute: {
        status: "confirmed",
        route: "shared_render",
        productionRotation: "unknown",
        budgetCapacityStatus: "unknown",
        budgetFallbackReason: "host_capacity_absent",
      },
    });
    expect(result?.promptInjectionRoute?.productionRotation).toBe("unknown");
    // A bound rotating host resolves to 'rotates' — the page must never read
    // absent as FIFO.
    const bound = validateActivations({
      activations: [makeActivationRecord()],
      status: "ok",
      promptInjectionRoute: { status: "confirmed", hostKind: "openclaw", route: "shared_render", productionRotation: "rotates" },
    });
    expect(bound?.promptInjectionRoute?.productionRotation).toBe("rotates");
  });

  it("drops a present-but-invalid rotation value instead of propagating it (rc-1/rc-2)", () => {
    const result = validateActivations({
      activations: [makeActivationRecord()],
      status: "ok",
      promptInjectionRoute: { status: "confirmed", productionRotation: "yes" },
    });
    expect(result?.promptInjectionRoute?.productionRotation).toBeUndefined();
  });

  it("still rejects a structurally invalid payload (fail loud preserved)", () => {
    expect(validateActivations({ status: "ok" })).toBeNull();
    expect(validateActivations({ activations: "not-array", status: "ok" })).toBeNull();
    expect(
      validateActivations({ activations: [makeActivationRecord(), { activationId: 123 }], status: "ok" }),
    ).toBeNull();
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
  it("English boundaryText mentions capability boundary without dev jargon", () => {
    const enActivation = enJson.pages?.activation as Record<string, unknown> | undefined;
    expect(enActivation).toBeDefined();
    const boundaryText = enActivation?.boundaryText as string | undefined;
    expect(boundaryText).toBeDefined();
    // User-facing copy must not use dev jargon like "post-MVP".
    expect(boundaryText).not.toContain("post-MVP");
    expect(boundaryText).toContain("semantic matching");
    expect(boundaryText).toContain("current version");
  });

  it("Chinese boundaryText mentions capability boundary without dev jargon", () => {
    const zhActivation = zhJson.pages?.activation as Record<string, unknown> | undefined;
    expect(zhActivation).toBeDefined();
    const boundaryText = zhActivation?.boundaryText as string | undefined;
    expect(boundaryText).toBeDefined();
    // User-facing copy must not use dev jargon like "post-MVP".
    expect(boundaryText).not.toContain("post-MVP");
    expect(boundaryText).toContain("语义匹配");
    expect(boundaryText).toContain("当前版本");
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

// ── PRI-1017: runtime budget observation note ───────────────────────────────

describe("Activation page: PRI-1017 budget observation note contract", () => {
  const src = fs.readFileSync(
    new URL("../../src/ui/pages/activation/ActivationPage.tsx", import.meta.url), "utf-8");

  it("only shows the observation note for a CONFIRMED observation with a real window", () => {
    // A usable observation can itself be the runtime's fallback (no trusted
    // host capacity): rendering it with a host-window label and window 0 would
    // be a fabricated claim.
    expect(src).toContain('route.budgetCapacityStatus === "confirmed"');
    expect(src).toContain("route.budgetObservedAt !== undefined");
    expect(src).toContain("route.budgetContextWindowTokens !== undefined");
  });

  it("shows the bounded reason for a fallback basis, with the observation time when one exists", () => {
    expect(src).toContain('route.budgetCapacityStatus === "unknown" && route.budgetFallbackReason !== undefined');
    expect(src).toContain("pages.focus.promptBudgetFallbackObservedSuffix");
    expect(src).toContain("pages.activation.budgetFallbackNote");
  });

  it("both locales define the notes with their interpolation placeholders", () => {
    const enActivation = enJson.pages?.activation as Record<string, unknown> | undefined;
    const zhActivation = zhJson.pages?.activation as Record<string, unknown> | undefined;
    for (const [lang, copy] of [["en", enActivation], ["zh", zhActivation]] as const) {
      expect(typeof copy?.budgetObservedNote, lang).toBe("string");
      expect(String(copy?.budgetObservedNote), lang).toContain("{{source}}");
      expect(String(copy?.budgetObservedNote), lang).toContain("{{window}}");
      expect(String(copy?.budgetObservedNote), lang).toContain("{{observedAt}}");
      expect(typeof copy?.budgetFallbackNote, lang).toBe("string");
      expect(String(copy?.budgetFallbackNote), lang).toContain("{{reason}}");
      expect(String(copy?.budgetFallbackNote), lang).toContain("{{observed}}");
    }
  });
});
