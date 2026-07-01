/**
 * signal-keywords-api — runtime contract test
 *
 * 测试 validators 和 API stubs 的行为。
 * 纯逻辑（无 React/I/O），直接 import + assert。
 *
 * Verifies:
 * - validateUnifiedKeywordStore rejects bad shapes
 * - validateUnifiedKeywordStore parses valid data
 * - validatePendingTermStore rejects bad shapes
 * - validatePendingTermStore parses valid data
 * - API stubs return endpoint_not_implemented
 *
 * ERR entries:
 * - ERR-001: unknown 输入 -> runtime validation
 * - ERR-005: 数组元素校验
 * - ERR-007: 拒绝非数组
 * - ERR-009: 必填字段 loud fail
 */

import { describe, it, expect } from "vitest";
import {
  validateUnifiedKeywordStore,
  validatePendingTermStore,
} from "../../src/ui/utils/signal-keywords-validators.js";
import {
  fetchKeywordStore,
  fetchPendingTerms,
  updateKeywordStore,
  admitPendingTerm,
  rejectPendingTerm,
} from "../../src/ui/utils/signal-keywords-api.js";

// ── validateUnifiedKeywordStore ───────────────────────────────────────────────

describe("validateUnifiedKeywordStore", () => {
  it("rejects null / undefined / non-object", () => {
    expect(validateUnifiedKeywordStore(null)).toBeNull();
    expect(validateUnifiedKeywordStore(undefined)).toBeNull();
    expect(validateUnifiedKeywordStore("string")).toBeNull();
    expect(validateUnifiedKeywordStore(42)).toBeNull();
    expect(validateUnifiedKeywordStore([])).toBeNull();
  });

  it("rejects missing version or terms", () => {
    expect(validateUnifiedKeywordStore({})).toBeNull();
    expect(validateUnifiedKeywordStore({ version: 1 })).toBeNull();
    expect(validateUnifiedKeywordStore({ terms: {} })).toBeNull();
  });

  it("rejects non-number version", () => {
    expect(
      validateUnifiedKeywordStore({ version: "1", terms: {} }),
    ).toBeNull();
  });

  it("rejects non-object terms", () => {
    expect(
      validateUnifiedKeywordStore({ version: 1, terms: [] }),
    ).toBeNull();
  });

  it("rejects term with missing fields", () => {
    const raw = {
      version: 1,
      terms: {
        test: { term: "test" },
      },
    };
    expect(validateUnifiedKeywordStore(raw)).toBeNull();
  });

  it("rejects term with invalid category", () => {
    const raw = {
      version: 1,
      terms: {
        test: {
          term: "test",
          category: "invalid",
          weight: 0.5,
          precision: "high",
          source: "seed",
        },
      },
    };
    expect(validateUnifiedKeywordStore(raw)).toBeNull();
  });

  it("rejects term with out-of-range weight", () => {
    const raw = {
      version: 1,
      terms: {
        test: {
          term: "test",
          category: "correction",
          weight: 1.5,
          precision: "high",
          source: "seed",
        },
      },
    };
    expect(validateUnifiedKeywordStore(raw)).toBeNull();
  });

  it("parses valid keyword store", () => {
    const raw = {
      version: 1,
      terms: {
        "这是错的": {
          term: "这是错的",
          category: "correction",
          weight: 0.9,
          precision: "high",
          source: "seed",
        },
        "搞什么": {
          term: "搞什么",
          category: "empathy",
          weight: 0.5,
          precision: "ambiguous",
          source: "migrated",
        },
      },
    };
    const result = validateUnifiedKeywordStore(raw);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(Object.keys(result!.terms)).toHaveLength(2);
    expect(result!.terms["这是错的"].category).toBe("correction");
    expect(result!.terms["这是错的"].precision).toBe("high");
    expect(result!.terms["搞什么"].source).toBe("migrated");
  });

  it("accepts all three source values", () => {
    const raw = {
      version: 2,
      terms: {
        a: { term: "a", category: "correction", weight: 0.5, precision: "high", source: "seed" },
        b: { term: "b", category: "correction", weight: 0.5, precision: "high", source: "migrated" },
        c: { term: "c", category: "correction", weight: 0.5, precision: "high", source: "owner_promoted" },
      },
    };
    const result = validateUnifiedKeywordStore(raw);
    expect(result).not.toBeNull();
    expect(result!.terms.a.source).toBe("seed");
    expect(result!.terms.b.source).toBe("migrated");
    expect(result!.terms.c.source).toBe("owner_promoted");
  });
});

// ── validatePendingTermStore ───────────────────────────────────────────────────

describe("validatePendingTermStore", () => {
  it("rejects null / non-object", () => {
    expect(validatePendingTermStore(null)).toBeNull();
    expect(validatePendingTermStore("string")).toBeNull();
  });

  it("rejects missing version or terms", () => {
    expect(validatePendingTermStore({})).toBeNull();
    expect(validatePendingTermStore({ version: 1 })).toBeNull();
    expect(validatePendingTermStore({ terms: [] })).toBeNull();
  });

  it("rejects non-array terms", () => {
    expect(
      validatePendingTermStore({ version: 1, terms: {} }),
    ).toBeNull();
  });

  it("rejects term with missing fields", () => {
    const raw = {
      version: 1,
      terms: [{ term: "test" }],
    };
    expect(validatePendingTermStore(raw)).toBeNull();
  });

  it("rejects term with invalid suggestedCategory", () => {
    const raw = {
      version: 1,
      terms: [
        {
          term: "test",
          suggestedCategory: "invalid",
          suggestedPrecision: "high",
          reason: "because",
          discoveredAt: "2026-07-01T00:00:00Z",
        },
      ],
    };
    expect(validatePendingTermStore(raw)).toBeNull();
  });

  it("parses valid pending term store", () => {
    const raw = {
      version: 1,
      terms: [
        {
          term: "你又来了",
          suggestedCategory: "empathy",
          suggestedPrecision: "ambiguous",
          reason: "表达了对重复错误的挫败感",
          discoveredAt: "2026-07-01T10:30:00Z",
        },
      ],
    };
    const result = validatePendingTermStore(raw);
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.terms).toHaveLength(1);
    expect(result!.terms[0].term).toBe("你又来了");
    expect(result!.terms[0].suggestedCategory).toBe("empathy");
    expect(result!.terms[0].source).toBe("llm_candidate");
  });

  it("rejects empty term string", () => {
    const raw = {
      version: 1,
      terms: [
        {
          term: "",
          suggestedCategory: "correction",
          suggestedPrecision: "high",
          reason: "empty",
          discoveredAt: "2026-07-01T00:00:00Z",
        },
      ],
    };
    expect(validatePendingTermStore(raw)).toBeNull();
  });
});

// ── API stubs ─────────────────────────────────────────────────────────────────

describe("signal-keywords API stubs", () => {
  it("fetchKeywordStore returns endpoint_not_implemented", async () => {
    const result = await fetchKeywordStore("correction");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("endpoint_not_implemented");
    expect(typeof result.nextAction).toBe("string");
  });

  it("fetchPendingTerms returns endpoint_not_implemented", async () => {
    const result = await fetchPendingTerms();
    expect(result.success).toBe(false);
    expect(result.reason).toBe("endpoint_not_implemented");
  });

  it("updateKeywordStore returns endpoint_not_implemented", async () => {
    const result = await updateKeywordStore({ version: 1, terms: {} });
    expect(result.success).toBe(false);
    expect(result.reason).toBe("endpoint_not_implemented");
  });

  it("admitPendingTerm returns endpoint_not_implemented", async () => {
    const result = await admitPendingTerm({
      term: "test",
      category: "correction",
      precision: "high",
    });
    expect(result.success).toBe(false);
    expect(result.reason).toBe("endpoint_not_implemented");
  });

  it("rejectPendingTerm returns endpoint_not_implemented", async () => {
    const result = await rejectPendingTerm("test");
    expect(result.success).toBe(false);
    expect(result.reason).toBe("endpoint_not_implemented");
  });
});
